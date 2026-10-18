/**
 * Built-in price snapshot, peak/off-peak resolution, and money math.
 *
 * The ledger stores token buckets only; every amount here is derived at render
 * time from the table in force, so a price change reprices history instead of
 * rewriting it (AGENTS.md convention 4).
 *
 * Units: yuan per one million tokens. `cacheMiss` prices uncached input AND
 * cache writes; `cacheHit` prices cache reads; `output` prices every output
 * token, reasoning included, because the provider already counts reasoning
 * inside output (convention 3).
 *
 * @module dsh-usage-lens/lib/pricing
 */

import { isDayKey, isPeakInstant } from './time.js'

/** Peak detection rule shared by every model entry. */
const PEAK_RULE = {
  timeZone: 'Asia/Shanghai',
  /** Monday through Friday (0 = Sunday). */
  peakDays: [1, 2, 3, 4, 5],
  /** Half-open `[start, end)` windows in minutes of the Beijing day. */
  peakWindows: [
    [9 * 60, 12 * 60],
    [14 * 60, 18 * 60],
  ],
  /**
   * Statutory holidays as Beijing day keys. The shipped snapshot carries none:
   * the State Council calendar is announced per year and is not guessed here.
   * Supply `pricing.holidays` in cordis.patch.yml to exclude specific dates.
   */
  holidays: [],
}

/**
 * The built-in snapshot. `pricingVersion` names the effective date of these
 * numbers and is shown next to every amount the UI renders.
 */
export const BUILTIN_PRICING = {
  version: 'builtin-2026-10-18',
  currency: 'CNY',
  unit: 'yuan-per-million-tokens',
  ...PEAK_RULE,
  models: {
    'deepseek-flash': {
      offPeak: { cacheHit: 0.02, cacheMiss: 1.0, output: 4.0 },
      peak: { cacheHit: 0.04, cacheMiss: 2.0, output: 8.0 },
    },
    'deepseek-v4-pro': {
      offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
      peak: { cacheHit: 0.3, cacheMiss: 9.0, output: 27.0 },
    },
  },
}

const RATE_FIELDS = ['cacheHit', 'cacheMiss', 'output']

function finiteRate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function mergeWindow(base, override) {
  if (override === undefined || override === null || typeof override !== 'object') return base
  const merged = { ...base }
  for (const field of RATE_FIELDS) {
    if (finiteRate(override[field])) merged[field] = override[field]
  }
  return merged
}

function mergeModel(base, override) {
  if (override === undefined || override === null || typeof override !== 'object') return base
  const merged = { ...(base ?? {}) }
  for (const window of ['peak', 'offPeak']) {
    const next = mergeWindow(base?.[window], override[window])
    if (next === undefined) continue
    merged[window] = next
  }
  return merged
}

function normalizeWindows(raw) {
  if (!Array.isArray(raw)) return undefined
  const windows = []
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) continue
    const [start, end] = entry
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue
    if (start < 0 || end > 24 * 60 || start >= end) continue
    windows.push([start, end])
  }
  return windows.length === 0 ? undefined : windows
}

/**
 * Build the table in force, layering an optional `pricing` config section over
 * the built-in snapshot.
 *
 * Acceptable override shape:
 * ```yaml
 * pricing:
 *   version: 'builtin-2026-10-18+cn'   # declares the table's own name
 *   mode: merge                        # 'merge' (default) or 'replace'
 *   holidays: ['2026-10-01']
 *   models:
 *     deepseek-flash:
 *       peak: { cacheMiss: 2.1 }        # partial merge over the snapshot
 *     'acme/*':
 *       offPeak: { cacheHit: 0, cacheMiss: 3, output: 9 }
 *     old-model: null                   # merge mode only: drop an entry
 * ```
 * `mode: replace` makes `models` the complete table, so the built-in entries
 * disappear. Overriding prices without declaring `version` marks the table as
 * user-customized, which the UI renders as "自定义价格" — a bare version number
 * would claim an authority the numbers do not have.
 * @param overrides - the raw `pricing` config section, if any.
 * @returns a detached table with the built-in snapshot as its base.
 */
export function buildPricingTable(overrides) {
  const table = {
    ...BUILTIN_PRICING,
    peakDays: [...BUILTIN_PRICING.peakDays],
    peakWindows: BUILTIN_PRICING.peakWindows.map((window) => [...window]),
    holidays: [...BUILTIN_PRICING.holidays],
    models: { ...BUILTIN_PRICING.models },
    customized: false,
    versionDeclared: false,
  }
  if (overrides === undefined || overrides === null || typeof overrides !== 'object') {
    return table
  }

  if (typeof overrides.version === 'string' && overrides.version.trim() !== '') {
    table.version = overrides.version.trim()
    table.versionDeclared = true
  }
  if (typeof overrides.timeZone === 'string' && overrides.timeZone.trim() !== '') {
    if (overrides.timeZone.trim() !== table.timeZone) table.customized = true
    table.timeZone = overrides.timeZone.trim()
  }
  if (Array.isArray(overrides.holidays)) {
    table.holidays = overrides.holidays.filter(isDayKey)
    table.customized = true
  }
  if (Array.isArray(overrides.peakDays)) {
    const days = overrides.peakDays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    if (days.length > 0) {
      table.peakDays = days
      table.customized = true
    }
  }
  const windows = normalizeWindows(overrides.peakWindows)
  if (windows !== undefined) {
    table.peakWindows = windows
    table.customized = true
  }

  if (overrides.models !== undefined && overrides.models !== null && typeof overrides.models === 'object') {
    const replace = overrides.mode === 'replace'
    if (replace) table.models = {}
    for (const [key, value] of Object.entries(overrides.models)) {
      const model = key.trim()
      if (model === '') continue
      if (value === null) {
        // Removing an entry changes what is priced just as much as editing one,
        // so the table stops claiming the snapshot's provenance either way.
        if (!replace) delete table.models[model]
        table.customized = true
        continue
      }
      const merged = mergeModel(replace ? undefined : table.models[model], value)
      if (merged !== undefined) table.models[model] = merged
      table.customized = true
    }
  }
  return table
}

