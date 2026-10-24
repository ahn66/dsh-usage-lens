/**
 * Self test for the optional remote price sync. No framework: run it with node.
 *
 *   node test/pricing-sync.test.mjs
 *
 * The point of these checks is the module's refusal behaviour as much as its
 * success path: a source that lies, breaks, or disappears must never turn into
 * a plausible-looking number (AGENTS.md convention 6).
 *
 * @module dsh-usage-lens/test/pricing-sync
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig, resolvePricingSync } from '../lib/config.js'
import { buildPricingTable, computeAmount, priceRecord, resolveRate } from '../lib/pricing.js'
import {
  aliasKeysFor,
  cachePathFor,
  fetchSources,
  fromLiteLLM,
  fromOpenRouter,
  normalizeModels,
  readCache,
  resolveRemotePricing,
  writeCache,
} from '../lib/pricing-sync.js'

let checks = 0
const failures = []

function check(label, actual, expected) {
  checks += 1
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) failures.push(`${label}\n  expected ${e}\n  actual   ${a}`)
}

function close(label, actual, expected, tolerance = 1e-9) {
  checks += 1
  if (typeof actual !== 'number' || Math.abs(actual - expected) > tolerance) {
    failures.push(`${label}\n  expected ${expected}\n  actual   ${actual}`)
  }
}

/** A fetch stub that answers with one canned payload, recording the call. */
function stubFetch(payload, { status = 200, fail = false } = {}) {
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    if (fail) throw new Error('network down')
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    }
  }
  return { impl, calls }
}

