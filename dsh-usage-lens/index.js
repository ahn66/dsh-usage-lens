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
import { buildPricingTable } from './lib/pricing.js'
import { resolveRemotePricing } from './lib/pricing-sync.js'
import { registerRawRoute } from './lib/raw-route.js'
import { registerSessionRoute } from './lib/session-route.js'
import { registerStatusRoute } from './lib/status-route.js'
import { installStreamInterceptor } from './lib/stream-interceptor.js'
import { createTurnCollector } from './lib/turns.js'

/** Plugin name used in diagnostics. */
export const name = 'dsh-usage-lens'

/**
 * Build the effective price table for this activation.
 *
 * The built-in snapshot always sits underneath. A configured `pricing` section
 * layers over it, and — only when `pricing.sync.enabled` is true — so does the
 * remote layer, with the explicit local overrides applied last so a hand-edited
 * price always beats a fetched one.
 *
 * A sync failure is reported and then ignored: the table simply keeps the
 * snapshot, which is the documented no-network behaviour. No amount is ever
 * invented to cover a gap (AGENTS.md convention 6).
 * @param config - resolved plugin config.
 * @returns `{ table, sync }` once the remote layer has been resolved.
 */
async function resolvePricing(config) {
  const sync = config.pricingSync ?? { enabled: false }
  if (sync.enabled !== true) {
    return { table: config.pricing, sync: { origin: 'disabled', models: 0 } }
  }

  const warn = (message) => {
    console.warn(`[${name}] ${message}`)
  }

  let remote
  try {
    remote = await resolveRemotePricing({
      ledgerDir: config.ledgerDir,
      enabled: true,
      refresh: sync.refresh,
      maxAgeMs: sync.maxAgeMs,
      sourceIds: sync.sourceIds,
      usdToCny: sync.usdToCny,
      warn,
    })
  } catch (error) {
    warn(`pricing sync failed: ${error instanceof Error ? error.message : String(error)}`)
    return { table: config.pricing, sync: { origin: 'failed', models: 0 } }
  }

  const count = Object.keys(remote.models ?? {}).length
  if (count === 0) {
    return { table: config.pricing, sync: { ...remote, models: 0 } }
  }

  // Remote rates first, then the profile's own `pricing` section on top, so a
  // local override still wins — and still marks the table as customized.
  const merged = { ...remote.models }

  // A synced catalogue contributes *aliases* (a bare `deepseek-v4.1-flash`
  // beside its `vendor/…` id). A hand-written local entry is a deliberate
  // statement about one route, so any remote alias that would shadow it — by
  // matching a local key's bare model name — is withdrawn. Local always wins,
  // whether it was written as `model` or `provider/model`.
  const localKeys = Object.keys(config.pricing.models ?? {})
  const localBare = new Set()
  for (const key of localKeys) {
    const slash = key.indexOf('/')
    localBare.add(slash > 0 ? key.slice(slash + 1) : key)
  }
  for (const key of Object.keys(merged)) {
    if (localKeys.includes(key)) continue
    if (localBare.has(key)) delete merged[key]
  }

  for (const [key, entry] of Object.entries(config.pricing.models ?? {})) {
    merged[key] = entry
  }

  return {
    table: buildPricingTable({ ...config.pricing, models: merged, mode: 'merge' }),
    sync: { ...remote, models: count },
  }
}

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

  // Remote price sync is opt-in. Capture its promise so routes can await the
  // table they will serve, and so activation of the ledger and collector never
  // waits on the network.
  const pricingReady = resolvePricing(config)

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
    pricing: () => pricingReady,
    timeZone: config.timeZone,
    live: interceptor.liveSnapshot,
    warn,
  })

  registerSessionRoute(ctx, {
    path: config.sessionPath,
    ledger,
    pricing: () => pricingReady,
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
