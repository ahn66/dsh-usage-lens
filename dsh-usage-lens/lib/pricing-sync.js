/**
 * Optional remote price-table synchronization.
 *
 * AGENTS.md says the plugin does not sync prices automatically. That default
 * still holds: nothing here runs unless the profile explicitly opts in with a
 * `pricing.sync` section. When it *is* enabled, this module fetches an external
 * price document, normalizes it into the plugin's own rate shape, caches it on
 * disk, and hands the result to `buildPricingTable` as an override layer.
 *
 * Design rules this module must never break:
 *
 * - **Never invent a number.** A source that is unreachable, malformed, or
 *   missing a model simply contributes nothing. An unpriced model stays
 *   unpriced, and the UI keeps showing `未定价` with a `≥` lower bound
 *   (AGENTS.md convention 6). Silence is correct; a guessed zero is not.
 * - **Never trust the wire.** Every field is re-validated here, and only
 *   non-negative finite rates survive. Remote data is input, not truth.
 * - **Never lose history.** The cache is a plain JSON file holding the last
 *   good payload plus its fetch instant, so a failed refresh degrades to the
 *   previous table instead of to an empty one. Amounts stay reconstructible.
 * - **Never block activation.** A sync failure is reported through `warn` and
 *   leaves the built-in snapshot in force.
 *
 * @module dsh-usage-lens/lib/pricing-sync
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** How long a single fetch may take before it is abandoned. */
export const DEFAULT_TIMEOUT_MS = 15000
/** Cache freshness window: one week, matching a weekly upstream refresh. */
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** OpenRouter's public model list; the only built-in source, and no key is needed. */
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models'

/**
 * LiteLLM's community-maintained price table.
 *
 * Served through the jsDelivr CDN, which mirrors a GitHub branch over a plain
 * HTTPS host. `raw.githubusercontent.com` and `api.github.com` resolve to
 * non-public addresses on some restricted networks, so neither is usable as the
 * only path; jsDelivr answers where they do not.
 */
export const LITELLM_URL = 'https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json'

const RATE_FIELDS = ['cacheHit', 'cacheMiss', 'output']

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Parse a numeric field that may arrive as a string, as OpenRouter sends them. */
function toNumber(value) {
  if (typeof value === 'number') return finiteNonNegative(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return finiteNonNegative(parsed)
  }
  return undefined
}

/**
 * Normalize one window of rates, dropping anything malformed.
 * @param raw - candidate `{ cacheHit, cacheMiss, output }` object.
 * @returns a clean window, or undefined when no usable rate survived.
 */
function normalizeWindow(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const window = {}
  for (const field of RATE_FIELDS) {
    const value = finiteNonNegative(raw[field])
    if (value !== undefined) window[field] = value
  }
  return Object.keys(window).length === 0 ? undefined : window
}

/**
 * Aliases that widen one remote entry to the names a ledger actually records.
 *
 * A remote catalogue names models by its own convention — OpenRouter writes
 * `deepseek/deepseek-v4.1-flash-1017` — while the ledger records whatever id
 * the provider route was configured with, often a bare `deepseek-v4.1-flash`.
 * Neither is wrong, so the sync emits **both** and lets the plugin's existing
 * exact → `provider/model` → longest-prefix lookup find one of them.
 *
 * Without this the sync would look successful (hundreds of models accepted) and
 * still price nothing, because every lookup would miss. Rule: widen aliases,
 * never invent rates — each alias points at the same real numbers.
 * @param remoteId - the source's own model id.
 * @returns every key worth registering for that entry.
 */
export function aliasKeysFor(remoteId) {
  const id = typeof remoteId === 'string' ? remoteId.trim() : ''
  if (id === '') return []

  const keys = new Set([id])
  const slash = id.indexOf('/')
  if (slash > 0 && slash < id.length - 1) {
    const vendor = id.slice(0, slash)
    const tail = id.slice(slash + 1)
    keys.add(tail)
    // A dated snapshot usually also answers to its undated family name:
    // `deepseek-v4.1-flash-1017` → `deepseek-v4.1-flash`.
    const undated = tail.replace(/[-_.]?\d{4,8}$/u, '').replace(/[-_]v?\d+$/u, '')
    if (undated !== '' && undated !== tail && undated.length >= 3) keys.add(undated)
    // Vendor-qualified spellings the ledger may hold as `provider/model`.
    keys.add(`${vendor}/${tail}`)
  }
  // `:free` / `:batch` / `:extended` suffixes are service variants, not models.
  const bare = id.split(':')[0]
  if (bare !== id && bare !== '') {
    for (const key of aliasKeysFor(bare)) keys.add(key)
  }
  return [...keys]
}