const openRouterPayload = {
  data: [
    {
      id: 'vendor/model-a',
      // USD per token: $2/M in, $10/M out, $0.2/M cache read.
      pricing: { prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000002' },
    },
    {
      id: 'vendor/model-peak',
      pricing: {
        prompt: '0.00000015',
        completion: '0.0000006',
        input_cache_read: '0.000000003',
        overrides: [
          { utc_days: ['monday'], utc_start: 100, utc_end: 400, prompt: '0.0000003', completion: '0.0000012', input_cache_read: '0.000000006' },
        ],
      },
    },
    { id: 'vendor/no-pricing' },
    { id: '', pricing: { prompt: '0.1', completion: '0.1' } },
    { id: 'vendor/free', pricing: { prompt: '0', completion: '0' } },
    { id: 'vendor/broken', pricing: { prompt: 'not-a-number', completion: null } },
  ],
}

// --- opt-in default ---------------------------------------------------------

check('sync is off with no pricing section', resolvePricingSync(undefined).enabled, false)
check('sync is off with an empty pricing section', resolvePricingSync({}).enabled, false)
check('sync stays off unless enabled is exactly true', resolvePricingSync({ sync: { enabled: 'yes' } }).enabled, false)
check('sync turns on when asked', resolvePricingSync({ sync: { enabled: true } }).enabled, true)
check('default source is openrouter', resolvePricingSync({ sync: { enabled: true } }).sourceIds, ['openrouter'])
check('refresh can be turned off for offline runs', resolvePricingSync({ sync: { refresh: false } }).refresh, false)
check('a bad usdToCny falls back to the stated default', resolvePricingSync({ sync: { usdToCny: -1 } }).usdToCny, 7.1)

const pluginConfig = resolveConfig({})
check('plugin config defers sync to opt-in', pluginConfig.pricingSync.enabled, false)

// --- wire validation --------------------------------------------------------

const bad = normalizeModels({
  good: { offPeak: { cacheHit: 1, cacheMiss: 2, output: 3 } },
  'also-good': { peak: { output: 5 } },
  negative: { offPeak: { cacheHit: -1, cacheMiss: -2, output: -3 } },
  infinite: { offPeak: { output: Number.POSITIVE_INFINITY } },
  text: { offPeak: { output: '3' } },
  empty: {},
  nullish: null,
})
check('only entries with usable rates survive', Object.keys(bad.models).sort(), ['also-good', 'good'])
check('rejected entries are counted, not hidden', bad.rejected, 5)
check('a negative rate is dropped rather than clamped', bad.models.negative, undefined)

// --- OpenRouter conversion --------------------------------------------------

const converted = fromOpenRouter(openRouterPayload.data, { usdToCny: 7 })
// OpenRouter quotes USD per single token; the plugin wants yuan per million.
const yuanPerMillion = (usdPerToken) => usdPerToken * 1e6 * 7
check('per-token USD becomes per-million CNY', converted.models['vendor/model-a'].offPeak, {
  cacheMiss: yuanPerMillion(0.000002),
  output: yuanPerMillion(0.00001),
  cacheHit: yuanPerMillion(0.0000002),
})
close('model-a input rate in yuan/million', converted.models['vendor/model-a'].offPeak.cacheMiss, 14)
close('model-a output rate in yuan/million', converted.models['vendor/model-a'].offPeak.output, 70)
close('model-a cache rate in yuan/million', converted.models['vendor/model-a'].offPeak.cacheHit, 1.4)

check('an entry with no pricing is rejected', converted.models['vendor/no-pricing'], undefined)
check('an entry with a blank id is rejected', converted.models[''], undefined)
check('a non-numeric rate is not coerced', converted.models['vendor/broken'], undefined)
close('a genuinely free model stays at zero', converted.models['vendor/free'].offPeak.cacheMiss, 0)
check('a model without a cache-read price mirrors the miss rate', converted.models['vendor/free'].offPeak.cacheHit, 0)

// Peak windows survive the conversion, which is what DeepSeek needs.
// The peak band must be the *dearer* weekday rate, not merely the first
// override: OpenRouter lists several bands that repeat the cheap rate, so a
// positional pick would install an off-peak number as the peak one.
// $0.3/M peak vs $0.15/M off-peak, converted at 7 yuan per dollar.
close('overrides become a distinct peak window', converted.models['vendor/model-peak'].peak.cacheMiss, 2.1)
close('off-peak stays the base rate', converted.models['vendor/model-peak'].offPeak.cacheMiss, 1.05)
check('the peak window is not the flat rate', converted.models['vendor/model-peak'].peak.cacheMiss !== converted.models['vendor/model-peak'].offPeak.cacheMiss, true)
check('accepted/rejected are reported', [converted.accepted, converted.rejected], [3, 3])

// --- fetch behaviour --------------------------------------------------------

{
  const { impl, calls } = stubFetch(openRouterPayload)
  const result = await fetchSources(['openrouter'], { fetchImpl: impl, usdToCny: 1 })
  check('fetch hits the source once', calls.length, 1)
  // Three usable models plus the bare-name aliases that make them findable.
  check('fetch reports per-source contribution including aliases', result.sources[0].source, 'openrouter')
  check('fetch contributes at least one key per usable model', result.sources[0].models >= 3, true)
  check('fetch surfaces no errors on success', result.errors, [])
}

{
  const result = await fetchSources(['openrouter'], { fetchImpl: stubFetch(null, { fail: true }).impl })
  check('a thrown fetch contributes nothing', Object.keys(result.models).length, 0)
  check('a thrown fetch is reported', result.errors[0].source, 'openrouter')
}

{
  const result = await fetchSources(['openrouter'], { fetchImpl: stubFetch(null, { status: 503 }).impl })
  check('a non-2xx response contributes nothing', Object.keys(result.models).length, 0)
  check('a non-2xx response names the status', result.errors[0].reason, 'HTTP 503')
}

{
  const result = await fetchSources(['nope'], { fetchImpl: stubFetch(openRouterPayload).impl })
  check('an unknown source id is refused', result.errors[0].reason, 'unknown source')
}

// --- alias widening ---------------------------------------------------------
//
// A remote catalogue names models its own way; the ledger records whatever id
// the provider route was configured with. Both spellings must reach the same
// rates, or a "successful" sync would still price nothing.

check('a vendor-prefixed id also answers to its bare tail', aliasKeysFor('deepseek/deepseek-v4.1-flash-1017').includes('deepseek-v4.1-flash-1017'), true)
check('a dated snapshot also answers to its family name', aliasKeysFor('deepseek/deepseek-v4.1-flash-1017').includes('deepseek-v4.1-flash'), true)
check('the original id is always kept', aliasKeysFor('deepseek/deepseek-v4.1-flash-1017').includes('deepseek/deepseek-v4.1-flash-1017'), true)
check('a service variant resolves to the model', aliasKeysFor('vendor/model:free').includes('model'), true)
check('a bare id with no vendor is left alone', aliasKeysFor('qwen3.8-flash'), ['qwen3.8-flash'])
check('a blank id yields nothing', aliasKeysFor(''), [])

{
  const widened = fromOpenRouter(openRouterPayload.data, { usdToCny: 1 })
  check('a synced entry is reachable under its bare name', widened.models['model-a'] !== undefined, true)
  close('the alias carries the same rate', widened.models['model-a'].offPeak.cacheMiss, widened.models['vendor/model-a'].offPeak.cacheMiss)
}
check('accepted/rejected count models, not aliases', converted.accepted, 3)

// A real DeepSeek-shaped band list: weekends cheap, weekday bands alternating.
// The peak must come out as the dear weekday rate, whatever order they arrive in.
{
  const banded = fromOpenRouter([{
    id: 'v/banded',
    pricing: {
      prompt: '0.00000015',
      completion: '0.0000006',
      input_cache_read: '0.000000003',
      overrides: [
        { utc_days: ['saturday', 'sunday'], prompt: '0.00000015', completion: '0.0000006' },
        { utc_days: ['monday'], utc_start: 0, utc_end: 100, prompt: '0.00000015', completion: '0.0000006' },
        { utc_days: ['monday'], utc_start: 100, utc_end: 400, prompt: '0.0000003', completion: '0.0000012' },
        { utc_days: ['monday'], utc_start: 400, utc_end: 600, prompt: '0.00000015', completion: '0.0000006' },
      ],
    },
  }], { usdToCny: 1 })
  close('the dear weekday band becomes peak', banded.models['v/banded'].peak.cacheMiss, 0.3)
  close('the weekend band does not become peak', banded.models['v/banded'].offPeak.cacheMiss, 0.15)
  check('a peak window exists at all', banded.models['v/banded'].peak !== undefined, true)
}
{
  // A model with no band that is dearer than base gets no peak window, so
  // computeAmount falls back to off-peak rather than inventing a difference.
  const flat = fromOpenRouter([{
    id: 'v/flat',
    pricing: { prompt: '0.000001', completion: '0.000002', overrides: [{ utc_days: ['monday'], prompt: '0.000001' }] },
  }], { usdToCny: 1 })
  check('a flat schedule gets no peak window', flat.models['v/flat'].peak, undefined)
  // `computeAmount` takes the model entry (`{peak, offPeak}`), not one window.
  close('its single rate prices both windows', computeAmount(flat.models['v/flat'], { outputTokens: 1_000_000 }, true), 2)
  close('and the off-peak window agrees', computeAmount(flat.models['v/flat'], { outputTokens: 1_000_000 }, false), 2)
}

// --- LiteLLM source ---------------------------------------------------------
//
// Its table lists one model under many resellers, each with its own rate. The
// bare name must be claimed by the provider that actually serves the model, or
// a reseller's promotional number would masquerade as the model's price.

const litellmTable = {
  sample_spec: { input_cost_per_token: 0, output_cost_per_token: 0, mode: 'chat' },
  'deepseek-chat': {
    mode: 'chat',
    litellm_provider: 'deepseek',
    input_cost_per_token: 2.8e-7,
    output_cost_per_token: 4.2e-7,
    cache_read_input_token_cost: 2.8e-8,
  },
  'coralbricks/deepseek-chat': {
    mode: 'chat',
    litellm_provider: 'coralbricks',
    // A hundredth of the official rate, as the real table has it.
    input_cost_per_token: 1e-8,
    output_cost_per_token: 1.2e-6,
  },
  'myprovider/deepseek-chat': {
    mode: 'chat',
    litellm_provider: 'myprovider',
    input_cost_per_token: 5e-7,
    output_cost_per_token: 9e-7,
  },
  'gpt-4o': {
    mode: 'chat',
    litellm_provider: 'openai',
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 1e-5,
  },
  'text-embedding-3-large': {
    mode: 'embedding',
    litellm_provider: 'openai',
    input_cost_per_token: 1.3e-7,
    output_cost_per_token: 0,
  },
  'imagen-3': {
    mode: 'image_generation',
    litellm_provider: 'google',
    output_cost_per_image: 0.04,
  },
  'broken/row': { mode: 'chat', litellm_provider: 'x' },
  'peak-model': {
    mode: 'chat',
    litellm_provider: 'deepseek',
    input_cost_per_token: 3e-7,
    output_cost_per_token: 1.2e-6,
    cache_read_input_token_cost: 6e-9,
    off_peak_pricing: {
      input_cost_per_token: 1.5e-7,
      output_cost_per_token: 6e-7,
      cache_read_input_token_cost: 3e-9,
    },
  },
}

{
  const llm = fromLiteLLM(litellmTable, { usdToCny: 1 })
  close('the official row keeps the bare name', llm.models['deepseek-chat'].offPeak.cacheMiss, 0.28)
  // Order must not decide the winner: a reseller listed *before* the official
  // row still must not keep the bare name.
  const reordered = fromLiteLLM({
    'coralbricks/deepseek-chat': litellmTable['coralbricks/deepseek-chat'],
    'deepseek-chat': litellmTable['deepseek-chat'],
  }, { usdToCny: 1 })
  close('listing order does not decide the bare name', reordered.models['deepseek-chat'].offPeak.cacheMiss, 0.28)
  check('the reseller is still reachable under its own id', llm.models['coralbricks/deepseek-chat'] !== undefined, true)
  close('and keeps its own rate', llm.models['coralbricks/deepseek-chat'].offPeak.cacheMiss, 0.01)
  close('cache hit is read from the LiteLLM field', llm.models['deepseek-chat'].offPeak.cacheHit, 0.028)

  check('a non-chat mode is skipped', llm.models['text-embedding-3-large'], undefined)
  check('an image mode is skipped', llm.models['imagen-3'], undefined)
  check('the sample_spec template is skipped', llm.models['sample_spec'], undefined)
  check('a row with no usable rate is rejected', llm.models['broken/row'], undefined)

  // off_peak_pricing holds the off-peak rate; the plain fields are the peak.
  close('off_peak_pricing becomes the off-peak rate', llm.models['peak-model'].offPeak.cacheMiss, 0.15)
  close('the plain fields become the peak rate', llm.models['peak-model'].peak.cacheMiss, 0.3)
  check('a peak window is installed', llm.models['peak-model'].peak !== undefined, true)
}

check('a non-object table yields nothing', Object.keys(fromLiteLLM(null).models).length, 0)
check('an array table yields nothing', Object.keys(fromLiteLLM([]).models).length, 0)

// --- cache round trip -------------------------------------------------------

const dir = await mkdtemp(join(tmpdir(), 'usage-lens-sync-'))
try {
  const cachePath = cachePathFor(dir)
  check('cache lives beside the ledger', cachePath, join(dir, 'pricing-cache.json'))
  check('a missing cache reads as absent', await readCache(cachePath), undefined)

  await writeCache(cachePath, { fetchedAt: 1000, version: 'v-test', models: { m: { offPeak: { output: 1 } } } })
  const cached = await readCache(cachePath)
  check('cache round trips', cached.version, 'v-test')
  close('cache keeps the rate', cached.models.m.offPeak.output, 1)

  await writeFile(cachePath, '{ not json', 'utf8')
  check('a corrupt cache reads as absent rather than throwing', await readCache(cachePath), undefined)
  await writeFile(cachePath, JSON.stringify({ models: { bad: { offPeak: { output: -5 } } } }), 'utf8')
  check('a cache with no usable entry reads as absent', await readCache(cachePath), undefined)

  // A fresh cache is served without touching the network.
  await writeCache(cachePath, { fetchedAt: Date.now(), version: 'fresh', models: { m: { offPeak: { output: 2 } } } })
  const { impl, calls } = stubFetch(openRouterPayload)
  const served = await resolveRemotePricing({ ledgerDir: dir, enabled: true, refresh: false, fetchImpl: impl })
  check('a fresh cache needs no fetch', calls.length, 0)
  check('a fresh cache is labelled as such', served.origin, 'cache')

  // A failed refresh must not erase a good cache.
  const stale = Date.now() - 30 * 24 * 60 * 60 * 1000
  await writeCache(cachePath, { fetchedAt: stale, version: 'old', models: { m: { offPeak: { output: 3 } } } })
  const failing = stubFetch(null, { fail: true })
  const kept = await resolveRemotePricing({ ledgerDir: dir, enabled: true, refresh: false, fetchImpl: failing.impl })
  check('a stale cache is still served', kept.origin, 'cache-stale')
  check('a stale cache is marked stale', kept.stale, true)
  const after = await readCache(cachePath)
  check('a failed refresh leaves the cache intact', after.version, 'old')

  // Disabled means no cache read and no fetch at all.
  const untouched = stubFetch(openRouterPayload)
  const off = await resolveRemotePricing({ ledgerDir: dir, enabled: false, fetchImpl: untouched.impl })
  check('disabled does no work', [off.origin, Object.keys(off.models).length, untouched.calls.length], ['disabled', 0, 0])
} finally {
  await rm(dir, { recursive: true, force: true })
}

// --- a synced table prices a real record ------------------------------------

{
  const synced = fromOpenRouter(openRouterPayload.data, { usdToCny: 1 })
  // Price through the plugin's own table builder by handing it the synced map.
  const built = buildPricingTable({
    version: 'synced-test',
    models: synced.models,
    mode: 'replace',
  })
  const rate = resolveRate(built, 'vendor/model-a', 'any')
  check('a synced model resolves', rate?.key, 'vendor/model-a')
  close('resolved input rate', rate.rates.offPeak.cacheMiss, 2)
  const amount = computeAmount(rate.rates, { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, false)
  close('one million input tokens at $2/M costs 2 yuan', amount, 2)
  const record = priceRecord(built, {
    model: 'vendor/model-a',
    provider: 'any',
    inputTokens: 1_000_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    timestamp: '2026-10-18T12:00:00+08:00',
  })
  check('the record prices as priced', record.priced, true)
  check('an unpriced model under a synced table stays unpriced', priceRecord(built, { model: 'nope', provider: 'any', timestamp: '2026-10-18T12:00:00+08:00' }).priced, false)
}

// --- report -----------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${checks} checks FAILED\n`)
  for (const failure of failures) console.error(`- ${failure}\n`)
  process.exit(1)
}
console.log(`all ${checks} checks passed`)