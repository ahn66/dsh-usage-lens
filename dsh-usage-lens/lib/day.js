/**
 * Day aggregation: the one place a Beijing calendar day is folded.
 *
 * Both readers use it — the status pill's route and the panel's "今日用量"
 * block — so the two can never drift. Tokens and money are computed from ledger
 * records alone; nothing here is stored, which is what makes a price-table
 * override reprice history instead of rewriting it.
 *
 * @module dsh-usage-lens/lib/day
 */

import { billableTokens, priceRecord } from './pricing.js'
import { dateKey, zonedParts } from './time.js'

/** Hours in a calendar day. */
const HOURS = 24

function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Empty token bucket set, with the two derived totals present from the start. */
export function emptyTokens() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, billableInput: 0, total: 0 }
}

function addRecordTokens(target, record) {
  const input = tokenCount(record.inputTokens)
  const cacheRead = tokenCount(record.cacheReadTokens)
  const cacheWrite = tokenCount(record.cacheWriteTokens)
  const output = tokenCount(record.outputTokens)
  target.input += input
  target.cacheRead += cacheRead
  target.cacheWrite += cacheWrite
  target.output += output
  target.reasoning += tokenCount(record.reasoningTokens)
  target.billableInput += input + cacheRead + cacheWrite
  target.total += input + cacheRead + cacheWrite + output
}

function emptyHour(hour) {
  return { hour, ...emptyTokens(), calls: 0, peakCalls: 0 }
}

/**
 * Cache hit share of billable input. `null` when nothing was billed yet, so the
 * UI can show `—` instead of a misleading zero.
 */
export function cacheHitRate(tokens) {
  const billableInput = tokens.billableInput
  if (!(billableInput > 0)) return null
  return tokens.cacheRead / billableInput
}

/**
 * Fold one day of records into the numbers both blocks render.
 * @param options - `records` (only the requested day), `pricing`, `timeZone`.
 * @param options.now - instant that names the day; defaults to now.
 * @returns tokens, money, per-hour buckets, cache hit rate and call/status
 *   counts. `records` must already be filtered to the day — the caller reads it
 *   from the ledger, which is the single source of truth.
 */
export function aggregateDay({ records, pricing, timeZone, now = Date.now() }) {
  const hours = Array.from({ length: HOURS }, (_, hour) => emptyHour(hour))
  const tokens = emptyTokens()
  const statuses = { completed: 0, failed: 0, cancelled: 0 }
  const unpricedModels = new Set()
  let pricedCalls = 0
  let pricedAmount = 0
  let unpricedCalls = 0
  let unpricedTokens = 0

  for (const record of records) {
    addRecordTokens(tokens, record)
    if (record.status in statuses) statuses[record.status] += 1

    const instant = Date.parse(record.timestamp)
    const hour = Number.isFinite(instant) ? zonedParts(instant, timeZone).hour : 0
    const bucket = hours[hour]
    addRecordTokens(bucket, record)
    bucket.calls += 1

    const priced = priceRecord(pricing, record)
    if (priced.peak) bucket.peakCalls += 1
    if (priced.priced) {
      pricedCalls += 1
      pricedAmount += priced.amount
    } else {
      unpricedCalls += 1
      unpricedTokens += billableTokens(record)
      unpricedModels.add(`${record.provider === '' ? '?' : record.provider}/${record.model}`)
    }
  }

  let maxHourTokens = 0
  let peakHour = undefined
  for (const hour of hours) {
    if (hour.total > maxHourTokens) {
      maxHourTokens = hour.total
      peakHour = hour.hour
    }
  }

  return {
    date: dateKey(now, timeZone),
    calls: records.length,
    statuses,
    tokens,
    cost: {
      pricedCalls,
      unpricedCalls,
      unpricedTokens,
      unpricedModels: [...unpricedModels].sort(),
      pricedAmount,
      // A lower bound whenever any token in the day is unpriced.
      lowerBound: unpricedCalls > 0,
    },
    cacheHitRate: cacheHitRate(tokens),
    hours,
    maxHourTokens,
    peakHour,
  }
}

/** Fold one set of records (a session, a turn) into the same token/cost shape. */
export function aggregateRecords({ records, pricing }) {
  const tokens = emptyTokens()
  const unpricedModels = new Set()
  let pricedCalls = 0
  let pricedAmount = 0
  let unpricedCalls = 0
  let unpricedTokens = 0

  for (const record of records) {
    addRecordTokens(tokens, record)
    const priced = priceRecord(pricing, record)
    if (priced.priced) {
      pricedCalls += 1
      pricedAmount += priced.amount
    } else {
      unpricedCalls += 1
      unpricedTokens += billableTokens(record)
      unpricedModels.add(`${record.provider === '' ? '?' : record.provider}/${record.model}`)
    }
  }

  return {
    calls: records.length,
    tokens,
    cost: {
      pricedCalls,
      unpricedCalls,
      unpricedTokens,
      unpricedModels: [...unpricedModels].sort(),
      pricedAmount,
      lowerBound: unpricedCalls > 0,
    },
    cacheHitRate: cacheHitRate(tokens),
  }
}
