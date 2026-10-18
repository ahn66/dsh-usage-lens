/**
 * Detail-panel suite: loads the shipped Client bundle with the hook runtime,
 * toggles the pill, and inspects the turn cards the panel renders.
 *
 * It checks what the acceptance criteria name: one card per turn, steps in order
 * after expanding, card totals equal to the sum of the expanded rows, the
 * pricing-version note beside the amounts, an unpriced share that never reads
 * zero, and a scrollable normal-flow body that cannot cover the composer.
 *
 *   node test/panel.test.mjs
 *
 * @module dsh-usage-lens/test/panel
 */

import { createHooks, findAllByClass, findByClass, flattenText, installBrowser } from './hooks.mjs'

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

// The panel's own formatting rules, reimplemented here so the assertions never
// reuse the code under test.
function fmtTokens(value) {
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) return `${String(Number((value / 1000).toFixed(1)))}k`
  return `${String(Number((value / 1_000_000).toFixed(1)))}M`
}
function fmtMoney(value) {
  if (!(value > 0)) return '¥0.00'
  if (value < 0.0001) return '¥<0.0001'
  if (value < 0.1) return `¥${value.toFixed(4)}`
  if (value < 1) return `¥${value.toFixed(3).replace(/0$/u, '')}`
  return `¥${value.toFixed(2)}`
}

// --- fixtures --------------------------------------------------------------

function tokensOf(input, cacheRead, cacheWrite, output, reasoning = 0) {
  const billableInput = input + cacheRead + cacheWrite
  return { input, cacheRead, cacheWrite, output, reasoning, billableInput, total: billableInput + output }
}

function stepOf({ step, amount, status = 'completed', tools = [], tokens, priced = true, model = 'deepseek-flash' }) {
  return {
    step,
    model,
    provider: 'deepseek-account',
    tokens,
    cost: { priced, amount: priced ? amount : 0, peak: false },
    status,
    failed: status !== 'completed',
    timestamp: `2026-10-18T10:0${step}:00+08:00`,
    durationMs: 3000,
    tools,
  }
}

const turn7Steps = [
  stepOf({ step: 1, amount: 0.0021, tools: ['read'], tokens: tokensOf(1000, 9000, 0, 200) }),
  stepOf({ step: 2, amount: 0.0034, tools: ['bash'], tokens: tokensOf(500, 9500, 0, 300) }),
  stepOf({ step: 3, amount: 0.0008, tokens: tokensOf(120, 9900, 0, 80) }),
]
const turn7Sum = turn7Steps.reduce((total, step) => ({
  tokens: total.tokens + step.tokens.total,
  amount: total.amount + step.cost.amount,
}), { tokens: 0, amount: 0 })

const turn8Steps = [
  stepOf({ step: 1, amount: 0.0004, status: 'cancelled', tokens: tokensOf(30, 11000, 0, 10) }),
]
const turn9Steps = [
  stepOf({ step: 1, amount: 0.0123, tokens: tokensOf(100, 0, 0, 50) }),
  stepOf({ step: 2, amount: 0, priced: false, model: 'mystery-1', tokens: tokensOf(0, 0, 0, 700) }),
]

function turnCardFixture(turn, steps, extra) {
  const tokens = steps.reduce((total, step) => {
    total.input += step.tokens.input
    total.cacheRead += step.tokens.cacheRead
    total.cacheWrite += step.tokens.cacheWrite
    total.output += step.tokens.output
    total.reasoning += step.tokens.reasoning
    total.billableInput += step.tokens.billableInput
    total.total += step.tokens.total
    return total
  }, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, billableInput: 0, total: 0 })
  const pricedAmount = steps.reduce((total, step) => total + (step.cost.priced ? step.cost.amount : 0), 0)
  const unpricedCalls = steps.filter((step) => !step.cost.priced).length
  return {
    turn,
    attributed: true,
    calls: steps.length,
    statuses: {
      completed: steps.filter((step) => step.status === 'completed').length,
      failed: steps.filter((step) => step.status === 'failed').length,
      cancelled: steps.filter((step) => step.status === 'cancelled').length,
    },
    tokens,
    cost: {
      pricedAmount,
      pricedCalls: steps.length - unpricedCalls,
      unpricedCalls,
      unpricedTokens: unpricedCalls === 0 ? 0 : 700,
      unpricedModels: unpricedCalls === 0 ? [] : ['acme/mystery-1'],
      lowerBound: unpricedCalls > 0,
    },
    toolCount: new Set(steps.flatMap((step) => step.tools)).size,
    tools: [...new Set(steps.flatMap((step) => step.tools))],
    steps,
    ...extra,
  }
}

