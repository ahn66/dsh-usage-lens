/**
 * Client-half harness: loads the shipped `client.js` bundle with a minimal React
 * hook runtime, runs its `apply()`, and inspects the element tree the composer
 * cell returns. The first render polls the real Host route over HTTP, so this
 * exercises the live payload end to end without a browser.
 *
 * What it proves: the bundle factory loads, `apply` registers one cell in
 * `conversation.composer.dock` at order 10, the cell renders the two required
 * fields with the documented formatting, and the unpriced branch never shows a
 * zero amount.
 *
 *   node test/client-render.test.mjs
 *
 * @module dsh-usage-lens/test/client-render
 */

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

// --- a hook runtime just wide enough for this component --------------------

function createHooks() {
  const state = []
  let cursor = 0
  let effectsRan = false
  const effects = []

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in state)) state[index] = initial
      return [state[index], (next) => {
        state[index] = typeof next === 'function' ? next(state[index]) : next
      }]
    },
    useEffect(callback) {
      const index = cursor++
      if (!effectsRan) effects.push(callback)
    },
    useMemo(factory) {
      cursor += 1
      return factory()
    },
  }

  return {
    React,
    beginRender() {
      cursor = 0
    },
    async runEffects() {
      effectsRan = true
      const cleanups = []
      for (const effect of effects) {
        const cleanup = await effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
      return cleanups
    },
  }
}

function flattenText(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenText).join('')
  return (node.children ?? []).map(flattenText).join('')
}

function findByClass(node, className) {
  if (node === null || typeof node !== 'object') return undefined
  if (node.props?.className === className) return node
  for (const child of node.children ?? []) {
    const hit = findByClass(child, className)
    if (hit !== undefined) return hit
  }
  return undefined
}

// --- browser stubs ---------------------------------------------------------

const timers = []
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      globalThis.__usageLensFactory = definition.factory
      globalThis.__usageLensId = definition.id
    },
  },
  setTimeout(callback) {
    timers.push(callback)
    return timers.length
  },
  clearTimeout() {},
  document: undefined,
}
const listeners = new Map()
globalThis.window.document = {
  visibilityState: 'visible',
  addEventListener(name, listener) {
    listeners.set(name, listener)
  },
  removeEventListener(name) {
    listeners.delete(name)
  },
  head: { appendChild() {} },
  createElement() {
    return { dataset: {}, textContent: '' }
  },
}
globalThis.document = globalThis.window.document

// --- load the real bundle --------------------------------------------------

let calls = 0
const realFetch = globalThis.fetch
// A browser resolves the cell's root-relative path against the page origin.
const ORIGIN = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3631'
globalThis.fetch = (url, init) => {
  calls += 1
  const absolute = typeof url === 'string' && url.startsWith('/') ? `${ORIGIN}${url}` : url
  return realFetch(absolute, init)
}

await import('../client.js')
check('the bundle registers its package id', globalThis.__usageLensId, 'dsh-usage-lens')

const hooks = createHooks()
const plugin = globalThis.__usageLensFactory((name) => {
  if (name === 'react') return hooks.React
  throw new Error(`unexpected require: ${name}`)
})

const registered = []
const localeStub = {
  getLocale: () => ({ active: 'zh' }),
  subscribe: () => () => {},
}
const ctx = {
  get(name) {
    return name === 'locale' ? localeStub : undefined
  },
  effect(callback) {
    callback()
    return () => {}
  },
  slots: {
    inject(key, callback) {
      registered.push({ key, result: callback() })
    },
    register(options, component) {
      return { options, component }
    },
  },
}

plugin.apply(ctx)
check('the plugin declares the slots dependency', plugin.inject, ['slots'])
check('the cell is injected into the composer dock', registered[0]?.key, 'conversation.composer.dock')
check('the cell id is its own, not a shipped one', registered[0]?.result?.options?.id, 'usage-lens')
check('the cell sits to the right of the shipped pills', registered[0]?.result?.options?.order, 10)

const Cell = registered[0].result.component

// First render: no data yet, so the cell renders nothing at all.
hooks.beginRender()
check('the first render is empty before the first poll', Cell(), null)

// Run the effects: the polling effect fetches the live Host route.
const cleanups = await hooks.runEffects()
check('the cell polls the package route', calls, 1)
await new Promise((resolve) => setTimeout(resolve, 500))