/**
 * Normalize one model entry. `peak` is optional: a source with a single flat
 * rate yields an off-peak window only, and `computeAmount` falls back to it.
 * @param raw - candidate entry.
 * @returns a clean entry, or undefined when unusable.
 */
function normalizeEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const offPeak = normalizeWindow(raw.offPeak)
  const peak = normalizeWindow(raw.peak)
  if (offPeak === undefined && peak === undefined) return undefined
  const entry = {}
  if (offPeak !== undefined) entry.offPeak = offPeak
  if (peak !== undefined) entry.peak = peak
  return entry
}

/**
 * Validate a whole `models` map, keeping only entries that carry real rates.
 * @param raw - candidate models map.
 * @returns `{ models, accepted, rejected }`.
 */
export function normalizeModels(raw) {
  const models = {}
  let accepted = 0
  let rejected = 0
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { models, accepted, rejected }
  }
  for (const [key, value] of Object.entries(raw)) {
    const name = typeof key === 'string' ? key.trim() : ''
    if (name === '') { rejected += 1; continue }
    const entry = normalizeEntry(value)
    if (entry === undefined) { rejected += 1; continue }
    models[name] = entry
    accepted += 1
  }
  return { models, accepted, rejected }
}

/**
 * Convert OpenRouter's per-token pricing into the plugin's yuan-per-million
 * shape.
 *
 * OpenRouter quotes US dollars per single token, so every rate is multiplied by
 * 1e6 for the million-token unit and by `usdToCny` for the plugin's CNY ledger.
 * Its `overrides` array already encodes DeepSeek's peak schedule in UTC, which
 * is why a model carrying overrides keeps a distinct `peak` window.
 * @param models - OpenRouter `data` array.
 * @param options - `{ usdToCny }`.
 * @returns `{ models, accepted, rejected }` in the plugin's rate shape.
 */
export function fromOpenRouter(models, { usdToCny = 1 } = {}) {
  const out = {}
  let accepted = 0
  let rejected = 0
  const scale = 1e6 * (finiteNonNegative(usdToCny) ?? 1)
  const perMillion = (value) => {
    const n = toNumber(value)
    return n === undefined ? undefined : n * scale
  }

  if (!Array.isArray(models)) return { models: out, accepted, rejected }

  for (const item of models) {
    const id = typeof item?.id === 'string' ? item.id.trim() : ''
    if (id === '') { rejected += 1; continue }
    const pricing = item?.pricing
    if (pricing === null || typeof pricing !== 'object') { rejected += 1; continue }

    const offPeak = {}
    const miss = perMillion(pricing.prompt)
    const outRate = perMillion(pricing.completion)
    const hit = perMillion(pricing.input_cache_read)
    if (miss !== undefined) offPeak.cacheMiss = miss
    if (outRate !== undefined) offPeak.output = outRate
    // A model with no cache-read price bills cached input at the miss rate, so
    // mirroring miss keeps the amount honest instead of dropping the bucket.
    if (hit !== undefined) offPeak.cacheHit = hit
    else if (miss !== undefined) offPeak.cacheHit = miss

    if (Object.keys(offPeak).length === 0) { rejected += 1; continue }

    const entry = { offPeak }

    // A peak window is the weekday rate that actually costs more, not simply
    // the first override listed. OpenRouter emits one override per time band,
    // including several that repeat the cheap rate, so picking by position
    // would silently install an off-peak rate as the peak one.
    //
    // `utc_start`/`utc_end` are hundredths of an hour (0..1000, `0` as an end
    // means midnight), and `utc_days` names the weekday band. DeepSeek's
    // schedule decodes to exactly the plugin's own Beijing peak windows, which
    // is the cross-check that keeps this honest.
    const overrides = Array.isArray(pricing.overrides) ? pricing.overrides : []
    let peak
    let peakMiss
    for (const candidate of overrides) {
      const days = Array.isArray(candidate?.utc_days) ? candidate.utc_days.map(String) : []
      // A weekday-only band describes peak; a weekend band never does.
      const weekdayBand = days.length === 0
        ? true
        : days.every((day) => !/^(saturday|sunday|sat|sun)$/i.test(day))
      if (!weekdayBand) continue
      const miss = perMillion(candidate.prompt)
      if (miss === undefined) continue
      // Strictly dearer than the base rate: that is what makes it a peak.
      if (peakMiss === undefined || miss > peakMiss) {
        const window = {}
        if (miss !== undefined) window.cacheMiss = miss
        const outRate = perMillion(candidate.completion)
        if (outRate !== undefined) window.output = outRate
        const hit = perMillion(candidate.input_cache_read)
        if (hit !== undefined) window.cacheHit = hit
        else window.cacheHit = miss
        peak = window
        peakMiss = miss
      }
    }
    if (peak !== undefined && peakMiss !== undefined && peakMiss > (offPeak.cacheMiss ?? 0)) {
      entry.peak = peak
    }

    out[id] = entry
    // Register the alias spellings too, so a ledger row recorded under a bare
    // model id still finds these rates.
    for (const alias of aliasKeysFor(id)) {
      if (alias === id) continue
      if (out[alias] === undefined) out[alias] = entry
    }
    accepted += 1
  }
  return { models: out, accepted, rejected }
}

