/**
 * Raw-data route: the third layer of the execution block.
 *
 * Nothing here is in the polling document. A single payload is served only when
 * a person clicks "查看原始", so a long session keeps its poll cheap and its
 * raw content opt-in.
 *
 * @module dsh-usage-lens/lib/raw-route
 */

import { registerGetRoute, readQuery } from './http.js'

const KINDS = new Set(['args', 'result', 'request', 'skill'])

function integer(value) {
  if (typeof value !== 'string' || !/^-?\d+$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/**
 * Register the raw route on the composed Web carrier.
 * @param ctx - plugin context.
 * @param options - `path`, `collector`, `warn`.
 */
export function registerRawRoute(ctx, options) {
  const { path, collector, warn = () => {} } = options

  registerGetRoute(ctx, {
    path,
    name: 'raw',
    warn,
    handle: async (req) => {
      const query = readQuery(req)
      const sessionId = query.get('sessionId')
      const kind = query.get('kind')
      const turn = integer(query.get('turn'))
      const step = integer(query.get('step'))
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { status: 400, body: { ok: false, error: 'session-required' } }
      }
      if (typeof kind !== 'string' || !KINDS.has(kind)) {
        return { status: 400, body: { ok: false, error: 'kind-invalid' } }
      }
      if (turn === undefined || step === undefined) {
        return { status: 400, body: { ok: false, error: 'step-required' } }
      }
      const payload = typeof collector?.raw === 'function'
        ? collector.raw(sessionId, {
          turn,
          step,
          kind,
          callId: query.get('callId') ?? undefined,
          name: query.get('name') ?? undefined,
        })
        : undefined
      if (payload === undefined) {
        return { status: 404, body: { ok: false, error: 'raw-unavailable' } }
      }
      return { body: { ok: true, kind, turn, step, ...payload } }
    },
  })
}
