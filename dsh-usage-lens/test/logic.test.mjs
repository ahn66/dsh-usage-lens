/**
 * Pure-logic self test for slice 1. No test framework: run it with node.
 *
 *   node test/logic.test.mjs
 *
 * It exercises the parts that must be provably right before a live call is
 * involved: Beijing day keys, peak windows, price lookup order, amount math by
 * hand, ledger round trip, and the status document aggregation.
 *
 * @module dsh-usage-lens/test/logic
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPricingTable, computeAmount, priceRecord, resolveRate } from '../lib/pricing.js'
import { createLedger } from '../lib/ledger.js'
import { buildStatusDocument } from '../lib/status-route.js'
import { dateKey, isPeakInstant, isoWithOffset } from '../lib/time.js'

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

// --- time ------------------------------------------------------------------

// 2026-10-18 is a Sunday; 2026-10-19 is a Monday.
const sundayNoon = Date.parse('2026-10-18T12:00:00+08:00')
const mondayMorning = Date.parse('2026-10-19T09:30:00+08:00')
const mondayLunch = Date.parse('2026-10-19T12:30:00+08:00')
const mondayAfternoon = Date.parse('2026-10-19T14:00:00+08:00')
const mondayEvening = Date.parse('2026-10-19T18:00:00+08:00')

check('dateKey off-peak Sunday', dateKey(sundayNoon), '2026-10-18')
check('isoWithOffset', isoWithOffset(sundayNoon), '2026-10-18T12:00:00+08:00')
// A UTC instant still buckets by the Beijing calendar day.
check('dateKey in Beijing for a UTC instant', dateKey(Date.parse('2026-10-18T20:30:00Z')), '2026-10-19')
check('isoWithOffset for a UTC instant', isoWithOffset(Date.parse('2026-10-18T20:30:00Z')), '2026-10-19T04:30:00+08:00')

const table = buildPricingTable()
check('Sunday is off-peak', isPeakInstant(sundayNoon, table), false)
check('Monday 09:30 is peak', isPeakInstant(mondayMorning, table), true)
check('Monday 12:30 is off-peak', isPeakInstant(mondayLunch, table), false)
check('Monday 14:00 is peak (inclusive start)', isPeakInstant(mondayAfternoon, table), true)
check('Monday 18:00 is off-peak (exclusive end)', isPeakInstant(mondayEvening, table), false)
check(
  'a holiday is off-peak even on a weekday',
  isPeakInstant(mondayMorning, buildPricingTable({ holidays: ['2026-10-19'] })),
  false,
)

// --- pricing lookup order --------------------------------------------------

check('exact model name wins', resolveRate(table, 'deepseek-flash', 'deepseek-account')?.key, 'deepseek-flash')

const composedTable = buildPricingTable({
  models: {
    'deepseek-account/deepseek-flash': { peak: { cacheHit: 1, cacheMiss: 1, output: 1 } },
    'deepseek-*': { peak: { cacheHit: 2, cacheMiss: 2, output: 2 } },
    'deepseek-f*': { peak: { cacheHit: 3, cacheMiss: 3, output: 3 } },
  },
})
check(
  'exact name still beats the composed key',
  resolveRate(composedTable, 'deepseek-flash', 'deepseek-account')?.key,
  'deepseek-flash',
)
const routeOnly = buildPricingTable({ models: { 'deepseek-flash': null, 'deepseek-account/deepseek-flash': { peak: { cacheMiss: 1 } } } })
check(
  'provider/model is the second lookup step',
  resolveRate(routeOnly, 'deepseek-flash', 'deepseek-account')?.key,
  'deepseek-account/deepseek-flash',
)
const wildcardOnly = buildPricingTable({ models: { 'deepseek-flash': null, 'deepseek-*': { peak: { cacheMiss: 2 } }, 'deepseek-f*': { peak: { cacheMiss: 3 } } } })
check(
  'the longest wildcard prefix wins',
  resolveRate(wildcardOnly, 'deepseek-flash', 'anything')?.key,
  'deepseek-f*',
)
check('an unknown model is unpriced', resolveRate(table, 'gpt-9', 'openai'), undefined)

// --- amount math, by hand --------------------------------------------------

// off-peak deepseek-flash: 1000 uncached + 2000 cache read + 500 cache write
// + 400 output => (1500 * 1.0 + 2000 * 0.02 + 400 * 4.0) / 1e6 = 0.00314
close(
  'off-peak amount',
  computeAmount(table.models['deepseek-flash'], {
    inputTokens: 1000, cacheReadTokens: 2000, cacheWriteTokens: 500, outputTokens: 400,
  }, false),
  0.00314,
)
// peak deepseek-v4-pro: (1500 * 9 + 2000 * 0.30 + 400 * 27) / 1e6 = 0.0249
close(
  'peak amount',
  computeAmount(table.models['deepseek-v4-pro'], {
    inputTokens: 1000, cacheReadTokens: 2000, cacheWriteTokens: 500, outputTokens: 400,
  }, true),
  0.0249,
)

const priced = priceRecord(table, {
  model: 'deepseek-flash',
  provider: 'deepseek',
  inputTokens: 1000,
  cacheReadTokens: 2000,
  cacheWriteTokens: 500,
  outputTokens: 400,
  timestamp: '2026-10-19T09:30:00+08:00',
})
check('peak record is priced', priced.priced, true)
check('peak record detected peak', priced.peak, true)
close('peak record amount', priced.amount, 0.0249 * 0 + (1500 * 2.0 + 2000 * 0.04 + 400 * 8.0) / 1e6, 1e-12)

const unpriced = priceRecord(table, {
  model: 'mystery-1',
  provider: 'acme',
  inputTokens: 10,
  outputTokens: 10,
  timestamp: '2026-10-19T09:30:00+08:00',
})
check('unknown model is unpriced', unpriced.priced, false)
close('unknown model is never billed as zero-amount cost', unpriced.amount, 0)

// --- ledger round trip -----------------------------------------------------

const dir = await mkdtemp(join(tmpdir(), 'usage-lens-'))
try {
  const ledger = createLedger({ dir, timeZone: 'Asia/Shanghai' })
  const base = {
    sessionId: 'session-test',
    turn: 0,
    step: 0,
    model: 'deepseek-flash',
    provider: 'deepseek',
    inputTokens: 1000,
    cacheReadTokens: 2000,
    cacheWriteTokens: 500,
    outputTokens: 400,
    reasoningTokens: 120,
    timestamp: '2026-10-19T09:30:00+08:00',
    durationMs: 3200,
    status: 'completed',
  }
  ledger.append(base)
  ledger.append({ ...base, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, timestamp: '2026-10-19T10:00:00+08:00', status: 'failed' })
  ledger.append({ ...base, timestamp: '2026-10-18T10:00:00+08:00' })
  ledger.append({ ...base, status: 'cancelled', timestamp: '2026-10-19T11:00:00+08:00' })
  await ledger.flush()

  const text = await readFile(join(dir, 'ledger-2026-10.jsonl'), 'utf8')
  const lines = text.split('\n').filter((line) => line !== '')
  check('one line per settled call', lines.length, 4)
  check('every line is valid JSON with the schema keys', Object.keys(JSON.parse(lines[0])), [
    'sessionId', 'turn', 'step', 'model', 'provider', 'inputTokens',
    'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens',
    'timestamp', 'durationMs', 'status',
  ])
  check('the October 18 call rotated into the same month file', JSON.parse(lines[2]).timestamp, '2026-10-18T10:00:00+08:00')

  const day = await ledger.readDay('2026-10-19')
  check('readDay filters by Beijing day', day.length, 3)
  check('readDay keeps status', day.map((record) => record.status).sort(), ['cancelled', 'completed', 'failed'])

  // --- status document -----------------------------------------------------
  const document = await buildStatusDocument({
    ledger,
    pricing: table,
    timeZone: 'Asia/Shanghai',
    live: () => ({ calls: 1, estimatedTokens: 42 }),
    now: Date.parse('2026-10-19T13:00:00+08:00'),
  })
  check('document day', document.date, '2026-10-19')
  check('document counts every status', document.today.statuses, { completed: 1, failed: 1, cancelled: 1 })
  // Three records that day: completed and cancelled each carry the full
  // buckets, the failed one reports no usage at all.
  check('document billable input', document.today.tokens.billableInput, 2 * (1000 + 2000 + 500))
  // total = billableInput + output, cached input counted once
  check('document total', document.today.tokens.total, 2 * (1000 + 2000 + 500 + 400))
  check('only the priced completed row is charged', document.today.cost.pricedCalls, 3)
  check('no unpriced call here', document.today.cost.unpricedCalls, 0)
  check('lower bound flag stays off', document.today.cost.lowerBound, false)
  check('live estimate reaches the client', document.live.estimatedTokens, 42)

  const withUnpriced = createLedger({ dir: join(dir, 'second'), timeZone: 'Asia/Shanghai' })
  withUnpriced.append({ ...base, model: 'mystery-1', provider: 'acme' })
  await withUnpriced.flush()
  const mixed = await buildStatusDocument({
    ledger: withUnpriced,
    pricing: table,
    timeZone: 'Asia/Shanghai',
    live: () => ({ calls: 0, estimatedTokens: 0 }),
    now: Date.parse('2026-10-19T13:00:00+08:00'),
  })
  check('unpriced model counted separately', mixed.today.cost.unpricedCalls, 1)
  check('unpriced model named', mixed.today.cost.unpricedModels, ['acme/mystery-1'])
  check('unpriced tokens counted', mixed.today.cost.unpricedTokens, 3900)
  check('total becomes a lower bound', mixed.today.cost.lowerBound, true)
  check('token total still counted for unpriced model', mixed.today.tokens.total, 3900)
} finally {
  await rm(dir, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`${failures.length} of ${checks} checks FAILED:\n`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log(`all ${checks} checks passed`)
