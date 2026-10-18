/**
 * Shared plumbing for the plugin's Host JSON routes.
 *
 * Only two routes exist: the day aggregate behind the status bar, and the
 * per-session turn projection behind the detail panel. Both accept a same-
 * machine browser request only and answer with JSON.
 *
 * @module dsh-usage-lens/lib/http
 */

/** Write one JSON response. */
export function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

function hostnameOfHost(host) {
  let hostname = String(host ?? '').trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && !hostname.slice(0, colon).includes(':') && /^\d+$/u.test(hostname.slice(colon + 1))) {
    hostname = hostname.slice(0, colon)
  }
  return hostname
}

function isLoopbackHostname(hostname) {
  if (hostname === '' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname)
}

/**
 * Accept only a same-machine browser request: the Host header must name
 * loopback, and a present Origin must name loopback too. These routes expose no
 * authority, but a drive-by page must not be able to read local usage either.
 */
export function isTrustedRequest(req) {
  if (!isLoopbackHostname(hostnameOfHost(req.headers?.host))) return false
  const origin = req.headers?.origin
  if (origin === undefined) return true
  try {
    return isLoopbackHostname(hostnameOfHost(new URL(String(origin)).host))
  } catch {
    return false
  }
}

/** Parsed query string of one request. */
export function readQuery(req) {
  try {
    return new URL(typeof req.url === 'string' ? req.url : '/', 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

/**
 * Mount one exact GET route on the composed Web carrier.
 *
 * `handle(req)` returns `{ status, body }`; a missing status means 200. A throw
 * becomes a 500 carrying the route name, so a projection bug never leaks a
 * stack or the ledger path to the page.
 * @param ctx - plugin context.
 * @param options - `path`, `name` (diagnostics), `handle`, `warn`.
 */
export function registerGetRoute(ctx, { path, name, handle, warn = () => {} }) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
            return
          }
          if (!isTrustedRequest(req)) {
            sendJson(res, 403, { ok: false, error: 'request-not-trusted' })
            return
          }
          try {
            const result = await handle(req)
            sendJson(res, result?.status ?? 200, result?.body ?? { ok: false, error: 'empty-response' })
          } catch (error) {
            warn(`${name} failed: ${error instanceof Error ? error.message : String(error)}`)
            sendJson(res, 500, { ok: false, error: `${name}-unavailable` })
          }
        },
      })
      return () => {
        Promise.resolve(dispose()).catch((error) => {
          warn(`${name} route dispose failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    }, `dsh-usage-lens: ${name} route`)
  })
}
