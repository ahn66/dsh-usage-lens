/**
 * Slice-3 suite: frozen-request Skill cross-validation, the four pinned key-step
 * rules, the folded process flow, and the on-demand raw layer.
 *
 * It runs the shipped `apply()` against a fake context, feeds real
 * `session/event` payload shapes through the collector, and drives `llm/stream`
 * requests whose message bodies carry the canonical `<skill_content>` block the
 * harness renders.
 *
 *   node test/process.test.mjs
 *
 * @module dsh-usage-lens/test/process
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { parseRequestSkills } from '../lib/skill-parse.js'
import { projectProcess } from '../lib/process.js'

let checks = 0
const failures = []

function check(label, actual, expected) {
  checks += 1
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) failures.push(`${label}\n  expected ${e}\n  actual   ${a}`)
}

function includes(label, actual, needle) {
  checks += 1
  if (typeof actual !== 'string' || !actual.includes(needle)) {
    failures.push(`${label}\n  expected to include ${JSON.stringify(needle)}\n  actual   ${JSON.stringify(actual)}`)
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

function emit(listeners, sessionId, type, data, time = Date.now()) {
  listeners.get('session/event')({ id: sessionId }, { type, seq: 1, time, data })
}

async function stream(listeners, request, chunks = [
  { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 } },
  { type: 'finish', reason: { kind: 'stop' } },
]) {
  for await (const chunk of listeners.get('llm/stream')(request, () => fromChunks(chunks))) void chunk
}

async function get(routes, path, query) {
  const route = routes.find((candidate) => candidate.path === path)
  const { captured, res } = captureResponse()
  const search = query === undefined ? '' : `?${new URLSearchParams(query).toString()}`
  await route.handler({ method: 'GET', headers: { host: '127.0.0.1:3631' }, url: `${path}${search}` }, res)
  return { status: captured.status, body: JSON.parse(captured.body) }
}

/** The canonical block the harness renders for a loaded skill. */
function skillBlock(name, body) {
  return [
    `<skill_content name="${name}">`,
    '<skill_resources>',
    `Base directory for this skill: /skills/${name}`,
    '</skill_resources>',
    '<skill_instructions>',
    body,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

function requestWith(sessionId, texts = [], extra = {}) {
  return {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    sessionId,
    system: 'system prompt',
    messages: texts.map((text, index) => (index === 0
      ? { role: 'user', content: [{ type: 'text', text }] }
      : { role: 'tool', content: [{ type: 'text', text }] })),
    ...extra,
  }
}

// Long payloads with a marker past each summary cap, so "the raw layer is not
// in the polling document" can be checked by text rather than by field name.
const TAIL_RESULT = 'TAIL-RESULT-MARKER'
const TAIL_ARGS = 'TAIL-ARGS-MARKER'
const TAIL_SKILL = 'TAIL-SKILL-MARKER'
const SKILL_RESULT = skillBlock('office-recalculate', `Recalc body line. ${'y'.repeat(400)} ${TAIL_SKILL}`)
const BAD_ARGS = JSON.stringify({ path: 'nope.txt', note: `${'z'.repeat(220)} ${TAIL_ARGS}` })
const BAD_RESULT = `Error: cannot read "nope.txt": not found ${'x'.repeat(300)} ${TAIL_RESULT}`

// --- pure parsing ----------------------------------------------------------

{
  const request = requestWith('s', [
    'please do the thing',
    skillBlock('office-recalculate', 'Run the recalc sidecar. Step one.'),
    '<available_skills>\n- `office-xlsx`: spreadsheets\n</available_skills>',
  ])
  const parsed = parseRequestSkills(request)
  check('one block per loaded skill', parsed.length, 1)
  check('the skill name is decoded', parsed[0].name, 'office-recalculate')
  includes('the instruction body is kept', parsed[0].body, 'Run the recalc sidecar')
  check('the catalog is not a load', parsed.some((skill) => skill.name === 'office-xlsx'), false)
  check('a tool-result load is tagged', parsed[0].source, 'tool')
}
{
  const parsed = parseRequestSkills(requestWith('s', [skillBlock('office.xlsx:v2', 'body')]))
  check('a dotted and namespaced id is kept', parsed[0]?.name, 'office.xlsx:v2')
}
{
  // An escaped placeholder decodes to something that is not a skill id, so the
  // block is documentation rather than a load.
  check('a name that is not an id is ignored', parseRequestSkills(requestWith('s', [skillBlock('a&amp;b', 'body')])), [])
}
{
  // Documentation that quotes the format must never look like a load.
  const doc = [
    '```markdown',
    '<skill_content name="<escaped-name>">',
    '<skill_resources><resource-guidance></skill_resources>',
    '<skill_instructions><provider-owned-instruction-body></skill_instructions>',
    '</skill_content>',
    '```',
  ].join('\n')
  check('a quoted template is not a load', parseRequestSkills(requestWith('s', [doc])), [])
  const placeholder = skillBlock('office-xlsx', 'real body <provider-owned-instruction-body>')
  check('a placeholder body is not a load', parseRequestSkills(requestWith('s', [placeholder])), [])
}
{
  check('an ordinary request carries no skills', parseRequestSkills(requestWith('s', ['hello'])), [])
  check('a non-object request is safe', parseRequestSkills(undefined), [])
}

// --- the collector, the pins, and the projection ---------------------------

const dir = await mkdtemp(join(tmpdir(), 'usage-lens-process-'))
try {
  const { ctx, listeners, routes } = createFakeContext()
  apply(ctx, { ledgerDir: dir })
  const session = 'session-process'

  // one turn, four steps. Real order: the model call of a step happens BEFORE
  // that step's tool calls, so a skill load can only be seen by a LATER request.
  emit(listeners, session, 'turn/start', { turn: 4 })

  // step 1: request, then a `skill` tool call whose result carries the body
  emit(listeners, session, 'step/start', { turn: 4, step: 1 })
  await stream(listeners, requestWith(session, ['go']))
  emit(listeners, session, 'tool/call', { turn: 4, step: 1, callId: 'c-skill', name: 'skill', arguments: JSON.stringify({ name: 'office-recalculate' }) })
  emit(listeners, session, 'tool/result', {
    turn: 4,
    step: 1,
    message: { toolCallId: 'c-skill', isError: false, content: [{ type: 'text', text: SKILL_RESULT }] },
  })
  emit(listeners, session, 'step/end', { turn: 4, step: 1 })

  // step 2: the next request DOES contain the skill -> verified
  emit(listeners, session, 'step/start', { turn: 4, step: 2 })
  await stream(listeners, requestWith(session, ['go', SKILL_RESULT]))
  emit(listeners, session, 'step/end', { turn: 4, step: 2 })

  let document = await get(routes, '/plugins/dsh-usage-lens/session', { sessionId: session })
  check('the session route answers', document.status, 200)
  check('the process block exists', document.body.process !== undefined, true)
  const skillPin = document.body.process.pins.find((pin) => pin.kind === 'skill-loaded')
  check('a verified skill load is pinned', skillPin?.name, 'office-recalculate')
  check('the verified pin cites the tool-call step', skillPin?.step, 1)
  check('no ineffective pin when the skill did reach the request', document.body.process.pins.some((pin) => pin.kind === 'skill-not-effective'), false)

  // step 3: a skill load that NEVER reaches a request -> 调用未生效
  emit(listeners, session, 'step/start', { turn: 4, step: 3 })
  await stream(listeners, requestWith(session, ['go', SKILL_RESULT]))
  emit(listeners, session, 'tool/call', { turn: 4, step: 3, callId: 'c-ghost', name: 'skill', arguments: JSON.stringify({ name: 'ghost-skill' }) })
  emit(listeners, session, 'tool/result', {
    turn: 4,
    step: 3,
    message: { toolCallId: 'c-ghost', isError: false, content: [{ type: 'text', text: skillBlock('ghost-skill', 'Ghost body.') }] },
  })
  emit(listeners, session, 'step/end', { turn: 4, step: 3 })

  // step 4: the next request never mentions ghost-skill, so the claim fails
  emit(listeners, session, 'step/start', { turn: 4, step: 4 })
  await stream(listeners, requestWith(session, ['go', SKILL_RESULT]))

  document = await get(routes, '/plugins/dsh-usage-lens/session', { sessionId: session })
  const ghostPin = document.body.process.pins.find((pin) => pin.name === 'ghost-skill')
  check('a skill absent from the next request is marked ineffective', ghostPin?.kind, 'skill-not-effective')
  check('the ineffective pin keeps the tool-call step', ghostPin?.step, 3)
  check('the ineffective pin carries an error tone', ghostPin?.tone, 'error')

  // step 4 continues with a failing tool, a denied approval, and a sub-agent
  emit(listeners, session, 'tool/call', { turn: 4, step: 4, callId: 'c-bad', name: 'read', arguments: BAD_ARGS })
  emit(listeners, session, 'tool/result', {
    turn: 4,
    step: 4,
    message: { toolCallId: 'c-bad', isError: true, content: [{ type: 'text', text: BAD_RESULT }] },
    error: { name: 'FsError', code: 'FS_NOT_FOUND' },
  })
  emit(listeners, session, 'approval/asked', { id: 'ap-1', toolName: 'pwsh', callId: 'c-pwsh', reason: 'escalate sandbox to danger-full-access' })
  emit(listeners, session, 'approval/decided', { id: 'ap-1', outcome: 'rejected' })
  emit(listeners, session, 'subagent/catalog', { version: 0, childId: 'child-1', childCreatedAt: 1, mode: 'continuable', label: 'child probe' })
  emit(listeners, session, 'step/end', { turn: 4, step: 4 })
  emit(listeners, session, 'turn/end', { turn: 4, reason: { kind: 'completed' } })

  // the passive pre-execute observer records a sandbox denial, unchanged decision
  {
    const observer = listeners.get('tools/pre-execute')
    const decision = { kind: 'deny', reason: 'sandbox: file access denied under workspace-write mode' }
    const returned = await observer({ agent: { id: session }, callId: 'c-denied', name: 'write' }, async () => decision)
    check('the pre-execute observer returns the decision unchanged', returned, decision)
  }

  document = await get(routes, '/plugins/dsh-usage-lens/session', { sessionId: session })
  const process = document.body.process
  check('the process block follows the turn', process.turn, 4)
  check('a failed tool is pinned', process.pins.find((pin) => pin.kind === 'tool-error')?.name, 'read')
  check('the failure pin carries the error code', process.pins.find((pin) => pin.kind === 'tool-error')?.detail, 'FS_NOT_FOUND')
  check('a denied approval is pinned', process.pins.find((pin) => pin.kind === 'approval-denied')?.name, 'pwsh')
  check('the denied approval names its outcome', process.pins.find((pin) => pin.kind === 'approval-denied')?.detail, 'rejected')
  check('the approval pin is an error', process.pins.find((pin) => pin.kind === 'approval-denied')?.tone, 'error')
  check('the ask was pinned before the outcome arrived', process.pins.some((pin) => pin.kind === 'approval-asked'), false)
  check('a permission denial is pinned', process.pins.find((pin) => pin.kind === 'permission-denied')?.name, 'write')
  check('a sub-agent dispatch is pinned', process.pins.find((pin) => pin.kind === 'subagent')?.name, 'child probe')
  check('the sub-agent pin carries the child id', process.pins.find((pin) => pin.kind === 'subagent')?.detail, 'child-1')
  check(
    'one pin per fired rule (two skills, one of each verdict)',
    process.pins.map((pin) => pin.kind).sort(),
    ['approval-denied', 'permission-denied', 'skill-loaded', 'skill-not-effective', 'subagent', 'tool-error'],
  )

  check('four steps in the flow', process.steps.length, 4)
  check('steps ascend', process.steps.map((step) => step.step), [1, 2, 3, 4])
  const step1 = process.steps[0]
  check('a step lists its tool call', step1.tools.map((tool) => tool.name), ['skill'])
  includes('a tool call keeps its argument summary', step1.tools[0].argsSummary, 'office-recalculate')
  includes('a tool call keeps its result summary', step1.tools[0].resultSummary, 'office-recalculate')
  check('a successful call is not an error', step1.tools[0].isError, false)
  const step4 = process.steps[3]
  check('the failing call is flagged', step4.tools[0].isError, true)
  check('the failing call keeps its code', step4.tools[0].errorCode, 'FS_NOT_FOUND')
  check('the step carries the request envelope', step4.request?.provider, 'deepseek-account')
  check('the step is not marked failed for a tool error alone', step4.failed, false)

  // --- the raw layer is opt-in and separate ------------------------------
  const rawArgs = await get(routes, '/plugins/dsh-usage-lens/raw', { sessionId: session, turn: 4, step: 4, kind: 'args', callId: 'c-bad' })
  check('raw arguments are served on request', rawArgs.status, 200)
  includes('raw arguments are the submitted JSON', rawArgs.body.text, TAIL_ARGS)
  const rawResult = await get(routes, '/plugins/dsh-usage-lens/raw', { sessionId: session, turn: 4, step: 4, kind: 'result', callId: 'c-bad' })
  includes('raw results are served on request', rawResult.body.text, TAIL_RESULT)
  const rawSkill = await get(routes, '/plugins/dsh-usage-lens/raw', { sessionId: session, turn: 4, step: 1, kind: 'skill', name: 'office-recalculate' })
  includes('raw skill text is served on request', rawSkill.body.text, TAIL_SKILL)
  const rawRequest = await get(routes, '/plugins/dsh-usage-lens/raw', { sessionId: session, turn: 4, step: 4, kind: 'request' })
  includes('the raw request envelope is served on request', rawRequest.body.text, 'deepseek-flash')
  {
    const missing = await get(routes, '/plugins/dsh-usage-lens/raw', { sessionId: session, turn: 4, step: 9, kind: 'args', callId: 'nope' })
    check('an unknown raw payload is a 404', missing.status, 404)
    const badKind = await get(routes, '/plugins/dsh-usage-lens/raw', { sessionId: session, turn: 4, step: 1, kind: 'secret' })
    check('an unknown raw kind is a 400', badKind.status, 400)
  }
  {
    // The polling document keeps only bounded summaries, so every marker past a
    // summary cap must be absent — it lives behind the raw route alone.
    const text = JSON.stringify(document.body)
    check('the polling document carries no raw arguments tail', text.includes(TAIL_ARGS), false)
    check('the polling document carries no raw result tail', text.includes(TAIL_RESULT), false)
    check('the polling document carries no raw skill body tail', text.includes(TAIL_SKILL), false)
    check('the polling document carries no raw fields at all',
      ['argsRaw', 'resultRaw', '"body"'].some((field) => text.includes(field)), false)
  }

  // --- the projection is pure and turn-scoped ----------------------------
  {
    const isolated = projectProcess({ turn: { turn: 9, steps: [] }, records: [], pins: [] })
    check('an empty turn projects an empty flow', [isolated.steps.length, isolated.pins.length], [0, 0])
    const other = projectProcess({
      turn: { turn: 5, steps: [{ step: 1, tools: ['read'], calls: [{ callId: 'x', name: 'read' }], reasoning: 'r' }] },
      records: [],
      pins: [{ id: 'p', kind: 'tool-error', tone: 'error', turn: 4, step: 1, name: 'read', detail: 'x' }],
    })
    check('pins of another turn are excluded', other.pins.length, 0)
    includes('a step keeps its reasoning snippet', other.steps[0].reasoning, 'r')
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