// Second render: the payload is in.
hooks.beginRender()
const tree = Cell()
check('the cell renders an anchor span', tree?.props?.className, 'dsh-usage-lens-anchor')
check('the cell is addressable by its stat id', tree?.props?.['data-composer-stat'], 'usage-lens')

const pill = findByClass(tree, 'dsh-usage-lens-pill')
check('the anchor holds one pill', pill !== undefined, true)
check('the pill carries the tooltip', typeof pill?.props?.title, 'string')
includes('the tooltip names the pricing version', pill?.props?.title, '价格表估算')
includes('the tooltip states the Beijing day', pill?.props?.title, '北京时间')

const label = findByClass(tree, 'dsh-usage-lens-label')
const text = flattenText(label)
console.log('rendered label:', JSON.stringify(text))
includes('the label shows the token total', text, 'tok')
includes('the label shows a money amount', text, '¥')
check('exactly two fields, one separator', text.split(' · ').length, 2)

const children = pill.children
check('the pill holds an icon and the label', children.length, 2)

// --- the unpriced branch, fed a crafted document ---------------------------

const unpricedDocument = {
  ok: true,
  date: '2026-10-18',
  pricingVersion: 'builtin-2026-10-18',
  today: {
    calls: 3,
    tokens: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 500, reasoning: 0, billableInput: 1000, total: 1500 },
    cost: {
      pricedCalls: 2,
      unpricedCalls: 1,
      unpricedTokens: 1500,
      unpricedModels: ['acme/mystery-1'],
      pricedAmount: 0.0123,
      lowerBound: true,
    },
  },
  live: { calls: 0, estimatedTokens: 0 },
}
globalThis.fetch = async () => ({ ok: true, json: async () => unpricedDocument })
hooks.beginRender()
Cell()
await hooks.runEffects()
await new Promise((resolve) => setTimeout(resolve, 50))
hooks.beginRender()
const mixedTree = Cell()
const mixedText = flattenText(findByClass(mixedTree, 'dsh-usage-lens-label'))
console.log('rendered unpriced label:', JSON.stringify(mixedText))
check('an unpriced share is not hidden', mixedText, '今日 1.5k tok · ≥¥0.0123 未定价')
includes(
  'the tooltip calls the total a lower bound',
  findByClass(mixedTree, 'dsh-usage-lens-pill')?.props?.title,
  '总花费为已定价模型的下界',
)

// All-unpriced: the amount must read 未定价, never ¥0.00.
const allUnpriced = {
  ...unpricedDocument,
  today: {
    ...unpricedDocument.today,
    cost: { pricedCalls: 0, unpricedCalls: 1, unpricedTokens: 1500, unpricedModels: ['acme/mystery-1'], pricedAmount: 0, lowerBound: true },
  },
}
globalThis.fetch = async () => ({ ok: true, json: async () => allUnpriced })
hooks.beginRender()
Cell()
await hooks.runEffects()
await new Promise((resolve) => setTimeout(resolve, 50))
hooks.beginRender()
const onlyUnpricedText = flattenText(findByClass(Cell(), 'dsh-usage-lens-label'))
console.log('rendered all-unpriced label:', JSON.stringify(onlyUnpricedText))
check('an unpriced-only day is never shown as zero', onlyUnpricedText, '今日 1.5k tok · 未定价')

// --- live estimate ---------------------------------------------------------

const streaming = {
  ...unpricedDocument,
  today: { ...unpricedDocument.today, cost: { pricedCalls: 1, unpricedCalls: 0, unpricedTokens: 0, unpricedModels: [], pricedAmount: 0.5, lowerBound: false } },
  live: { calls: 1, estimatedTokens: 400 },
}
globalThis.fetch = async () => ({ ok: true, json: async () => streaming })
hooks.beginRender()
Cell()
await hooks.runEffects()
await new Promise((resolve) => setTimeout(resolve, 50))
hooks.beginRender()
const streamingText = flattenText(findByClass(Cell(), 'dsh-usage-lens-label'))
console.log('rendered streaming label:', JSON.stringify(streamingText))
includes('a live estimate is marked approximate', streamingText, '≈')

for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup()

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${checks} checks FAILED:\n`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log(`\nall ${checks} checks passed`)
