/**
 * Slice-3 UI suite: the "执行过程" block.
 *
 * It renders the shipped panel against a crafted session document (so the four
 * pin kinds, the folded flow and the raw layer can all be asserted) and checks
 * what the acceptance criteria name: badges for every pin kind, a click that
 * jumps to the failing step's full result, collapsed-by-default flow rows with
 * input/output summaries on expand, raw content invisible until asked for, and a
 * sticky pinned layer.
 *
 *   node test/process-ui.test.mjs
 *
 * @module dsh-usage-lens/test/process-ui
 */

import { createHooks, findAllByAttr, findAllByClass, findByClass, flattenText, installBrowser } from './hooks.mjs'

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

function excludes(label, actual, needle) {
  checks += 1
  if (typeof actual === 'string' && actual.includes(needle)) {
    failures.push(`${label}\n  expected NOT to include ${JSON.stringify(needle)}\n  actual   ${JSON.stringify(actual)}`)
  }
}

// --- fixture: one turn, four steps, all four pin kinds ---------------------

const step = (n, extra) => ({
  step: n,
  startedAt: 1792300000000 + n * 1000,
  endedAt: 1792300000000 + n * 1000 + 2500,
  durationMs: 2500,
  model: 'deepseek-flash',
  tokens: { input: 100, cacheRead: 9000, cacheWrite: 0, output: 200, reasoning: 0, billableInput: 9100, total: 9300 },
  status: 'completed',
  failed: false,
  reasoning: '',
  text: '',
  skills: [],
  request: { provider: 'deepseek-account', model: 'deepseek-flash', messages: 12, systemChars: 4000, tools: 20, skills: [] },
  tools: [],
  ...extra,
})

const sessionDocument = {
  ok: true,
  sessionId: 'session-ui',
  pricingVersion: 'builtin-2026-10-18',
  turns: [{
    turn: 5,
    attributed: true,
    open: false,
    reason: 'completed',
    calls: 4,
    statuses: { completed: 4, failed: 0, cancelled: 0 },
    tokens: { input: 400, cacheRead: 36000, cacheWrite: 0, output: 800, reasoning: 0, billableInput: 36400, total: 37200 },
    cost: { pricedAmount: 0.01, pricedCalls: 4, unpricedCalls: 0, unpricedTokens: 0, unpricedModels: [], lowerBound: false },
    toolCount: 3,
    tools: ['skill', 'read', 'pwsh'],
    steps: [],
  }],
  process: {
    turn: 5,
    open: false,
    reason: 'completed',
    pins: [
      { id: 'p1', kind: 'skill-loaded', tone: 'ok', turn: 5, step: 1, name: 'office-recalculate', detail: 'request:5/2' },
      { id: 'p2', kind: 'skill-not-effective', tone: 'error', turn: 5, step: 2, name: 'ghost-skill', detail: 'absent' },
      { id: 'p3', kind: 'tool-error', tone: 'error', turn: 5, step: 3, name: 'read', detail: 'FS_NOT_FOUND', callId: 'c-bad' },
      { id: 'p4', kind: 'approval-denied', tone: 'error', turn: 5, step: 4, name: 'pwsh', detail: 'rejected' },
      { id: 'p5', kind: 'permission-denied', tone: 'warn', turn: 5, step: 4, name: 'write', detail: 'sandbox denied' },
      { id: 'p6', kind: 'subagent', tone: 'info', turn: 5, step: 4, name: 'child probe', detail: 'child-1' },
    ],
    steps: [
      step(1, {
        tools: [{ callId: 'c-skill', name: 'skill', argsSummary: '{"name":"office-recalculate"}', resultSummary: '<skill_content name="office-recalculate">', isError: false, durationMs: 400 }],
        skills: ['office-recalculate'],
      }),
      step(2, { reasoning: '需要先读文件再改。', tools: [] }),
      step(3, {
        failed: true,
        status: 'failed',
        tools: [{
          callId: 'c-bad',
          name: 'read',
          argsSummary: '{"path":"nope.txt"}',
          resultSummary: 'Error: cannot read "nope.txt": not found',
          isError: true,
          errorCode: 'FS_NOT_FOUND',
          durationMs: 120,
        }],
      }),
      step(4, {
        tools: [{
          callId: 'c-pwsh',
          name: 'pwsh',
          argsSummary: '{"command":"rm -rf /tmp/x"}',
          resultSummary: '[sandbox: file access denied under workspace-write mode]',
          isError: true,
          errorCode: 'SANDBOX_DENIED',
          durationMs: 900,
        }],
      }),
    ],
    truncated: false,
  },
}

const RAW_TEXT = {
  'result:c-skill': 'FULL-RAW-SKILL-RESULT: <skill_content name="office-recalculate">',
  'args:c-skill': '{"name":"office-recalculate"}',
  'result:c-bad': 'FULL-RAW-RESULT-BODY: Error: cannot read "nope.txt": not found',
  'args:c-bad': '{"path":"nope.txt","FULL":"ARGS-BODY"}',
  'args:c-pwsh': '{"command":"rm -rf /tmp/x"}',
  'result:c-pwsh': 'FULL-RAW-SANDBOX-BODY',
}

