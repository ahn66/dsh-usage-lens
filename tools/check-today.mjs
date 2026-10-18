// Print the day fold exactly as the UI receives it, plus the ledger segment
// layout, so an override or a rotation can be checked from one command.
//
// Usage: node tools/check-today.mjs [--url URL] [--dir LEDGER_DIR]
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const argv = process.argv
const urlFlag = argv.indexOf('--url')
const base = urlFlag === -1 ? 'http://127.0.0.1:3631' : argv[urlFlag + 1]
const dirFlag = argv.indexOf('--dir')
const dir = dirFlag === -1 ? join(process.env.DSH_HOME ?? '.', 'usage-lens') : argv[dirFlag + 1]

const document = await (await fetch(`${base}/plugins/dsh-usage-lens/today`)).json()
const today = document.today

const pct = (value) => (typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : '—')
const money = (value) => `¥${Number(value ?? 0).toFixed(6)}`

console.log(`date ${document.date} · timeZone ${document.timeZone}`)
console.log(`pricingLabel ${document.pricingLabel.mode} · version ${document.pricingVersion} · customized ${document.pricingLabel.customized}`)
console.log(`calls ${today.calls} · statuses ${JSON.stringify(today.statuses)}`)
console.log(`tokens input=${today.tokens.input} cacheRead=${today.tokens.cacheRead} cacheWrite=${today.tokens.cacheWrite} output=${today.tokens.output} total=${today.tokens.total}`)
console.log(`cost pricedCalls=${today.cost.pricedCalls} unpricedCalls=${today.cost.unpricedCalls} unpricedTokens=${today.cost.unpricedTokens} pricedAmount=${money(today.cost.pricedAmount)} lowerBound=${today.cost.lowerBound} unpriced=${JSON.stringify(today.cost.unpricedModels)}`)
console.log(`cacheHitRate ${pct(today.cacheHitRate)} · maxHourTokens ${today.maxHourTokens} · peakHour ${today.peakHour}`)
console.log(`live ${JSON.stringify(document.live)}`)
console.log('hours with tokens:', today.hours.filter((hour) => hour.total > 0).map((hour) => `${hour.hour}:00=${hour.total}${hour.peakCalls > 0 ? '(peak)' : ''}`).join(' ') || '(none)')

// Per-model view of the same day, priced with the table in force.
const session = await (await fetch(`${base}/plugins/dsh-usage-lens/session?sessionId=session-e05133ea-aab5-4696-981f-1465c7002e95`)).json()
const byModel = new Map()
for (const turn of session.turns ?? []) {
  for (const step of turn.steps ?? []) {
    const entry = byModel.get(step.model) ?? { calls: 0, tokens: 0, amount: 0, unpriced: 0 }
    entry.calls += 1
    entry.tokens += step.tokens.total
    if (step.cost.priced) entry.amount += step.cost.amount
    else entry.unpriced += 1
    byModel.set(step.model, entry)
  }
}
console.log('\nsession turns by model:')
for (const [model, entry] of byModel) {
  console.log(`  ${model}: calls=${entry.calls} tokens=${entry.tokens} pricedAmount=${money(entry.amount)} unpriced=${entry.unpriced}`)
}

console.log('\nledger segments:')
const files = (await readdir(dir)).filter((name) => name.startsWith('ledger-')).sort()
let totalLines = 0
for (const name of files) {
  const info = await stat(join(dir, name))
  const text = await readFile(join(dir, name), 'utf8')
  const lines = text.split('\n').filter((line) => line.trim() !== '').length
  totalLines += lines
  console.log(`  ${name} · ${info.size}B · ${lines} lines · readOnly=${(info.mode & 0o200) === 0}`)
}
console.log(`  total records across segments: ${totalLines}`)
