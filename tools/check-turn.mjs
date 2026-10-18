// Acceptance 1 + 2 for one real turn: print the aggregated card, the expanded
// step rows, and an independent sum recomputed here from those rows.
//
// Usage: node tools/check-turn.mjs <sessionId> [turn] [--url URL]
const [, , sessionId, turnArg] = process.argv
const urlFlag = process.argv.indexOf('--url')
const base = urlFlag === -1 ? 'http://127.0.0.1:3631' : process.argv[urlFlag + 1]

const response = await fetch(`${base}/plugins/dsh-usage-lens/session?sessionId=${encodeURIComponent(sessionId)}`)
const document = await response.json()
if (document.ok !== true) {
  console.error('route error:', JSON.stringify(document))
  process.exit(1)
}

const attributed = document.turns.filter((turn) => turn.attributed !== false)
const wanted = turnArg !== undefined ? Number(turnArg) : attributed[0]?.turn
const turn = document.turns.find((candidate) => candidate.turn === wanted)
if (turn === undefined) {
  console.error(`turn ${wanted} not found; turns are ${document.turns.map((entry) => entry.turn).join(', ')}`)
  process.exit(1)
}

const fmtTokens = (value) => {
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) return `${String(Number((value / 1000).toFixed(1)))}k`
  return `${String(Number((value / 1_000_000).toFixed(1)))}M`
}
const fmtMoney = (value) => {
  if (!(value > 0)) return '¥0.00'
  if (value < 0.0001) return '¥<0.0001'
  if (value < 0.1) return `¥${value.toFixed(4)}`
  if (value < 1) return `¥${value.toFixed(3).replace(/0$/u, '')}`
  return `¥${value.toFixed(2)}`
}

console.log(`pricing: ${document.pricingVersion} (${document.pricingCurrency})`)
console.log(`\n=== card: turn ${turn.turn}${turn.open ? ' (进行中 / open)' : ''} ===`)
console.log(`调用次数 ${turn.calls} · 工具 ${turn.toolCount} (${turn.tools.join(', ') || '-'}) · 状态 ${JSON.stringify(turn.statuses)}`)
console.log(`token 总量 ${turn.tokens.total} (${fmtTokens(turn.tokens.total)} tok)`)
console.log(`未缓存输入 ${turn.tokens.input} · 缓存命中 ${turn.tokens.cacheRead} · 缓存写入 ${turn.tokens.cacheWrite} · 输出 ${turn.tokens.output}`)
console.log(`金额 ${fmtMoney(turn.cost.pricedAmount)}${turn.cost.lowerBound ? '（下界）' : ''} · 已定价 ${turn.cost.pricedCalls} 次 · 未定价 ${turn.cost.unpricedCalls} 次`)

const sum = turn.steps.reduce((total, step) => ({
  total: total.total + step.tokens.total,
  billableInput: total.billableInput + step.tokens.billableInput,
  amount: total.amount + (step.cost.priced ? step.cost.amount : 0),
}), { total: 0, billableInput: 0, amount: 0 })

console.log('\n=== expanded rows ===')
for (const step of turn.steps) {
  console.log(
    `#${step.step} ${step.model} · 入 ${step.tokens.input} · 缓存读 ${step.tokens.cacheRead}`
    + ` · 缓存写 ${step.tokens.cacheWrite} · 出 ${step.tokens.output}`
    + ` · ${step.cost.priced ? fmtMoney(step.cost.amount) : '未定价'}`
    + ` · ${step.status}`
    + (step.tools.length > 0 ? ` · ${step.tools.join(', ')}` : ''),
  )
}

console.log('\n=== independent sum over the rows ===')
console.log(`sum tokens.total = ${sum.total} → card ${turn.tokens.total} · ${sum.total === turn.tokens.total ? 'MATCH' : 'MISMATCH'}`)
console.log(`sum billableInput = ${sum.billableInput} → card ${turn.tokens.billableInput} · ${sum.billableInput === turn.tokens.billableInput ? 'MATCH' : 'MISMATCH'}`)
const amountMatch = Math.abs(sum.amount - turn.cost.pricedAmount) < 1e-9
console.log(`sum amount = ${sum.amount} → card ${turn.cost.pricedAmount} · ${amountMatch ? 'MATCH' : 'MISMATCH'}`)
console.log(`rows = ${turn.steps.length} · calls = ${turn.calls} · ${turn.steps.length === turn.calls ? 'MATCH' : 'MISMATCH'}`)