// --- load the bundle -------------------------------------------------------

const { styles } = installBrowser()
await import('../client.js')
const definition = globalThis.__usageLensDefinition

const hooks = createHooks()
const plugin = definition.factory((name) => (name === 'react' ? hooks.React : undefined))

const registrations = []
const localeStub = { getLocale: () => ({ active: 'zh' }), subscribe: () => () => {} }
plugin.apply({
  get: (name) => (name === 'locale' ? localeStub : undefined),
  effect: (callback) => {
    callback()
    return () => {}
  },
  slots: {
    inject: (key, callback) => registrations.push({ key, cell: callback() }),
    register: (options, component) => ({ options, component }),
  },
})

const stylesheet = styles.map((style) => style.textContent).join('\n')
check('the pinned layer is sticky', /\.dsh-usage-lens-pins\{[^}]*position:sticky/u.test(stylesheet), true)
includes('the pinned layer pins to the top', stylesheet, 'top:0')
includes('the raw block caps its height and scrolls', stylesheet, 'max-height:180px')
includes('the raw block scrolls', stylesheet, '.dsh-usage-lens-raw{')

const Cell = registrations[0].cell.component
const Panel = registrations[1].cell.component

const rawCalls = []
globalThis.fetch = async (url) => {
  const text = String(url)
  if (text.includes('/raw')) {
    rawCalls.push(text)
    const params = new URL(text, 'http://127.0.0.1').searchParams
    const key = `${params.get('kind')}:${params.get('callId')}`
    const body = RAW_TEXT[key]
    return {
      ok: body !== undefined,
      json: async () => (body === undefined ? { ok: false } : { ok: true, text: body, truncated: false }),
    }
  }
  if (text.includes('/session')) return { ok: true, json: async () => sessionDocument }
  return {
    ok: true,
    json: async () => ({
      ok: true,
      date: '2026-10-18',
      pricingVersion: 'builtin-2026-10-18',
      today: {
        calls: 1,
        tokens: { total: 10, input: 1, cacheRead: 2, cacheWrite: 0, output: 3, reasoning: 0, billableInput: 3 },
        cost: { pricedCalls: 1, unpricedCalls: 0, pricedAmount: 0.01 },
      },
      live: { calls: 0, estimatedTokens: 0 },
    }),
  }
}

async function settle(component) {
  await hooks.runEffects(component)
  await new Promise((resolve) => setTimeout(resolve, 60))
}

const rowsOf = (tree) => findAllByAttr(tree, 'data-flow-step')
const togglesOf = (tree) => findAllByAttr(tree, 'data-raw-toggle')
const rawOf = (tree) => findAllByAttr(tree, 'data-raw')
const headOf = (row) => findByClass(row, 'dsh-usage-lens-flow-head')

// open the panel: render the cell, then click the pill
let tree = hooks.render(Cell, { sessionId: 'session-ui' })
await settle(Cell)
tree = hooks.render(Cell, { sessionId: 'session-ui' })
check('the panel starts closed', hooks.render(Panel, { sessionId: 'session-ui' }), null)
await hooks.runEffects(Panel)
findByClass(tree, 'dsh-usage-lens-pill').props.onClick()

let panelTree = hooks.render(Panel, { sessionId: 'session-ui' })
await settle(Panel)
panelTree = hooks.render(Panel, { sessionId: 'session-ui' })

// --- the block is collapsed by default ------------------------------------

const processHead = findByClass(panelTree, 'dsh-usage-lens-process-head')
check('the execution block renders', processHead !== undefined, true)
check('the execution block is collapsed by default', processHead.props['aria-expanded'], false)
check('a collapsed block shows no pins', findAllByAttr(panelTree, 'data-pin-layer').length, 0)
check('a collapsed block shows no flow rows', rowsOf(panelTree).length, 0)
includes('the header names the block', flattenText(processHead), '执行过程')
includes('the header counts steps and pins', flattenText(processHead), '4 步 · 6 个置顶')

// --- expand: pins and folded flow ----------------------------------------

processHead.props.onClick()
panelTree = hooks.render(Panel, { sessionId: 'session-ui' })

check('the pinned layer renders', findAllByAttr(panelTree, 'data-pin-layer').length, 1)
const pins = findAllByClass(panelTree, 'dsh-usage-lens-pin')
check('one row per pinned key step', pins.length, 6)
check('each pin keeps its kind', pins.map((pin) => pin.props['data-kind']), [
  'skill-loaded', 'skill-not-effective', 'tool-error', 'approval-denied', 'permission-denied', 'subagent',
])
check('each pin keeps its tone', pins.map((pin) => pin.props['data-tone']), ['ok', 'error', 'error', 'error', 'warn', 'info'])
includes('a skill badge names the load', flattenText(pins[0]), 'Skill 已加载')
includes('a skill badge names the skill', flattenText(pins[0]), 'office-recalculate')
includes('an ineffective skill load is labelled', flattenText(pins[1]), 'Skill 调用未生效')
includes('an ineffective skill load explains itself', flattenText(pins[1]), '后续冻结请求中未出现该 Skill 内容')
includes('a tool failure badge is labelled', flattenText(pins[2]), '工具失败')
includes('a tool failure keeps its code', flattenText(pins[2]), 'FS_NOT_FOUND')
includes('an approval denial is labelled', flattenText(pins[3]), '审批拒绝')
includes('a permission denial is labelled', flattenText(pins[4]), '权限拒绝')
includes('a sub-agent dispatch is labelled', flattenText(pins[5]), '子 Agent 调度')

