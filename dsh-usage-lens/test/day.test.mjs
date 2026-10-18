/**
 * Slice-4 Host suite: the day fold, the price-table override, and ledger
 * rotation.
 *
 * It exercises the parts a person can see go wrong: an hour bucket that lands on
 * the wrong side of midnight, an override that silently reprices the ledger,
 * an unpriced model that disappears into a zero, and a rotation that loses
 * history.
 *
 *   node test/day.test.mjs
 *
 * @module dsh-usage-lens/test/day
 */

import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { aggregateDay, aggregateRecords } from '../lib/day.js'
import { createLedger } from '../lib/ledger.js'
import { buildPricingTable, priceRecord, pricingLabel, resolveRate } from '../lib/pricing.js'
import { buildSessionDocument } from '../lib/session-route.js'

let checks = 0
const failures = []

function check(label, actual, expected) {
  checks += 1
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) failures.push(`${label}\n  expected ${e}\n  actual   ${a}`)
}

function close(label, actual, expected, tolerance = 1e-12) {
  checks += 1
  if (typeof actual !== 'number' || Math.abs(actual - expected) > tolerance) {
    failures.push(`${label}\n  expected ${expected}\n  actual   ${actual}`)
  }
}

const record = (overrides) => ({
  sessionId: 'session-day',
  turn: 1,
  step: 1,
  model: 'deepseek-flash',
  provider: 'deepseek-account',
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  timestamp: '2026-10-19T09:30:00+08:00',
  durationMs: 1000,
  status: 'completed',
  ...overrides,
})

// --- price-table override --------------------------------------------------

const builtin = buildPricingTable()
check('an untouched snapshot is labelled builtin', pricingLabel(builtin), {
  mode: 'builtin', version: builtin.version, customized: false,
})

// Acceptance 2's override: deepseek-v4-pro peak.output becomes a test value.
const overridden = buildPricingTable({ models: { 'deepseek-v4-pro': { peak: { output: 99 } } } })
check('an override without a version is labelled custom', pricingLabel(overridden).mode, 'custom')
check('an override keeps the builtin snapshot version string', pricingLabel(overridden).version, builtin.version)
check('the overridden peak output is in force', overridden.models['deepseek-v4-pro'].peak.output, 99)
check('the untouched peak output of the other window survives', overridden.models['deepseek-v4-pro'].offPeak.output, 13.5)
check('the untouched cache rates survive', overridden.models['deepseek-v4-pro'].peak.cacheMiss, 9.0)
check('the other model is untouched', overridden.models['deepseek-flash'].peak.output, 8.0)

const peakPro = record({
  model: 'deepseek-v4-pro',
  timestamp: '2026-10-19T10:00:00+08:00', // Monday 10:00 Beijing = peak
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
})
close('the override changes the rendered peak amount', priceRecord(overridden, peakPro).amount, 9 + 99, 1e-9)
close('the builtin table prices the same call differently', priceRecord(builtin, peakPro).amount, 9 + 27, 1e-9)
check(
  'the same tokens reprice under the override — the ledger is untouched',
  [peakPro.inputTokens, peakPro.outputTokens],
  [1_000_000, 1_000_000],
)

const versioned = buildPricingTable({ version: 'team-2026-11', models: { 'deepseek-flash': { peak: { output: 1 } } } })
check('a declared version wins the label', pricingLabel(versioned), {
  mode: 'override', version: 'team-2026-11', customized: true,
})

const replaced = buildPricingTable({ mode: 'replace', models: { 'acme/one': { offPeak: { cacheHit: 0.1, cacheMiss: 2, output: 3 } } } })
check('replace mode drops the builtin entries', resolveRate(replaced, 'deepseek-flash', 'deepseek-account'), undefined)
check('replace mode keeps the supplied entry', resolveRate(replaced, 'one', 'acme')?.key, 'acme/one')
check('replace mode is a customization', pricingLabel(replaced).mode, 'custom')

check('lookup still prefers the exact model', resolveRate(builtin, 'deepseek-flash', 'deepseek-account')?.key, 'deepseek-flash')

{
  // Removing a model changes what is priced, so the label must stop claiming
  // the snapshot too.
  const removed = buildPricingTable({ models: { 'deepseek-v4-pro': null } })
  check('removing a model makes the table custom', pricingLabel(removed).mode, 'custom')
  check('the removed model is unpriced', resolveRate(removed, 'deepseek-v4-pro', 'deepseek-account'), undefined)
  check('the other models survive the removal', resolveRate(removed, 'deepseek-flash', 'deepseek-account')?.key, 'deepseek-flash')
}