const sessionDocument = {
  ok: true,
  sessionId: 'session-panel',
  generatedAt: 1792300000000,
  timeZone: 'Asia/Shanghai',
  pricingVersion: 'builtin-2026-10-18',
  pricingCurrency: 'CNY',
  turns: [
    turnCardFixture(8, turn8Steps, { open: true }),
    turnCardFixture(7, turn7Steps, { open: false, reason: 'completed', startedAt: 1792299000000, endedAt: 1792299100000 }),
  ],
}

const unpricedDocument = {
  ...sessionDocument,
  turns: [turnCardFixture(9, turn9Steps, { open: false, reason: 'completed' })],
}

// --- load the bundle -------------------------------------------------------

const { styles } = installBrowser()
await import('../client.js')
const definition = globalThis.__usageLensDefinition
check('the bundle registers its package id', definition.id, 'dsh-usage-lens')

const hooks = createHooks()
const plugin = definition.factory((name) => {
  if (name === 'react') return hooks.React
  throw new Error(`unexpected require: ${name}`)
})

const registrations = []
const localeStub = { getLocale: () => ({ active: 'zh' }), subscribe: () => () => {} }
plugin.apply({
  get(name) {
    return name === 'locale' ? localeStub : undefined
  },
  effect(callback) {
    callback()
    return () => {}
  },
  slots: {
    inject(key, callback) {
      registrations.push({ key, cell: callback() })
    },
    register(options, component) {
      return { options, component }
    },
  },
})

check('two cells register', registrations.map((entry) => entry.key), ['conversation.composer.dock', 'conversation.input.dock'])
check('the pill keeps its dock cell', registrations[0].cell.options.id, 'usage-lens')
check('the panel sits in the input dock', registrations[1].cell.options.id, 'usage-lens-panel')
check('the panel sits above the queue cell', registrations[1].cell.options.order, 15)

const stylesheet = styles.map((style) => style.textContent).join('\n')
includes('the panel body can scroll', stylesheet, 'max-height:min(52vh,460px)')
includes('the panel body scrolls vertically', stylesheet, 'overflow-y:auto')
includes('the panel is a normal-flow block', stylesheet, '.dsh-usage-lens-panel{')
includes('narrow rows wrap instead of overflowing', stylesheet, 'flex-wrap:wrap')

// --- shared fetch stub -----------------------------------------------------

let route = 'session'
globalThis.fetch = async (url) => {
  const text = String(url)
  if (text.includes('/session')) {
    return { ok: true, json: async () => (route === 'unpriced' ? unpricedDocument : sessionDocument) }
  }
  return {
    ok: true,
    json: async () => ({
      ok: true,
      date: '2026-10-18',
      pricingVersion: 'builtin-2026-10-18',
      today: {
        calls: 3,
        tokens: { input: 1, cacheRead: 2, cacheWrite: 0, output: 3, reasoning: 0, billableInput: 3, total: 6 },
        cost: { pricedCalls: 3, unpricedCalls: 0, unpricedTokens: 0, unpricedModels: [], pricedAmount: 0.01, lowerBound: false },
      },
      live: { calls: 0, estimatedTokens: 0 },
    }),
  }
}

const Cell = registrations[0].cell.component
const Panel = registrations[1].cell.component

async function settle(component) {
  await hooks.runEffects(component)
  await new Promise((resolve) => setTimeout(resolve, 60))
}

// --- the pill toggles the panel -------------------------------------------

let tree = hooks.render(Cell, { sessionId: 'session-panel' })
await settle(Cell)
tree = hooks.render(Cell, { sessionId: 'session-panel' })

const pill = findByClass(tree, 'dsh-usage-lens-pill')
check('the pill is a button now', pill.type, 'button')
check('the panel starts closed', pill.props['aria-expanded'], false)
includes('the pill points at the panel', pill.props['aria-controls'], 'dsh-usage-lens-panel')

check('a closed panel renders nothing', hooks.render(Panel, { sessionId: 'session-panel' }), null)
await hooks.runEffects(Panel)

pill.props.onClick()
tree = hooks.render(Cell, { sessionId: 'session-panel' })
check('clicking the pill opens the panel', findByClass(tree, 'dsh-usage-lens-pill').props['aria-expanded'], true)

// --- the panel renders the turn projection --------------------------------

let panelTree = hooks.render(Panel, { sessionId: 'session-panel' })
await settle(Panel)
panelTree = hooks.render(Panel, { sessionId: 'session-panel' })