/**
 * Convert LiteLLM's price table into the plugin's rate shape.
 *
 * Differences from OpenRouter that this has to absorb:
 *
 * - Its keys carry no vendor prefix requirement (`gpt-4o`, `deepseek-chat`), and
 *   the same model appears once per provider under different names, so every key
 *   is registered through the same alias widening.
 * - `mode` marks what a row prices. Only `chat` rows are token-priced the way
 *   the ledger counts; embedding, image, and audio rows are skipped rather than
 *   guessed at.
 * - The leading `sample_spec` row is documentation, not a model.
 * - Cache reads appear under `cache_read_input_token_cost`; a few older rows use
 *   `input_cost_per_token_cache_hit`. Both are read, because missing the second
 *   one would silently drop DeepSeek's cache price.
 * - `off_peak_pricing` carries the peak schedule where a provider has one. Its
 *   `input_cost_per_token`/`output_cost_per_token` describe the *off-peak* rate
 *   in LiteLLM's own accounting, so it is used as the base and the row's plain
 *   fields are treated as the peak when they are dearer.
 * @param table - the parsed LiteLLM JSON object.
 * @param options - `{ usdToCny }`.
 * @returns `{ models, accepted, rejected }` in the plugin's rate shape.
 */
export function fromLiteLLM(table, { usdToCny = 1 } = {}) {
  const out = {}
  let accepted = 0
  let rejected = 0
  const scale = 1e6 * (finiteNonNegative(usdToCny) ?? 1)
  const perMillion = (value) => {
    const n = toNumber(value)
    return n === undefined ? undefined : n * scale
  }

  if (table === null || typeof table !== 'object' || Array.isArray(table)) {
    return { models: out, accepted, rejected }
  }

  // One model reaches this table under many resellers, each with its own
  // price — `coralbricks/deepseek-v4.1-flash` at one-hundredth of the official
  // rate sits beside DeepSeek's own row. Registering the bare name from
  // whichever row is visited last would let a reseller's promotional number
  // masquerade as the model's price, which is exactly the kind of confident
  // wrongness this plugin refuses everywhere else.
  //
  // So a first-party row wins its bare name outright, and a reseller may only
  // claim a bare name no first-party row has spoken for. Ranking is by the
  // provider that actually serves the model, not by price: a cheaper reseller
  // is a different product, not a better answer to "what does this model cost".
  const FIRST_PARTY = new Set([
    'deepseek', 'openai', 'anthropic', 'google', 'gemini', 'vertex_ai',
    'mistral', 'cohere', 'meta', 'xai', 'x-ai', 'qwen', 'dashscope',
    'alibaba', 'zhipu', 'moonshot', 'minimax', 'baidu', 'tencent', 'bytedance',
    'amazon', 'azure', 'azure_ai', 'bedrock', 'bedrock_converse', 'groq',
    'together_ai', 'fireworks_ai', 'deepinfra', 'perplexity', 'nvidia',
  ])
  const rankOf = (row) => {
    const provider = typeof row?.litellm_provider === 'string' ? row.litellm_provider.toLowerCase() : ''
    if (provider === '') return 1
    // `vertex_ai-deepseek_models` still names a first-party deployment.
    const head = provider.split(/[-_]/u)[0]
    return FIRST_PARTY.has(provider) || FIRST_PARTY.has(head) ? 2 : 0
  }

  /** Bare-name owner and its rank, so a stronger row can take the name later. */
  const bareOwner = new Map()
  /** Rows that lost the bare name still get provider-qualified keys. */
  const pending = []

  for (const [key, row] of Object.entries(table)) {
    const id = typeof key === 'string' ? key.trim() : ''
    if (id === '' || id === 'sample_spec') { rejected += 1; continue }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) { rejected += 1; continue }
    // Only chat rows are billed the way the ledger counts tokens.
    if (typeof row.mode === 'string' && row.mode !== 'chat') { rejected += 1; continue }

    const offPeakRow = row.off_peak_pricing !== null && typeof row.off_peak_pricing === 'object'
      ? row.off_peak_pricing
      : undefined

    const baseMiss = perMillion(offPeakRow?.input_cost_per_token ?? row.input_cost_per_token)
    const baseOut = perMillion(offPeakRow?.output_cost_per_token ?? row.output_cost_per_token)
    if (baseMiss === undefined || baseOut === undefined) { rejected += 1; continue }

    const baseHit = perMillion(
      offPeakRow?.cache_read_input_token_cost
      ?? row.cache_read_input_token_cost
      ?? row.input_cost_per_token_cache_hit,
    )

    const entry = { offPeak: { cacheMiss: baseMiss, output: baseOut, cacheHit: baseHit ?? baseMiss } }
    if (offPeakRow !== undefined) {
      const peakMiss = perMillion(row.input_cost_per_token)
      const peakOut = perMillion(row.output_cost_per_token)
      if (peakMiss !== undefined && peakMiss > baseMiss) {
        const peakHit = perMillion(row.cache_read_input_token_cost ?? row.input_cost_per_token_cache_hit)
        entry.peak = { cacheMiss: peakMiss, output: peakOut ?? baseOut, cacheHit: peakHit ?? peakMiss }
      }
    }

    const rank = rankOf(row)
    const slash = id.indexOf('/')
    const bare = slash > 0 ? id.slice(slash + 1) : id

    // The full id always belongs to its own row.
    out[id] = entry

    const owner = bareOwner.get(bare)
    if (owner === undefined || rank > owner) {
      bareOwner.set(bare, rank)
      out[bare] = entry
      // Re-register the family aliases against the row that now owns the name.
      for (const alias of aliasKeysFor(bare)) {
        if (alias === bare) continue
        out[alias] = entry
      }
    }
    pending.push({ id, entry, rank, bare })
    accepted += 1
  }

  // Provider-qualified spellings, added only where nothing stronger claimed
  // them, so a reseller stays reachable under its own name and never under a
  // first-party model's.
  for (const { id, entry, rank } of pending) {
    for (const alias of aliasKeysFor(id)) {
      if (alias === id) continue
      if (out[alias] === undefined || rank >= (bareOwner.get(alias) ?? -1)) {
        if (out[alias] === undefined) out[alias] = entry
      }
    }
  }

  return { models: out, accepted, rejected }
}