// --- the day fold ---------------------------------------------------------

const daylight = [
  record({ timestamp: '2026-10-19T09:10:00+08:00', inputTokens: 100, cacheReadTokens: 900, outputTokens: 50 }),
  record({ timestamp: '2026-10-19T09:50:00+08:00', inputTokens: 0, cacheReadTokens: 1000, outputTokens: 30 }),
  record({ timestamp: '2026-10-19T14:05:00+08:00', inputTokens: 400, cacheReadTokens: 0, outputTokens: 20, model: 'deepseek-v4-pro' }),
]
const day = aggregateDay({
  records: daylight,
  pricing: builtin,
  timeZone: 'Asia/Shanghai',
  now: Date.parse('2026-10-19T15:00:00+08:00'),
})
check('the day key follows Beijing', day.date, '2026-10-19')
check('every call is counted', [day.calls, day.statuses.completed], [3, 3])
check('token buckets are disjoint', [day.tokens.input, day.tokens.cacheRead, day.tokens.output], [500, 1900, 100])
check('total = billable input + output', day.tokens.total, 500 + 1900 + 100)
check('24 hour buckets are always present', day.hours.length, 24)
check('calls land in their Beijing hour', [day.hours[9].calls, day.hours[14].calls, day.hours[10].calls], [2, 1, 0])
check('the hour bucket keeps its own tokens', day.hours[9].total, 100 + 900 + 50 + 1000 + 30)
check('the busiest hour is reported', day.peakHour, 9)
close('cache hit rate is cacheRead / billable input', day.cacheHitRate, 1900 / 2400, 1e-12)

{
  const noCache = aggregateDay({
    records: [record({ inputTokens: 100, outputTokens: 10 })],
    pricing: builtin,
    timeZone: 'Asia/Shanghai',
    now: Date.parse('2026-10-19T15:00:00+08:00'),
  })
  close('a call with no cache read has a zero hit rate', noCache.cacheHitRate, 0, 1e-12)
  const empty = aggregateDay({ records: [], pricing: builtin, timeZone: 'Asia/Shanghai', now: 0 })
  check('an empty day reports no hit rate rather than zero', empty.cacheHitRate, null)
  check('an empty day still has 24 buckets', empty.hours.length, 24)
}

// --- unpriced ------------------------------------------------------------

{
  const mixed = aggregateDay({
    records: [
      record({ inputTokens: 1000, outputTokens: 100 }),
      record({ model: 'mystery-1', provider: 'acme', inputTokens: 500, outputTokens: 50 }),
    ],
    pricing: builtin,
    timeZone: 'Asia/Shanghai',
    now: Date.parse('2026-10-19T15:00:00+08:00'),
  })
  check('an unpriced call is counted separately', mixed.cost.unpricedCalls, 1)
  check('an unpriced call is named', mixed.cost.unpricedModels, ['acme/mystery-1'])
  check('unpriced tokens are still counted in the total', mixed.tokens.total, 1650)
  check('unpriced tokens are excluded from the priced amount', mixed.cost.unpricedTokens, 550)
  check('the day total is a lower bound', mixed.cost.lowerBound, true)
  check('the priced share still has a count', mixed.cost.pricedCalls, 1)
}

// --- rotation -------------------------------------------------------------

