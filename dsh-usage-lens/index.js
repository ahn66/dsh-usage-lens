/**
 * dsh-usage-lens — Host half.
 *
 * Slice 1: intercept `llm/stream`, settle one JSONL ledger row per conversation
 * call from the provider's authoritative usage, price the Beijing day, serve it
 * to the composer status bar.
 *
 * Slice 2 adds `session/event` turn/step attribution, the turn projection, and
 * the per-session route behind the detail panel.
 *
 * Slice 3 adds the execution-process block: frozen-request Skill parsing with a
 * cross-check against the `skill` tool call, the four pinned key-step rules, the
 * folded process flow, and an on-demand raw-data route.
 *
 * Still out of scope: the "今日用量" trend chart and a pricing editor.
 *
 * @module dsh-usage-lens
 */

import { resolveConfig } from './lib/config.js'
import { createLedger } from './lib/ledger.js'
import { registerRawRoute } from './lib/raw-route.js'
import { registerSessionRoute } from './lib/session-route.js'
import { registerStatusRoute } from './lib/status-route.js'
import { installStreamInterceptor } from './lib/stream-interceptor.js'
import { createTurnCollector } from './lib/turns.js'

/** Plugin name used in diagnostics. */
export const name = 'dsh-usage-lens'

/**
 * Activate the Host half.
 * @param ctx - plugin context.
 * @param rawConfig - the Loader row's `config` object.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const warn = (message) => {
    console.warn(`[${name}] ${message}`)
  }

  const ledger = createLedger({
    dir: config.ledgerDir,
    timeZone: config.timeZone,
    maxBytes: config.ledgerMaxBytes,
    warn,
  })

  // Turn/step membership, tool detail and pinned key steps. Registered before
  // the interceptor so a settling call always sees the step it belongs to.
  const collector = createTurnCollector({ warn })
  ctx.effect(
    () => ctx.on('session/event', (session, event) => collector.observe(session, event)),
    'dsh-usage-lens: session/event collector',
  )

  // A passive `tools/pre-execute` observer: it returns the decision untouched
  // and only records a denial, so it can never change tool behaviour.
  ctx.effect(
    () => ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      collector.noteToolDecision(exec, decision)
      return decision
    }),
    'dsh-usage-lens: tool denial observer',
  )

  const interceptor = installStreamInterceptor(ctx, {
    ledger,
    timeZone: config.timeZone,
    warn,
    attribute: collector.context,
    onRequest: collector.noteRequest,
  })

  registerStatusRoute(ctx, {
    path: config.statusPath,
    ledger,
    pricing: config.pricing,
    timeZone: config.timeZone,
    live: interceptor.liveSnapshot,
    warn,
  })

  registerSessionRoute(ctx, {
    path: config.sessionPath,
    ledger,
    pricing: config.pricing,
    collector,
    warn,
  })

  registerRawRoute(ctx, {
    path: config.rawPath,
    collector,
    warn,
  })

  ctx.effect(() => () => {
    // Drain queued writes so a shutdown does not lose the last settled row.
    void ledger.flush()
  }, 'dsh-usage-lens: ledger flush')
}