/** Default graph: the public sources, keyed by their ID. */
export const DEFAULT_SOURCES = {
  openrouter: {
    url: OPENROUTER_URL,
    /** How to read that source's payload. */
    parse: (payload, options) => fromOpenRouter(payload?.data, options),
  },
  litellm: {
    url: LITELLM_URL,
    parse: (payload, options) => fromLiteLLM(payload, options),
  },
}

/**
 * Fetch and normalize every configured source.
 *
 * Sources are independent: one failing contributes nothing while the rest still
 * land. The returned `errors` list is what the caller reports, because a silent
 * partial sync would be exactly the kind of quiet mis-reporting the plugin
 * refuses elsewhere.
 * @param sourceIds - source IDs to fetch, in order.
 * @param options - `{ sources, usdToCny, timeoutMs, fetchImpl, warn }`.
 * @returns `{ models, accepted, rejected, sources, errors }`.
 */
export async function fetchSources(sourceIds, {
  sources = DEFAULT_SOURCES,
  usdToCny = 1,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl,
  warn = () => {},
} = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch
  const models = {}
  const errors = []
  const succeeded = []
  let accepted = 0
  let rejected = 0

  for (const id of sourceIds) {
    const source = sources[id]
    if (source === undefined) {
      errors.push({ source: id, reason: 'unknown source' })
      continue
    }
    try {
      const response = await doFetch(source.url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        errors.push({ source: id, reason: `HTTP ${response.status}` })
        continue
      }
      const payload = await response.json()
      const parsed = source.parse(payload, { usdToCny })
      let contributed = 0
      for (const [name, entry] of Object.entries(parsed.models)) {
        // Later sources win, so a local or more specific source can be appended
        // after a broad one and take precedence.
        models[name] = entry
        contributed += 1
      }
      accepted += parsed.accepted
      rejected += parsed.rejected
      succeeded.push({ source: id, models: contributed })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      errors.push({ source: id, reason })
      warn(`pricing sync: ${id} failed: ${reason}`)
    }
  }

  return { models, accepted, rejected, sources: succeeded, errors }
}