const dir = await mkdtemp(join(tmpdir(), 'usage-lens-day-'))
const archiveFiles = []
try {
  const ledger = createLedger({ dir, timeZone: 'Asia/Shanghai', maxBytes: 700 })
  for (let index = 0; index < 12; index += 1) {
    ledger.append(record({
      step: index + 1,
      timestamp: `2026-10-19T09:${String(index * 4).padStart(2, '0')}:00+08:00`,
      inputTokens: 10 * (index + 1),
    }))
  }
  await ledger.flush()

  const monthSegments = await ledger.segments('2026-10')
  check('a small threshold rotates into several segments', monthSegments.length > 2, true)
  for (const segment of monthSegments) archiveFiles.push(segment)
  const archives = monthSegments.slice(0, -1)
  for (const archive of archives) {
    const mode = (await stat(archive)).mode
    check(`archive ${archive.split('\\').pop()} is read-only`, (mode & 0o200) === 0, true)
  }
  check('the active file is still writable', ((await stat(monthSegments[monthSegments.length - 1])).mode & 0o200) !== 0, true)

  const all = await ledger.readMonth('2026-10')
  check('every record survives rotation', all.length, 12)
  check('rotation keeps the order', all.map((entry) => entry.step), Array.from({ length: 12 }, (_, index) => index + 1))
  check('a day query spans the segments', (await ledger.readDay('2026-10-19')).length, 12)
  check('a session query spans the segments', (await ledger.readSession('session-day')).length, 12)

  // The rotated files are genuinely no longer appended to.
  const archiveBytes = await readFile(archives[0], 'utf8')
  ledger.append(record({ step: 99, timestamp: '2026-10-19T23:00:00+08:00' }))
  await ledger.flush()
  check('an archive is never appended to', await readFile(archives[0], 'utf8'), archiveBytes)

  // Acceptance 5: an override changes only the rendered amount. Compare the
  // file bytes, not just the parsed values: nothing in the pricing path writes.
  const bytesBefore = await readFile(monthSegments[monthSegments.length - 1], 'utf8')
  const repriced = aggregateDay({
    records: await ledger.readDay('2026-10-19'),
    pricing: buildPricingTable({ models: { 'deepseek-flash': { offPeak: { output: 1000 } } } }),
    timeZone: 'Asia/Shanghai',
    now: Date.parse('2026-10-19T23:59:00+08:00'),
  })
  const bytesAfter = await readFile(monthSegments[monthSegments.length - 1], 'utf8')
  check('the override leaves every ledger byte alone', bytesAfter, bytesBefore)
  check('every day row is still priced', repriced.cost.pricedCalls, 13)
} finally {
  for (const file of archiveFiles) {
    try {
      await chmod(file, 0o666)
    } catch {
      // already writable
    }
  }
  await rm(dir, { recursive: true, force: true })
}

// --- cross-midnight -------------------------------------------------------

{
  const split = await mkdtemp(join(tmpdir(), 'usage-lens-midnight-'))
  try {
    const ledger = createLedger({ dir: split, timeZone: 'Asia/Shanghai' })
    ledger.append(record({ timestamp: '2026-10-19T23:59:00+08:00', inputTokens: 111 }))
    ledger.append(record({ timestamp: '2026-10-20T00:01:00+08:00', inputTokens: 222 }))
    ledger.append(record({ timestamp: '2026-10-20T00:30:00+08:00', inputTokens: 333 }))
    await ledger.flush()

    check('the late call stays on its own day', (await ledger.readDay('2026-10-19')).length, 1)
    check('both early calls land on the new day', (await ledger.readDay('2026-10-20')).length, 2)

    const first = aggregateDay({
      records: await ledger.readDay('2026-10-19'),
      pricing: builtin,
      timeZone: 'Asia/Shanghai',
      now: Date.parse('2026-10-19T23:59:30+08:00'),
    })
    const second = aggregateDay({
      records: await ledger.readDay('2026-10-20'),
      pricing: builtin,
      timeZone: 'Asia/Shanghai',
      now: Date.parse('2026-10-20T00:30:30+08:00'),
    })
    check('day one totals its own tokens', first.tokens.input, 111)
    check('day one puts the call in hour 23', [first.hours[23].calls, first.hours[0].calls], [1, 0])
    check('day two totals its own tokens', second.tokens.input, 555)
    check('day two puts the calls in hour 0', [second.hours[0].calls, second.hours[23].calls], [2, 0])
    check('the days do not leak into each other', [first.date, second.date], ['2026-10-19', '2026-10-20'])

    // The panel document honours the same day boundary.
    const document = await buildSessionDocument({
      ledger,
      pricing: builtin,
      collector: undefined,
      sessionId: 'session-day',
      now: Date.parse('2026-10-20T00:30:30+08:00'),
    })
    check('the panel day block follows the requested day', document.today.date, '2026-10-20')
    check('the panel day block sums that day', document.today.tokens.input, 555)
    check('the panel session total spans both days', document.session.tokens.input, 666)
    check('the panel labels the price table', document.pricingLabel.mode, 'builtin')
  } finally {
    await rm(split, { recursive: true, force: true })
  }
}

// --- session share --------------------------------------------------------

{
  const session = aggregateRecords({
    records: [
      record({ inputTokens: 100, cacheReadTokens: 300, outputTokens: 50 }),
      record({ model: 'mystery-1', provider: 'acme', inputTokens: 10, outputTokens: 5 }),
    ],
    pricing: builtin,
  })
  check('the session share counts both calls', session.calls, 2)
  check('the session share counts tokens', session.tokens.total, 465)
  close('the session share keeps the hit rate', session.cacheHitRate, 300 / 410, 1e-12)
  check('the session share flags the unpriced call', session.cost.lowerBound, true)
}

if (failures.length > 0) {
  console.error(`${failures.length} of ${checks} checks FAILED:\n`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log(`all ${checks} checks passed`)
