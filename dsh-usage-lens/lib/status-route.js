/**
 * Host JSON route backing the composer status bar.
 *
 * The client asks for one Beijing calendar day; the Host reads that day from
 * the ledger and prices it with the table currently in force. Nothing is cached
 * across requests, so editing `pricing` in cordis.patch.yml reprices the same
 * ledger rows on the next poll (AGENTS.md convention 4).
 *
 * @module dsh-usage-lens/lib/status-route
 */

import { aggregateDay } from './day.js'
import { registerGetRoute, readQuery } from './http.js'
import { pricingLabel } from './pricing.js'
import { dateKey, isDayKey } from './time.js'

/**
 * Aggregate one day of records into the document the status bar renders.
 * @param options - ledger, pricing table, time zone, and the live reader.
 * @param options.now - instant the document describes (defaults to `Date.now()`).
 */
export async function buildStatusDocument({ ledger, pricing, timeZone, live, now = Date.now() }) {
  // `pricing` is either a table or a resolver returning `{ table, sync }`, so a
  // route can await an opted-in remote sync without any call site caring.
  const resolved = typeof pricing === 'function' ? await pricing() : pricing
  const table = resolved?.table ?? resolved
  const day = aggregateDay({
    records: await ledger.readDay(dateKey(now, timeZone)),
    pricing: table,
    timeZone,
    now,
  })
  const liveState = typeof live === 'function' ? live() : { calls: 0, estimatedTokens: 0 }

  return {
    ok: true,
    generatedAt: now,
    timeZone,
    date: day.date,
    pricingVersion: table.version,
    pricingCurrency: table.currency,
    pricingLabel: pricingLabel(table),
    today: {
      calls: day.calls,
      statuses: day.statuses,
      tokens: day.tokens,
      cost: day.cost,
      cacheHitRate: day.cacheHitRate,
      hours: day.hours,
      maxHourTokens: day.maxHourTokens,
      peakHour: day.peakHour,
    },
    live: {
      calls: liveState.calls ?? 0,
      estimatedTokens: liveState.estimatedTokens ?? 0,
    },
  }
}

/**
 * Register the status route on the composed Web carrier.
 * @param ctx - plugin context.
 * @param options - `path`, `ledger`, `pricing`, `timeZone`, `live`, `warn`.
 */
export function registerStatusRoute(ctx, options) {
  const { path, ledger, pricing, timeZone, live, warn = () => {} } = options
  // Diagnostics: how many times the page has actually asked. `?diag=1` reports
  // it, which is how "is the pill polling at all?" stops being a guess.
  let requests = 0
  let lastHost
  let lastOrigin
  let lastUserAgent

  registerGetRoute(ctx, {
    path,
    name: 'status',
    warn,
    handle: async (req) => {
      requests += 1
      const headers = req.headers ?? {}
      lastHost = typeof headers.host === 'string' ? headers.host : undefined
      lastOrigin = typeof headers.origin === 'string' ? headers.origin : undefined
      lastUserAgent = typeof headers['user-agent'] === 'string' ? headers['user-agent'].slice(0, 120) : undefined
      const query = readQuery(req)
      const day = query.get('date')
      const now = isDayKey(day) ? Date.parse(`${day}T12:00:00+08:00`) : Date.now()
      const body = await buildStatusDocument({ ledger, pricing, timeZone, live, now })
      if (query.get('diag') === '1') {
        body.diagnostics = { requests, lastHost, lastOrigin, lastUserAgent }
      }
      return { body }
    },
  })
}