/**
 * How the UI must label a table.
 *
 * - `builtin` — untouched snapshot: "按 <version> 价格表估算".
 * - `override` — the user overrode prices AND declared the table's version, so
 *   that version is an honest name for the numbers.
 * - `custom` — the user overrode prices without naming the table: the UI says
 *   "自定义价格" instead of borrowing the snapshot's version.
 * @param table - the table in force.
 */
export function pricingLabel(table) {
  if (table?.versionDeclared === true) return { mode: 'override', version: table.version, customized: true }
  if (table?.customized === true) return { mode: 'custom', version: table.version, customized: true }
  return { mode: 'builtin', version: table?.version ?? '', customized: false }
}

/**
 * Resolve the rate entry for one call.
 *
 * Lookup order (AGENTS.md): exact model name, then `provider/model`, then the
 * longest matching wildcard prefix. Wildcard keys are matched against both the
 * bare model and the composed `provider/model` text.
 * @param table - pricing table in force.
 * @param model - exact model id of the call.
 * @param provider - provider route of the call.
 * @returns the matched key and its rate entry, or `undefined` when unpriced.
 */
export function resolveRate(table, model, provider) {
  if (typeof model !== 'string' || model === '') return undefined
  const models = table.models ?? {}
  const exact = models[model]
  if (exact !== undefined && exact !== null) return { key: model, rates: exact }

  const composed = typeof provider === 'string' && provider !== '' ? `${provider}/${model}` : undefined
  if (composed !== undefined) {
    const byRoute = models[composed]
    if (byRoute !== undefined && byRoute !== null) return { key: composed, rates: byRoute }
  }

  let best
  for (const [key, rates] of Object.entries(models)) {
    if (!key.includes('*') || rates === null || rates === undefined) continue
    const prefix = key.slice(0, key.indexOf('*'))
    if (prefix === '') continue
    const matched = model.startsWith(prefix)
      || (composed !== undefined && composed.startsWith(prefix))
    if (!matched) continue
    if (best === undefined || prefix.length > best.prefix.length) {
      best = { key, prefix, rates }
    }
  }
  return best === undefined ? undefined : { key: best.key, rates: best.rates }
}

/** A non-negative finite token count, or 0. */
function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Price one token bucket set with one rate entry.
 * @param rates - `{ peak, offPeak }` rates of the matched model.
 * @param tokens - disjoint buckets: uncached input, cache read, cache write,
 *   output.
 * @param peak - whether the call instant is in a peak window.
 * @returns the amount in yuan, or `undefined` when the needed window is absent.
 */
export function computeAmount(rates, tokens, peak) {
  const window = (peak ? rates.peak : rates.offPeak) ?? rates.offPeak ?? rates.peak
  if (window === undefined || window === null) return undefined
  const cacheMiss = window.cacheMiss ?? 0
  const cacheHit = window.cacheHit ?? 0
  const output = window.output ?? 0
  // Cache writes are billed at the miss rate; cache reads at the hit rate.
  const missTokens = tokenCount(tokens.inputTokens) + tokenCount(tokens.cacheWriteTokens)
  const hitTokens = tokenCount(tokens.cacheReadTokens)
  const outputTokens = tokenCount(tokens.outputTokens)
  return (missTokens * cacheMiss + hitTokens * cacheHit + outputTokens * output) / 1_000_000
}

/**
 * Price one ledger record.
 * @param table - pricing table in force.
 * @param record - one ledger record carrying model, provider, buckets and an
 *   ISO timestamp with offset.
 * @returns `{ priced, amount, peak, rateKey }`; `amount` is 0 only when the
 *   model is priced but its buckets are empty.
 */
export function priceRecord(table, record) {
  const matched = resolveRate(table, record.model, record.provider)
  if (matched === undefined) {
    return { priced: false, amount: 0, peak: false, rateKey: undefined }
  }
  const instant = Date.parse(record.timestamp)
  const peak = Number.isFinite(instant) ? isPeakInstant(instant, table) : false
  const amount = computeAmount(matched.rates, record, peak)
  if (amount === undefined) {
    return { priced: false, amount: 0, peak, rateKey: matched.key }
  }
  return { priced: true, amount, peak, rateKey: matched.key }
}

/** Total billable tokens of one bucket set (cached input counted once). */
export function billableTokens(tokens) {
  return tokenCount(tokens.inputTokens)
    + tokenCount(tokens.cacheReadTokens)
    + tokenCount(tokens.cacheWriteTokens)
    + tokenCount(tokens.outputTokens)
}
