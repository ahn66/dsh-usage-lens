/**
 * `llm/stream` interception: live estimate, authoritative usage capture, and
 * one ledger row per settled conversation call.
 *
 * AGENTS.md convention 1 governs everything here:
 * - `assistant/chunk` usage fragments are never summed. The stream carries at
 *   most one authoritative `usage` chunk, and the assembly that produces
 *   `assistant/message.usage` keeps the *last* one it saw — read once, replaced
 *   the same way, so the ledger can never inflate past the session log.
 * - During streaming only a display estimate is accumulated, from delivered
 *   deltas, and it never reaches the ledger. The provider's usage chunk
 *   replaces it outright at settlement.
 *
 * Auxiliary calls (`purpose: 'compaction' | 'session-title'`) never produce an
 * `assistant/message`, so this slice leaves them out of the ledger.
 *
 * @module dsh-usage-lens/lib/stream-interceptor
 */

import { isoWithOffset } from './time.js'

/** Characters per token for the display-only live estimate. */
const CHARS_PER_TOKEN = 4

const EVENT_NAME = 'llm/stream'

function textOf(value) {
  return typeof value === 'string' ? value : ''
}

function countOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/**
 * Fold one stream chunk into the in-flight accumulator.
 * @param chunk - one `StreamChunk`.
 * @param state - mutable accumulator of the call in flight.
 */
function observeChunk(chunk, state) {
  if (chunk === null || typeof chunk !== 'object') return
  switch (chunk.type) {
    case 'text-delta':
      state.chars += textOf(chunk.text).length
      break
    case 'reasoning-delta':
      state.chars += textOf(chunk.text).length
      break
    case 'tool-call-delta':
      state.chars += textOf(chunk.argumentsDelta).length
      break
    case 'usage':
      // Last one wins, exactly like the assembler that stamps the session log.
      // Never accumulate: a repeated usage report is a replacement, not a delta.
      if (chunk.usage !== null && typeof chunk.usage === 'object') state.usage = chunk.usage
      break
    case 'finish':
      state.finishKind = chunk.reason?.kind
      break
    default:
      break
  }
}

/**
 * Classify how a call settled.
 * @param request - the intercepted request.
 * @param state - the settled accumulator.
 * @returns `completed`, `failed`, or `cancelled`.
 */
function classify(request, state) {
  switch (state.finishKind) {
    case 'stop':
    case 'tool-calls':
    case 'max-tokens':
      return 'completed'
    case 'error':
      return 'failed'
    case 'aborted':
      return 'cancelled'
    default:
      break
  }
  if (state.endedNormally) return 'completed'
  return request?.signal?.aborted === true ? 'cancelled' : 'failed'
}

/**
 * Install the interceptor on one Host context.
 * @param ctx - plugin context; the listener is owned by it.
 * @param options - `ledger`, `timeZone`, `warn`, `attribute` — a
 *   `(sessionId) => { turn, step } | undefined` reader that fills the turn/step
 *   fields — and `onRequest`, which receives the frozen request before it
 *   streams (used for the Skill cross-check). Everything about token capture,
 *   status, and the live estimate is independent of both.
 * @returns live-estimate readers used by the status route.
 */
export function installStreamInterceptor(ctx, {
  ledger,
  timeZone,
  warn = () => {},
  attribute,
  onRequest,
}) {
  /** Call id -> accumulator of a call still streaming. */
  const inFlight = new Map()
  let nextCallId = 1

  function settle(request, state) {
    const endedAt = Date.now()
    const usage = state.usage
    // Attribution only: which turn/step this call belongs to. When the turn
    // collector has no live step (a Host started mid-turn), the row keeps the
    // slice-1 placeholder instead of inventing a number.
    const where = typeof attribute === 'function' ? attribute(request?.sessionId) : undefined
    const record = {
      sessionId: typeof request?.sessionId === 'string' ? request.sessionId : '',
      turn: where?.turn ?? 0,
      step: where?.step ?? 0,
      model: textOf(request?.model),
      provider: textOf(request?.provider),
      // Convention 2: inputTokens is uncached input only. Cache reads and cache
      // writes stay in their own buckets and are never folded into it.
      inputTokens: countOf(usage?.inputTokens),
      cacheReadTokens: countOf(usage?.cacheReadTokens),
      cacheWriteTokens: countOf(usage?.cacheWriteTokens),
      outputTokens: countOf(usage?.outputTokens),
      // Convention 3: display only; already inside outputTokens.
      reasoningTokens: countOf(usage?.reasoningTokens),
      timestamp: isoWithOffset(state.startedAt, timeZone),
      durationMs: Math.max(0, endedAt - state.startedAt),
      status: classify(request, state),
    }
    ledger.append(record)
    return record
  }

  function observe(request, next) {
    // Frozen-request inspection (Skill cross-check). It reads the request and
    // records; a failure here can never disturb the stream or the ledger.
    if (typeof onRequest === 'function') {
      try {
        onRequest(request)
      } catch (error) {
        warn(`request inspection failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const callId = nextCallId++
    const state = {
      callId,
      startedAt: Date.now(),
      model: textOf(request?.model),
      provider: textOf(request?.provider),
      chars: 0,
      usage: undefined,
      finishKind: undefined,
      endedNormally: false,
    }
    inFlight.set(callId, state)

    return (async function* observeStream() {
      try {
        for await (const chunk of next()) {
          observeChunk(chunk, state)
          yield chunk
        }
        state.endedNormally = true
      } finally {
        inFlight.delete(callId)
        try {
          settle(request, state)
        } catch (error) {
          warn(`settle failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })()
  }

  ctx.effect(
    () => ctx.on(EVENT_NAME, (request, next) => {
      // Auxiliary calls have no assistant/message: they are outside this slice.
      if (request !== null && typeof request === 'object' && request.purpose !== undefined) {
        return next()
      }
      return observe(request, next)
    }),
    'dsh-usage-lens: llm/stream interceptor',
  )

  /** Snapshot of the live estimate; display only, never persisted. */
  function liveSnapshot() {
    let estimatedTokens = 0
    let oldestStartedAt
    for (const state of inFlight.values()) {
      estimatedTokens += Math.ceil(state.chars / CHARS_PER_TOKEN)
      if (oldestStartedAt === undefined || state.startedAt < oldestStartedAt) {
        oldestStartedAt = state.startedAt
      }
    }
    return { calls: inFlight.size, estimatedTokens, oldestStartedAt }
  }

  return { liveSnapshot }
}
