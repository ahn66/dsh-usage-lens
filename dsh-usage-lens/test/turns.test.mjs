/**
 * Slice-2 suite: turn/step attribution, the turn projection, and the panel
 * route. It runs the shipped `apply()` against a fake context, feeds real
 * `session/event` payload shapes through the registered listener, and drives
 * `llm/stream` calls through the registered interceptor.
 *
 *   node test/turns.test.mjs
 *
 * @module dsh-usage-lens/test/turns
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { projectSession } from '../lib/aggregator.js'
import { buildPricingTable } from '../lib/pricing.js'

let checks = 0
const failures = []

function check(label, actual, expected) {
  checks += 1
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) failures.push(`${label}\n  expected ${e}\n  actual   ${a}`)
}

function close(label, actual, expected, tolerance = 1e-12) {
  checks += 1
  if (typeof actual !== 'number' || Math.abs(actual - expected) > tolerance) {
    failures.push(`${label}\n  expected ${expected}\n  actual   ${actual}`)
  }
}

function createFakeContext() {
  const listeners = new Map()
  const routes = []
  const ctx = {
    effect(callback) {
      callback()
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
    webServer: {
      register(route) {
        routes.push(route)
        return () => Promise.resolve()
      },
    },
  }
  return { ctx, listeners, routes }
}

function fromChunks(chunks) {
  return (async function* source() {
    for (const chunk of chunks) yield chunk
  })()
}

function captureResponse() {
  const captured = { status: 0, body: '' }
  return {
    captured,
    res: {
      writeHead(status) {
        captured.status = status
      },
      end(body) {
        captured.body = body
      },
    },
  }
}

/** Emit one session event exactly as the Host feed would. */
function emit(listeners, sessionId, type, data, time) {
  const feed = listeners.get('session/event')
  if (feed === undefined) throw new Error('session/event listener missing')
  feed({ id: sessionId }, { type, seq: 1, time: time ?? Date.now(), data })
}

const usageChunk = (inputTokens, cacheReadTokens, outputTokens) => ({
  type: 'usage',
  usage: { inputTokens, cacheReadTokens, cacheWriteTokens: 0, outputTokens, reasoningTokens: 0 },
})

async function runCall(listeners, request, chunks) {
  const listener = listeners.get('llm/stream')
  let seen = 0
  for await (const chunk of listener(request, () => fromChunks(chunks))) {
    void chunk
    seen += 1
  }
  return seen
}

async function waitForRecords(path, count) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const text = await readFile(path, 'utf8')
      const records = text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
      if (records.length >= count) return records
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return []
}

async function readSessionRoute(routes, sessionId) {
  const route = routes.find((candidate) => candidate.path === '/plugins/dsh-usage-lens/session')
  const { captured, res } = captureResponse()
  await route.handler({
    method: 'GET',
    headers: { host: '127.0.0.1:3631' },
    url: `/plugins/dsh-usage-lens/session?sessionId=${encodeURIComponent(sessionId)}`,
  }, res)
  return { status: captured.status, body: JSON.parse(captured.body) }
}

