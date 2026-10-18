/**
 * Host JSON route backing the detail panel: one session's turns, each with its
 * per-call rows, the "今日用量" day fold, and the execution-process block of the
 * turn being shown.
 *
 * The route joins the same three sources every time — ledger records (durable
 * tokens), the turn collector (live turn/step membership, tool detail, pins),
 * and the price table in force — so a price edit changes only what is rendered.
 * Raw payloads are deliberately not here: they ride the raw route.
 *
 * @module dsh-usage-lens/lib/session-route
 */

import { projectSession } from './aggregator.js'
import { aggregateDay, aggregateRecords } from './day.js'
import { registerGetRoute, readQuery } from './http.js'
import { pricingLabel } from './pricing.js'
import { projectProcess } from './process.js'
import { dateKey, isDayKey } from './time.js'

/**
 * Build the panel document for one session.
 * @param options - `ledger`, `pricing`, `collector`, `sessionId`, `now`.
 */
export async function buildSessionDocument({ ledger, pricing, collector, sessionId, now = Date.now() }) {
  const records = await ledger.readSession(sessionId, now)
  const turns = typeof collector?.sessionTurns === 'function'
    ? collector.sessionTurns(sessionId)
    : []
  const pins = typeof collector?.pins === 'function' ? collector.pins(sessionId) : []
  const projected = projectSession({ records, turns, pricing })

  const day = aggregateDay({
    records: await ledger.readDay(dateKey(now, pricing.timeZone)),
    pricing,
    timeZone: pricing.timeZone,
    now,
  })
  const session = aggregateRecords({ records, pricing })

  // The process block follows the live turn when the collector has one (a turn
  // can be streaming before its first ledger row exists), otherwise the newest
  // attributed turn the ledger knows.
  const liveTurn = [...turns]
    .filter((turn) => Array.isArray(turn.steps) && turn.steps.length > 0 && turn.turn > 0)
    .sort((left, right) => right.turn - left.turn)[0]
  const fallbackTurn = projected.find((turn) => turn.attributed !== false) ?? projected[0]
  const processTurnNumber = liveTurn?.turn ?? fallbackTurn?.turn
  const collectorTurn = turns.find((turn) => turn.turn === processTurnNumber)
  const process = processTurnNumber === undefined
    ? undefined
    : projectProcess({
      turn: collectorTurn,
      records: records.filter((record) => record.turn === processTurnNumber),
      pins,
    })

  return {
    ok: true,
    sessionId,
    generatedAt: Date.now(),
    timeZone: pricing.timeZone,
    pricingVersion: pricing.version,
    pricingCurrency: pricing.currency,
    pricingLabel: pricingLabel(pricing),
    turns: projected,
    today: {
      calls: day.calls,
      statuses: day.statuses,
      tokens: day.tokens,
      cost: day.cost,
      cacheHitRate: day.cacheHitRate,
      hours: day.hours,
      maxHourTokens: day.maxHourTokens,
      peakHour: day.peakHour,
      date: day.date,
    },
    session: {
      calls: session.calls,
      tokens: session.tokens,
      cost: session.cost,
      cacheHitRate: session.cacheHitRate,
    },
    process,
  }
}

/**
 * Register the session route on the composed Web carrier.
 * @param ctx - plugin context.
 * @param options - `path`, `ledger`, `pricing`, `collector`, `warn`.
 */
export function registerSessionRoute(ctx, options) {
  const { path, ledger, pricing, collector, warn = () => {} } = options

  registerGetRoute(ctx, {
    path,
    name: 'session',
    warn,
    handle: async (req) => {
      const query = readQuery(req)
      const sessionId = query.get('sessionId')
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { status: 400, body: { ok: false, error: 'session-required' } }
      }
      const day = query.get('date')
      const now = isDayKey(day) ? Date.parse(`${day}T12:00:00+08:00`) : Date.now()
      return { body: await buildSessionDocument({ ledger, pricing, collector, sessionId, now }) }
    },
  })
}