/** Where the cache lives relative to the ledger directory. */
export function cachePathFor(ledgerDir) {
  return join(ledgerDir, 'pricing-cache.json')
}

/**
 * Read the cached table.
 * @param path - cache file path.
 * @returns the parsed cache, or undefined when absent or unreadable.
 */
export async function readCache(path) {
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return undefined
    const { models } = normalizeModels(parsed.models)
    if (Object.keys(models).length === 0) return undefined
    return {
      fetchedAt: typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0,
      version: typeof parsed.version === 'string' ? parsed.version : '',
      models,
    }
  } catch {
    return undefined
  }
}

/**
 * Write the cache atomically, so a crash mid-write cannot truncate it.
 * @param path - cache file path.
 * @param value - `{ fetchedAt, version, models }`.
 */
export async function writeCache(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
  await rename(temporary, path)
}

/**
 * Resolve the remote price layer for one activation.
 *
 * The cache is consulted first: a fresh one is used as-is, and a stale one is
 * used immediately while a refresh runs in the background, so activation never
 * waits on the network. With no usable cache, the first fetch is awaited
 * because there is nothing to fall back to.
 * @param options - `{ ledgerDir, enabled, refresh, maxAgeMs, sourceIds, usdToCny, fetchImpl, warn }`.
 * @returns `{ models, origin, version, fetchedAt, stale, errors }`.
 */
export async function resolveRemotePricing({
  ledgerDir,
  enabled = false,
  refresh = true,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  sourceIds = ['openrouter'],
  usdToCny = 1,
  fetchImpl,
  warn = () => {},
} = {}) {
  if (!enabled) return { models: {}, origin: 'disabled', version: '', fetchedAt: 0, stale: false, errors: [] }

  const cachePath = cachePathFor(ledgerDir)
  const cached = await readCache(cachePath)
  const now = Date.now()
  const fresh = cached !== undefined && now - cached.fetchedAt < maxAgeMs

  if (fresh && !refresh) {
    return {
      models: cached.models,
      origin: 'cache',
      version: cached.version,
      fetchedAt: cached.fetchedAt,
      stale: false,
      errors: [],
    }
  }

  const refreshNow = async () => {
    const result = await fetchSources(sourceIds, { usdToCny, fetchImpl, warn })
    if (Object.keys(result.models).length === 0) {
      // A failed refresh must not overwrite a good cache with nothing.
      return { ...result, cached: true }
    }
    const version = `synced-${new Date(now).toISOString().slice(0, 10)}`
    try {
      await writeCache(cachePath, { fetchedAt: now, version, models: result.models })
    } catch (error) {
      warn(`pricing sync: cache write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { ...result, cached: false, version }
  }

  if (cached !== undefined) {
    // Serve the cache, refresh in the background, and report the stale instant
    // so the UI label can say which day the numbers came from.
    const pending = refresh ? refreshNow() : Promise.resolve(undefined)
    void pending.catch(() => {})
    return {
      models: cached.models,
      origin: fresh ? 'cache' : 'cache-stale',
      version: cached.version,
      fetchedAt: cached.fetchedAt,
      stale: !fresh,
      errors: [],
    }
  }

  const result = await refreshNow()
  return {
    models: result.models,
    origin: result.cached ? 'builtin-fallback' : 'remote',
    version: result.version ?? '',
    fetchedAt: result.cached ? 0 : now,
    stale: false,
    errors: result.errors,
  }
}