const dir = await mkdtemp(join(tmpdir(), 'usage-lens-turns-'))
try {
  const { ctx, listeners, routes } = createFakeContext()
  apply(ctx, { ledgerDir: dir })

  // --- one turn, three steps, real tool round trips ------------------------
  const main = 'session-main'
  emit(listeners, main, 'turn/start', { turn: 7 })
  emit(listeners, main, 'step/start', { turn: 7, step: 1 })
  emit(listeners, main, 'tool/call', { turn: 7, step: 1, callId: 'c1', name: 'read', arguments: '{}' })
  await runCall(listeners, { provider: 'deepseek-account', model: 'deepseek-flash', sessionId: main }, [
    { type: 'text-delta', index: 0, text: 'hello' },
    usageChunk(1000, 9000, 200),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])
  emit(listeners, main, 'assistant/message', { turn: 7, step: 1, message: {}, usage: { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 200 } })
  emit(listeners, main, 'step/end', { turn: 7, step: 1 })

  emit(listeners, main, 'step/start', { turn: 7, step: 2 })
  emit(listeners, main, 'tool/call', { turn: 7, step: 2, callId: 'c2', name: 'bash', arguments: '{}' })
  await runCall(listeners, { provider: 'deepseek-account', model: 'deepseek-flash', sessionId: main }, [
    usageChunk(500, 9500, 300),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])
  emit(listeners, main, 'step/end', { turn: 7, step: 2 })

  emit(listeners, main, 'step/start', { turn: 7, step: 3 })
  await runCall(listeners, { provider: 'deepseek-account', model: 'deepseek-flash', sessionId: main }, [
    usageChunk(120, 9900, 80),
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  emit(listeners, main, 'step/end', { turn: 7, step: 3 })
  emit(listeners, main, 'turn/end', { turn: 7, reason: { kind: 'completed' } })

  // --- a second turn on the same session ----------------------------------
  emit(listeners, main, 'turn/start', { turn: 8 })
  emit(listeners, main, 'step/start', { turn: 8, step: 1 })
  await runCall(listeners, { provider: 'deepseek-account', model: 'deepseek-flash', sessionId: main }, [
    usageChunk(50, 10000, 40),
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  emit(listeners, main, 'step/end', { turn: 8, step: 1 })
  emit(listeners, main, 'turn/end', { turn: 8, reason: { kind: 'completed' } })

  // --- an interrupted turn: turn/end never arrives ------------------------
  emit(listeners, main, 'turn/start', { turn: 9 })
  emit(listeners, main, 'step/start', { turn: 9, step: 1 })
  await runCall(listeners, { provider: 'deepseek-account', model: 'deepseek-flash', sessionId: main }, [
    { type: 'text-delta', index: 0, text: 'partial' },
    usageChunk(30, 11000, 10),
    { type: 'finish', reason: { kind: 'aborted', failure: { message: 'stopped', code: 'ABORTED' } } },
  ])
  // No turn/end, no assistant/message, no step/end: the turn stays open and
  // the call that did settle must still be attributed to turn 9 / step 1.

  // --- a concurrent subagent session ------------------------------------
  const child = 'session-child'
  emit(listeners, child, 'turn/start', { turn: 1 })
  emit(listeners, child, 'step/start', { turn: 1, step: 1 })
  // The parent's in-flight turn must not be borrowed by the child, and vice versa.
  await runCall(listeners, { provider: 'deepseek-account', model: 'deepseek-v4-pro', sessionId: child }, [
    usageChunk(700, 0, 90),
    { type: 'finish', reason: { kind: 'stop' } },
  ])

  const records = await waitForRecords(join(dir, 'ledger-2026-10.jsonl'), 6)
  check('every settled call is recorded', records.length, 6)

  const mainRows = records.filter((record) => record.sessionId === main)
  check('parent rows only', mainRows.length, 5)
  check('parent turn/step attribution', mainRows.map((record) => [record.turn, record.step]), [
    [7, 1], [7, 2], [7, 3], [8, 1], [9, 1],
  ])
  check('turn numbers are monotonically non-decreasing', mainRows.every((record, index) => index === 0 || record.turn >= mainRows[index - 1].turn), true)
  check('steps restart at 1 in every turn', mainRows.filter((record) => record.step === 1).length, 3)
  check('the interrupted call is still attributed', [mainRows[4].turn, mainRows[4].step, mainRows[4].status], [9, 1, 'cancelled'])
  check('a call that never settles writes nothing', records.filter((record) => record.turn === 9).length, 1)

  const childRows = records.filter((record) => record.sessionId === child)
  check('the child session keeps its own turn/step', childRows.map((record) => [record.turn, record.step, record.model]), [[1, 1, 'deepseek-v4-pro']])
  check('the child never borrows the parent turn', childRows[0].turn, 1)

  // --- the panel projection ---------------------------------------------
  const panel = await readSessionRoute(routes, main)
  check('the session route answers 200', panel.status, 200)
  check('turns are newest first', panel.body.turns.map((turn) => turn.turn), [9, 8, 7])

  const turn7 = panel.body.turns.find((turn) => turn.turn === 7)
  check('turn 7 has one row per call', turn7.calls, 3)
  check('turn 7 step order', turn7.steps.map((step) => step.step), [1, 2, 3])
  check('turn 7 tools per step', turn7.steps.map((step) => step.tools), [['read'], ['bash'], []])
  check('turn 7 distinct tools', [turn7.toolCount, turn7.tools], [2, ['read', 'bash']])
  check('turn 7 is closed with its reason', [turn7.open, turn7.reason], [false, 'completed'])

  // Acceptance 2: the card totals are the sums of the expanded rows.
  const sum = (steps, pick) => steps.reduce((total, step) => total + pick(step), 0)
  check('card total tokens equal the sum of rows', turn7.tokens.total, sum(turn7.steps, (step) => step.tokens.total))
  check('card billable input equals the sum of rows', turn7.tokens.billableInput, sum(turn7.steps, (step) => step.tokens.billableInput))
  close('card amount equals the sum of rows', turn7.cost.pricedAmount, sum(turn7.steps, (step) => step.cost.amount), 1e-12)
  check('card output equals the sum of rows', turn7.tokens.output, 200 + 300 + 80)
  check('card input equals the sum of rows', turn7.tokens.input, 1000 + 500 + 120)

  const turn9 = panel.body.turns.find((turn) => turn.turn === 9)
  check('an interrupted turn is reported open', turn9.open, true)
  check('the interrupted turn keeps its settled call', turn9.calls, 1)
  check('the interrupted call is flagged', [turn9.steps[0].status, turn9.steps[0].failed], ['cancelled', true])
  check('turn statuses are counted', turn9.statuses, { completed: 0, failed: 0, cancelled: 1 })

  // --- the aggregation is pure: price changes reprice history -------------
  const table = buildPricingTable()
  const projected = projectSession({ records: mainRows, turns: [], pricing: table })
  const withoutCollector = projectSession({ records: mainRows, turns: [], pricing: table })
  check('projection is deterministic', JSON.stringify(projected), JSON.stringify(withoutCollector))
  check('a missing collector only loses tool names', projected.find((turn) => turn.turn === 7).tools, [])
  check('a missing collector keeps the token totals', projected.find((turn) => turn.turn === 7).tokens.total, turn7.tokens.total)
  const cheaper = buildPricingTable({ models: { 'deepseek-flash': { offPeak: { cacheMiss: 0.5 } } } })
  const repriced = projectSession({ records: mainRows, turns: [], pricing: cheaper })
  check(
    'a price-table change reprices an existing turn',
    repriced.find((turn) => turn.turn === 7).cost.pricedAmount < turn7.cost.pricedAmount,
    true,
  )

  // --- route guards ------------------------------------------------------
  {
    const route = routes.find((candidate) => candidate.path === '/plugins/dsh-usage-lens/session')
    const { captured, res } = captureResponse()
    await route.handler({ method: 'GET', headers: { host: '127.0.0.1:3631' }, url: '/plugins/dsh-usage-lens/session' }, res)
    check('a missing session id is refused', captured.status, 400)
  }
  {
    const route = routes.find((candidate) => candidate.path === '/plugins/dsh-usage-lens/session')
    const { captured, res } = captureResponse()
    await route.handler({ method: 'GET', headers: { host: 'evil.example' }, url: '/plugins/dsh-usage-lens/session?sessionId=x' }, res)
    check('a non-loopback host is refused', captured.status, 403)
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
