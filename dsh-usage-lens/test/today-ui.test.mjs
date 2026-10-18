/**
 * Slice-4 UI suite: the "今日用量" block.
 *
 * It renders the shipped panel against a crafted document and checks the things
 * the acceptance criteria name: the numbers match the day fold, the hour trend is
 * a real 24-column stack, the cache hit rate and session share are shown, and an
 * overridden price table changes the label from a version to "自定义价格".
 *
 *   node test/today-ui.test.mjs
 *
 * @module dsh-usage-lens/test/today-ui
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

// --- fixture ---------------------------------------------------------------

const hour = (h, input, cacheRead, cacheWrite, output, calls, peakCalls) => ({
  hour: h,
  input,
  cacheRead,
  cacheWrite,
  output,
  reasoning: 0,
  billableInput: input + cacheRead + cacheWrite,
  total: input + cacheRead + cacheWrite + output,
  calls,
  peakCalls,
})

const hours = Array.from({ length: 24 }, (_, h) => hour(h, 0, 0, 0, 0, 0, 0))
hours[9] = hour(9, 1000, 9000, 0, 500, 3, 3)
hours[14] = hour(14, 2000, 0, 0, 1000, 1, 1)
hours[20] = hour(20, 500, 500, 0, 200, 2, 0)

const DAY_TOKENS = hours.reduce((total, entry) => total + entry.total, 0)

const baseDocument = {
  ok: true,
  sessionId: 'session-today',
  pricingVersion: 'builtin-2026-10-18',
  pricingLabel: { mode: 'builtin', version: 'builtin-2026-10-18', customized: false },
  turns: [],
  session: {
    calls: 4,
    tokens: { input: 500, cacheRead: 9500, cacheWrite: 0, output: 900, reasoning: 0, billableInput: 10000, total: 10900 },
    cost: { pricedCalls: 4, unpricedCalls: 0, unpricedTokens: 0, unpricedModels: [], pricedAmount: 0.02, lowerBound: false },
    cacheHitRate: 0.95,
  },
  today: {
    date: '2026-10-19',
    calls: 6,
    statuses: { completed: 6, failed: 0, cancelled: 0 },
    tokens: { input: 3500, cacheRead: 9500, cacheWrite: 0, output: 1700, reasoning: 0, billableInput: 13000, total: DAY_TOKENS },
    cost: { pricedCalls: 6, unpricedCalls: 0, unpricedTokens: 0, unpricedModels: [], pricedAmount: 0.0412, lowerBound: false },
    cacheHitRate: 9500 / 13000,
    hours,
    maxHourTokens: 10500,
    peakHour: 9,
  },
  process: undefined,
}

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
includes('the hour chart has a fixed height', stylesheet, '.dsh-usage-lens-hours{display:flex;align-items:flex-end;gap:1px;height:56px')
includes('series share one brand hue at different opacities', stylesheet, '.dsh-usage-lens-seg[data-bucket="cacheRead"]{opacity:.72}')
includes('the legend swatch is themed', stylesheet, '.dsh-usage-lens-swatch{')

const Cell = registrations[0].cell.component
const Panel = registrations[1].cell.component

let current = baseDocument
globalThis.fetch = async (url) => {
  if (String(url).includes('/session')) return { ok: true, json: async () => current }
  return {
    ok: true,
    json: async () => ({
      ok: true,
      date: '2026-10-19',
      pricingVersion: 'builtin-2026-10-18',
      pricingLabel: { mode: 'builtin', version: 'builtin-2026-10-18', customized: false },
      today: baseDocument.today,
      live: { calls: 0, estimatedTokens: 0 },
    }),
  }
}

async function settle(component) {
  await hooks.runEffects(component)
  await new Promise((resolve) => setTimeout(resolve, 60))
}

/**
 * Open the panel and make it fetch again. The poll effect only restarts when its
 * dependencies change, so a fixture swap needs a close/reopen cycle — the same
 * thing a person does when they reopen the panel.
 */
async function openPanel() {
  const sessionId = 'session-today'
  let tree = hooks.render(Cell, { sessionId })
  await settle(Cell)
  tree = hooks.render(Cell, { sessionId })

  let pill = findByClass(tree, 'dsh-usage-lens-pill')
  if (pill.props['aria-expanded'] === true) {
    pill.props.onClick()
    hooks.render(Panel, { sessionId })
    await hooks.runEffects(Panel)
    tree = hooks.render(Cell, { sessionId })
    pill = findByClass(tree, 'dsh-usage-lens-pill')
  }

  pill.props.onClick()
  hooks.render(Panel, { sessionId })
  await settle(Panel)
  return hooks.render(Panel, { sessionId })
}

// --- the block -------------------------------------------------------------

let panelTree = await openPanel()

check('the today block renders', findAllByAttr(panelTree, 'data-today-block').length, 1)
{
  const block = findAllByAttr(panelTree, 'data-today-block')[0]
  includes('the block is titled', flattenText(block), '今日用量')
  includes('the block names the Beijing day', flattenText(block), '北京时间 2026-10-19')
  includes('the block names the pricing table', flattenText(block), '按 builtin-2026-10-18 价格表估算')
}

// Acceptance 1: the numbers are the day fold, not a second calculation.
{
  const total = findAllByAttr(panelTree, 'data-today-total')[0]
  includes('the day total is the folded token count', flattenText(total), `${fmtTokens(DAY_TOKENS)} tok`)
  includes('the day amount is rendered', flattenText(total), fmtMoney(0.0412))
  const stats = findAllByAttr(panelTree, 'data-today-stats')[0]
  includes('the request count is shown', flattenText(stats), '请求 6 次')
  includes('the cache hit rate is shown', flattenText(stats), '缓存命中率 73.1%')
  includes('the session share is shown', flattenText(stats), `会话累计 ${fmtTokens(10900)} tok / ¥0.02`)
}

