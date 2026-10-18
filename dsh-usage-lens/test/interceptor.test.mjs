/**
 * In-process harness for the shipped Host code: it mounts the real `apply()`
 * against a fake Cordis context, feeds synthetic `llm/stream` calls through the
 * listener the plugin registered, and then reads the real ledger file and the
 * real status route.
 *
 * This is how failure and cancellation are exercised deterministically: a
 * provider `finish { kind: 'error' }` chunk, and a consumer that abandons the
 * stream after aborting its signal (exactly what the agent loop does).
 *
 *   node test/interceptor.test.mjs
 *
 * @module dsh-usage-lens/test/interceptor
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

let checks = 0
const failures = []

function check(label, actual, expected) {
  checks += 1
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) failures.push(`${label}\n  expected ${e}\n  actual   ${a}`)
}

function close(label, actual, expected, tolerance = 1e-9) {
  checks += 1
  if (typeof actual !== 'number' || Math.abs(actual - expected) > tolerance) {
    failures.push(`${label}\n  expected ${expected}\n  actual   ${actual}`)
  }
}

/** Minimal Cordis surface used by the Host half. */
function createFakeContext() {
  const listeners = new Map()
  const routes = []
  const disposers = []
  const ctx = {
    effect(callback) {
      disposers.push(callback())
      return () => {}
    },
    on(name, listener) {
      listeners.set(name, listener)
      return () => {}
    },
    inject(dependencies, callback) {
      if (dependencies.includes('webServer')) callback(ctx)
      return () => {}
    },
    get() {
      return undefined
    },
    logger() {
      return { warn() {}, info() {} }
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => Promise.resolve()
      },
    },
  }
  return { ctx, listeners, routes, disposers }
}

function fromChunks(chunks) {
  return (async function* source() {
    for (const chunk of chunks) yield chunk
  })()
}

function captureResponse() {
  const captured = { status: 0, headers: undefined, body: '' }
  return {
    captured,
    res: {
      writeHead(status, headers) {
        captured.status = status
        captured.headers = headers
      },
      end(body) {
        captured.body = body
      },
    },
  }
}