check('the panel renders', panelTree?.props?.['data-usage-lens-panel'], 'true')
includes(
  'the panel names the pricing table next to the amounts',
  flattenText(findByClass(panelTree, 'dsh-usage-lens-panel-note')),
  '按 builtin-2026-10-18 价格表估算',
)

const turnCards = findAllByClass(panelTree, 'dsh-usage-lens-turn')
check('one card per turn', turnCards.length, 2)
check('turns are newest first', turnCards.map((card) => card.props['data-turn']), [8, 7])
check('the running turn is marked open', turnCards[0].props['data-open'], 'true')
check('cards start collapsed', findAllByClass(panelTree, 'dsh-usage-lens-steps').length, 0)
includes('a collapsed card still shows its call count', flattenText(turnCards[1]), '3 次调用')
includes('a collapsed card shows its tool count', flattenText(turnCards[1]), '2 个工具')
includes('an interrupted turn is flagged on its card', flattenText(turnCards[0]), '1 次异常')

// Acceptance 2: the card totals are the sums of the rows it expands into.
const turn7Card = turnCards[1]
check(
  'the card token figure equals the sum of its rows',
  flattenText(findByClass(turn7Card, 'dsh-usage-lens-turn-tokens')),
  `${fmtTokens(turn7Sum.tokens)} tok`,
)
check(
  'the card amount equals the sum of its rows',
  flattenText(findByClass(turn7Card, 'dsh-usage-lens-turn-cost')),
  fmtMoney(turn7Sum.amount),
)

// --- expanding a card lists the calls in step order ----------------------

findByClass(turn7Card, 'dsh-usage-lens-turn-head').props.onClick()
panelTree = hooks.render(Panel, { sessionId: 'session-panel' })
const expandedCard = findAllByClass(panelTree, 'dsh-usage-lens-turn')[1]
const stepRows = findAllByClass(expandedCard, 'dsh-usage-lens-step')
check('expanding lists every call', stepRows.length, 3)
check('rows are in step order', stepRows.map((row) => row.props['data-step']), [1, 2, 3])
check('rows keep their status', stepRows.map((row) => row.props['data-status']), ['completed', 'completed', 'completed'])
includes('a row shows all four buckets', flattenText(stepRows[0]), '入 1k · 缓存读 9k · 缓存写 0 · 出 200')
includes('a row shows its tool', flattenText(stepRows[0]), 'read')
includes('a row shows its own amount', flattenText(stepRows[0]), fmtMoney(0.0021))
check('the expanded rows are the ones the card summed', stepRows.length, 3)
check('only the expanded card lists rows', findAllByClass(panelTree, 'dsh-usage-lens-step').length, 3)

// --- an unpriced share never reads as zero -------------------------------

route = 'unpriced'
findByClass(panelTree, 'dsh-usage-lens-panel-close').props.onClick()
check('closing the panel renders nothing', hooks.render(Panel, { sessionId: 'session-panel' }), null)
await hooks.runEffects(Panel)

findByClass(hooks.render(Cell, { sessionId: 'session-panel' }), 'dsh-usage-lens-pill').props.onClick()
let unpricedTree = hooks.render(Panel, { sessionId: 'session-panel' })
await settle(Panel)
unpricedTree = hooks.render(Panel, { sessionId: 'session-panel' })

const unpricedCard = findAllByClass(unpricedTree, 'dsh-usage-lens-turn')[0]
check('an unpriced share marks the card total as a lower bound', flattenText(findByClass(unpricedCard, 'dsh-usage-lens-turn-cost')), '≥¥0.0123')
includes('the card names the unpriced model', flattenText(unpricedCard), '2 次调用')

findByClass(unpricedCard, 'dsh-usage-lens-turn-head').props.onClick()
unpricedTree = hooks.render(Panel, { sessionId: 'session-panel' })
const unpricedRows = findAllByClass(findAllByClass(unpricedTree, 'dsh-usage-lens-turn')[0], 'dsh-usage-lens-step')
const unpricedRowText = flattenText(unpricedRows[1])
includes('an unpriced row reads 未定价', unpricedRowText, '未定价')
excludes('an unpriced row never reads as zero money', unpricedRowText, '¥0.00')
includes('the unpriced row still shows its tokens', unpricedRowText, '出 700')

// --- closing --------------------------------------------------------------

findByClass(unpricedTree, 'dsh-usage-lens-panel-close').props.onClick()
check('closing removes the panel again', hooks.render(Panel, { sessionId: 'session-panel' }), null)

hooks.dispose()

if (failures.length > 0) {
  console.error(`${failures.length} of ${checks} checks FAILED:\n`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log(`all ${checks} checks passed`)