// The hour trend.
{
  const chart = findAllByAttr(panelTree, 'data-hour-chart')[0]
  check('the chart exists', chart !== undefined, true)
  const columns = findAllByClass(panelTree, 'dsh-usage-lens-hour')
  check('one column per hour of the day', columns.length, 24)
  check('the columns cover the whole day', columns.map((column) => column.props['data-hour']), Array.from({ length: 24 }, (_, h) => h))
  check('the busiest hour is full height', columns[9].children[0].props.style.height, '100%')
  check('an empty hour has no height', columns[3].children[0].props.style.height, '0%')
  check('a half hour is proportional', columns[20].children[0].props.style.height, `${Math.round((1200 / 10500) * 1000) / 10}%`)

  const busiestSegments = columns[9].children[0].children
  check('the busiest hour stacks four buckets', busiestSegments.map((segment) => segment.props['data-bucket']), ['input', 'cacheRead', 'cacheWrite', 'output'])
  check('the segments sum to the full column', busiestSegments.reduce((total, segment) => total + Number.parseFloat(segment.props.style.height), 0), 100)
  check('the cache read dominates the busiest hour', Number.parseFloat(busiestSegments[1].props.style.height) > 80, true)
  includes('an hour column has a tooltip', columns[9].props.title, '9:00 · 10,500 tok · 3 次调用')

  const peakColumns = columns.filter((column) => column.props['data-peak'] === 'true')
  check('peak hours are marked', peakColumns.map((column) => column.props['data-hour']), [9, 14])

  const legend = findAllByAttr(panelTree, 'data-legend')
  check('the legend names all four buckets', legend.map((node) => node.props['data-legend']), ['input', 'cacheRead', 'cacheWrite', 'output'])
  check('the legend labels the buckets', flattenText(findByClass(panelTree, 'dsh-usage-lens-today-legend')), '入缓存读缓存写出')
  includes(
    'the legend explains what is stacked',
    findByClass(panelTree, 'dsh-usage-lens-today-legend')?.props?.title,
    '缓存命中',
  )
}

// The block sits between the turn cards and the execution process.
{
  const body = panelTree.children.find((child) => child?.props?.className === 'dsh-usage-lens-panel-body')
  check('the panel body still has its two blocks', body.children.length >= 2, true)
  check('the today block comes before any process block', body.children.findIndex((child) => child?.props?.['data-today-block'] === 'true'), 1)
}

// --- an overridden price table -------------------------------------------

{
  current = {
    ...baseDocument,
    pricingVersion: 'builtin-2026-10-18',
    pricingLabel: { mode: 'custom', version: 'builtin-2026-10-18', customized: true },
    today: { ...baseDocument.today, cost: { ...baseDocument.today.cost, pricedAmount: 0.9 } },
  }
  const custom = await openPanel()
  includes('an unnamed override is labelled custom', flattenText(findAllByAttr(custom, 'data-today-block')[0]), '自定义价格')
  excludes('an unnamed override does not borrow the snapshot version', flattenText(findAllByAttr(custom, 'data-today-block')[0]), '按 builtin-2026-10-18')
  includes('the overridden amount is rendered', flattenText(findAllByAttr(custom, 'data-today-total')[0]), fmtMoney(0.9))
  includes(
    'the panel head note follows the same label',
    flattenText(findByClass(custom, 'dsh-usage-lens-panel-note')),
    '自定义价格',
  )

  current = {
    ...baseDocument,
    pricingVersion: 'team-2026-11',
    pricingLabel: { mode: 'override', version: 'team-2026-11', customized: true },
  }
  const named = await openPanel()
  includes('a declared version is quoted', flattenText(findAllByAttr(named, 'data-today-block')[0]), '按 team-2026-11 价格表估算')
}

// --- unpriced -------------------------------------------------------------

{
  current = {
    ...baseDocument,
    today: {
      ...baseDocument.today,
      cost: {
        pricedCalls: 4,
        unpricedCalls: 2,
        unpricedTokens: 1600,
        unpricedModels: ['acme/mystery-1'],
        pricedAmount: 0.03,
        lowerBound: true,
      },
    },
  }
  const mixed = await openPanel()
  const total = findAllByAttr(mixed, 'data-today-total')[0]
  includes('a mixed day marks the total as a lower bound', flattenText(total), `≥${fmtMoney(0.03)}`)
  includes('a mixed day names the unpriced model', flattenText(total), 'acme/mystery-1')
  check('the unpriced share is flagged', findAllByAttr(mixed, 'data-today-unpriced').length, 1)

  current = {
    ...baseDocument,
    today: {
      ...baseDocument.today,
      cost: { pricedCalls: 0, unpricedCalls: 3, unpricedTokens: 1600, unpricedModels: ['acme/mystery-1'], pricedAmount: 0, lowerBound: true },
    },
  }
  const only = await openPanel()
  const onlyTotal = findAllByAttr(only, 'data-today-total')[0]
  includes('an all-unpriced day reads 未定价', flattenText(onlyTotal), '未定价')
  excludes('an all-unpriced day never reads as zero money', flattenText(onlyTotal), '¥0.00')
}

hooks.dispose()

if (failures.length > 0) {
  console.error(`${failures.length} of ${checks} checks FAILED:\n`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log(`all ${checks} checks passed`)