const dir = await mkdtemp(join(tmpdir(), 'usage-lens-interceptor-'))
try {
  const { ctx, listeners, routes } = createFakeContext()
  apply(ctx, { ledgerDir: dir, timezone: 'Asia/Shanghai' })

  const listener = listeners.get('llm/stream')
  check('the interceptor registered on llm/stream', typeof listener, 'function')
  check('the session/event collector registered', typeof listeners.get('session/event'), 'function')
  const statusRoute = routes.find((route) => route.path === '/plugins/dsh-usage-lens/today')
  const sessionRoute = routes.find((route) => route.path === '/plugins/dsh-usage-lens/session')
  const rawRoute = routes.find((route) => route.path === '/plugins/dsh-usage-lens/raw')
  check(
    'every JSON route registered',
    [routes.length, statusRoute !== undefined, sessionRoute !== undefined, rawRoute !== undefined],
    [3, true, true, true],
  )
  check('the pre-execute observer is passive', typeof listeners.get('tools/pre-execute'), 'function')

  const baseRequest = { provider: 'deepseek-account', model: 'deepseek-flash' }

  // 1. A completed call: usage chunk then a stop finish.
  const completedChunks = [
    { type: 'text-delta', index: 0, text: 'x'.repeat(40) },
    { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 50, reasoningTokens: 20 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const completedOut = []
  for await (const chunk of listener({ ...baseRequest }, () => fromChunks(completedChunks))) {
    completedOut.push(chunk.type)
  }
  check('the interceptor passes every chunk through', completedOut, ['text-delta', 'usage', 'finish'])

  // 2. A failed call: the adapter reports a terminal error finish. No usage.
  const failedChunks = [
    { type: 'text-delta', index: 0, text: 'y'.repeat(80) },
    { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'PROVIDER' } } },
  ]
  for await (const chunk of listener({ ...baseRequest }, () => fromChunks(failedChunks))) {
    void chunk
  }

  // 3. A cancelled call: usage arrives, then the consumer aborts mid-stream.
  const controller = new AbortController()
  const cancelledRequest = { ...baseRequest, sessionId: 'session-cancel', signal: controller.signal }
  const cancelled = listener(cancelledRequest, () => fromChunks([
    { type: 'text-delta', index: 0, text: 'z'.repeat(400) },
    { type: 'usage', usage: { inputTokens: 7, cacheReadTokens: 11, cacheWriteTokens: 3, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]))
  const first = await cancelled.next()
  check('the cancelled stream started', first.value?.type, 'text-delta')
  // The provider usage report lands before the consumer aborts, so it must be
  // recorded even though the call never reaches its terminal finish.
  const second = await cancelled.next()
  check('the cancelled stream received usage', second.value?.type, 'usage')

  // While that call is still open, the live estimate must be visible.
  {
    const { captured, res } = captureResponse()
    await statusRoute.handler({ method: 'GET', headers: { host: '127.0.0.1:3631' }, url: '/plugins/dsh-usage-lens/today' }, res)
    const live = JSON.parse(captured.body).live
    check('a live call is reported while streaming', live.calls, 1)
    check('the live estimate counts delivered characters', live.estimatedTokens, 100)
  }

  controller.abort()
  await cancelled.return()

  // One auxiliary call must be ignored entirely.
  for await (const chunk of listener({ ...baseRequest, purpose: 'compaction' }, () => fromChunks(completedChunks))) {
    void chunk
  }

  // The ledger writes are queued; wait for the file to settle.
  const ledgerPath = join(dir, 'ledger-2026-10.jsonl')
  let records = []
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const text = await readFile(ledgerPath, 'utf8')
      records = text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
    } catch {
      records = []
    }
    if (records.length >= 3) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  check('one row per conversation call, auxiliary excluded', records.length, 3)
  const byStatus = Object.fromEntries(records.map((record) => [record.status, record]))
  check('settled statuses', Object.keys(byStatus).sort(), ['cancelled', 'completed', 'failed'])

  const completed = byStatus.completed
  check('completed keeps the provider buckets', {
    input: completed.inputTokens,
    cacheRead: completed.cacheReadTokens,
    output: completed.outputTokens,
    reasoning: completed.reasoningTokens,
  }, { input: 100, cacheRead: 900, output: 50, reasoning: 20 })
  check('cached input is not folded into inputTokens', completed.inputTokens, 100)

  const failed = byStatus.failed
  check('failed records no usage the provider never sent', {
    input: failed.inputTokens, output: failed.outputTokens, cacheRead: failed.cacheReadTokens,
  }, { input: 0, output: 0, cacheRead: 0 })
  check('failed keeps the request identity', failed.model, 'deepseek-flash')

  const cancelledRecord = byStatus.cancelled
  check('cancelled keeps the usage that did arrive', {
    input: cancelledRecord.inputTokens,
    cacheRead: cancelledRecord.cacheReadTokens,
    cacheWrite: cancelledRecord.cacheWriteTokens,
    output: cancelledRecord.outputTokens,
  }, { input: 7, cacheRead: 11, cacheWrite: 3, output: 5 })
  check('cancelled keeps its session id', cancelledRecord.sessionId, 'session-cancel')
  check('turn and step fall back to placeholders without session events', [cancelledRecord.turn, cancelledRecord.step], [0, 0])

  // The status document over the real ledger file.
  {
    const { captured, res } = captureResponse()
    await statusRoute.handler({ method: 'GET', headers: { host: '127.0.0.1:3631' }, url: '/plugins/dsh-usage-lens/today' }, res)
    const body = JSON.parse(captured.body)
    check('the route answers 200', captured.status, 200)
    check('every settled row is counted', body.today.calls, 3)
    check('statuses are split', body.today.statuses, { completed: 1, failed: 1, cancelled: 1 })
    // billable = 100 + 900 + 0 + 0 + (7 + 11 + 3) = 1021 ; total adds outputs 50 + 5
    check('token total counts each bucket once', body.today.tokens.billableInput, 1021)
    check('total adds output', body.today.tokens.total, 1076)
    check('the live estimate cleared after settlement', body.live, { calls: 0, estimatedTokens: 0 })
    // Sunday 2026-10-18 in Beijing is off-peak: deepseek-flash 1.0 / 0.02 / 4.0
    // (100 * 1.0 + 900 * 0.02 + 50 * 4.0) = 318 ; cancelled (10 * 1.0 + 11 * 0.02 + 5 * 4.0) = 30.22
    close('the day amount follows the off-peak row', body.today.cost.pricedAmount, (318 + 30.22) / 1e6, 1e-12)
  }

  // An unpriced model: tokens counted, money withheld, the total a lower bound.
  {
    const unpricedDir = join(dir, 'unpriced')
    const second = createFakeContext()
    apply(second.ctx, { ledgerDir: unpricedDir })
    const unpricedListener = second.listeners.get('llm/stream')
    for await (const chunk of unpricedListener(
      { provider: 'acme', model: 'mystery-1' },
      () => fromChunks([
        { type: 'usage', usage: { inputTokens: 1000, outputTokens: 500 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]),
    )) {
      void chunk
    }
    let unpricedRecords = []
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const text = await readFile(join(unpricedDir, 'ledger-2026-10.jsonl'), 'utf8')
        unpricedRecords = text.split('\n').filter((line) => line.trim() !== '')
      } catch {
        unpricedRecords = []
      }
      if (unpricedRecords.length >= 1) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const { captured, res } = captureResponse()
    await second.routes.find((route) => route.path === '/plugins/dsh-usage-lens/today').handler({ method: 'GET', headers: { host: '127.0.0.1:3631' }, url: '/' }, res)
    const body = JSON.parse(captured.body)
    check('an unpriced model is counted as unpriced', body.today.cost.unpricedCalls, 1)
    check('an unpriced model is named', body.today.cost.unpricedModels, ['acme/mystery-1'])
    check('unpriced tokens are still counted', body.today.tokens.total, 1500)
    check('no silent zero pricing', body.today.cost.pricedCalls, 0)
    check('unpriced tokens are excluded from the priced amount', body.today.cost.pricedAmount, 0)
    check('the total is marked a lower bound', body.today.cost.lowerBound, true)
  }

  // The route refuses a non-loopback origin and a non-GET method.
  {
    const { captured, res } = captureResponse()
    await statusRoute.handler({ method: 'GET', headers: { host: '127.0.0.1:3631', origin: 'https://evil.example' }, url: '/' }, res)
    check('a cross-origin read is refused', captured.status, 403)
  }
  {
    const { captured, res } = captureResponse()
    await statusRoute.handler({ method: 'POST', headers: { host: '127.0.0.1:3631' }, url: '/' }, res)
    check('a non-GET method is refused', captured.status, 405)
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`${failures.length} of ${checks} checks FAILED:\n`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log(`all ${checks} checks passed`)