check('one flow row per step', rowsOf(panelTree).map((row) => row.props['data-flow-step']), [1, 2, 3, 4])

// Acceptance 4: normal tool calls stay folded, showing the compact line only.
const step1Row = rowsOf(panelTree)[0]
{
  const text = flattenText(step1Row)
  check(
    'the folded line has exactly the four required fields',
    ['第 1 步', 'skill', '2.5s', '9.3k tok'].every((part) => text.includes(part)),
    true,
  )
}
check('a folded row shows no input/output summary', flattenText(step1Row).includes('输入'), false)
check('a folded row shows no raw block', rawOf(step1Row).length, 0)

// --- expanding a step ----------------------------------------------------

headOf(step1Row).props.onClick()
panelTree = hooks.render(Panel, { sessionId: 'session-ui' })
{
  const expanded = rowsOf(panelTree)[0]
  includes('an expanded step shows its input summary', flattenText(expanded), '输入: {"name":"office-recalculate"}')
  includes('an expanded step shows its output summary', flattenText(expanded), '输出: <skill_content name="office-recalculate">')
  check('an expanded step still hides raw', rawOf(expanded).length, 0)
}

// step 2 has no tools but does have a reasoning summary
headOf(rowsOf(panelTree)[1]).props.onClick()
panelTree = hooks.render(Panel, { sessionId: 'session-ui' })
includes('a thinking step expands to its reasoning summary', flattenText(rowsOf(panelTree)[1]), '需要先读文件再改。')

// --- the raw layer is opt-in --------------------------------------------

check('no raw request is made before a click', rawCalls.length, 0)
excludes('the rendered tree carries no raw payload', JSON.stringify(panelTree), 'FULL-RAW-SKILL-RESULT')

const skillResultToggle = togglesOf(panelTree).find((node) => node.props['data-raw-toggle'] === 'result:c-skill')
check('the raw toggle exists on the expanded tool row', skillResultToggle !== undefined, true)
check('the raw toggle starts closed', rawOf(panelTree).length, 0)
skillResultToggle.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 60))
panelTree = hooks.render(Panel, { sessionId: 'session-ui' })
check('clicking fetched exactly one raw payload', rawCalls.length, 1)
includes('the raw request names the step and call', rawCalls[0], 'callId=c-skill')
check('one raw block is open', rawOf(panelTree).length, 1)
includes('the raw block shows the full payload', flattenText(rawOf(panelTree)[0]), 'FULL-RAW-SKILL-RESULT')

{
  const callsBefore = rawCalls.length
  togglesOf(panelTree).find((node) => node.props['data-raw-toggle'] === 'result:c-skill').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 30))
  panelTree = hooks.render(Panel, { sessionId: 'session-ui' })
  check('closing raw makes no new request', rawCalls.length, callsBefore)
  check('the raw block is gone', rawOf(panelTree).length, 0)
}

// --- a pin click jumps to the failing step and its full result ----------

const toolErrorPin = findAllByClass(panelTree, 'dsh-usage-lens-pin')[2]
toolErrorPin.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 60))
panelTree = hooks.render(Panel, { sessionId: 'session-ui' })

const jumpedStep = rowsOf(panelTree).find((row) => row.props['data-flow-step'] === 3)
check('the pinned failure expands its own step', findByClass(jumpedStep, 'dsh-usage-lens-flow-body') !== undefined, true)
includes('the jumped step shows the failing tool', flattenText(jumpedStep), 'FS_NOT_FOUND')
const jumpedRaw = rawOf(jumpedStep)
check('the pinned failure opens its full result', jumpedRaw.length, 1)
includes('the opened raw block is the failing result', flattenText(jumpedRaw[0]), 'FULL-RAW-RESULT-BODY')
includes('the jump requested the failing call', rawCalls[rawCalls.length - 1], 'callId=c-bad')

// --- collapsing again ---------------------------------------------------

findByClass(panelTree, 'dsh-usage-lens-process-head').props.onClick()
panelTree = hooks.render(Panel, { sessionId: 'session-ui' })
check('collapsing hides the pins', findAllByAttr(panelTree, 'data-pin-layer').length, 0)
check('collapsing hides the flow', rowsOf(panelTree).length, 0)

hooks.dispose()

if (failures.length > 0) {
  console.error(`${failures.length} of ${checks} checks FAILED:\n`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log(`all ${checks} checks passed`)
