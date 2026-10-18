// Independent hand-check: recompute today's Beijing-day totals and amount from
// the ledger with a hardcoded copy of the built-in price table + peak rule, then
// compare with what the live status route returns. Nothing here imports the
// plugin, so an error in lib/pricing.js cannot hide.
//
// Give it the ledger *directory* (or any segment of it): after a rotation the
// month lives in several files, and this tool reads them the way the plugin does.
//
// Usage: node tools/check-day.mjs <ledgerDirOrFile> [--url URL] [--unpriced model,...]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const ledgerPath = args[0]
const urlFlag = args.indexOf('--url')
const url = urlFlag === -1 ? 'http://127.0.0.1:3631/plugins/dsh-usage-lens/today' : args[urlFlag + 1]
const unpricedFlag = args.indexOf('--unpriced')
const unpricedModels = unpricedFlag === -1 ? [] : args[unpricedFlag + 1].split(',').filter(Boolean)

/** Every ledger file the day may live in: the directory, or the file's month. */
function ledgerFiles(target) {
  const isDirectory = (() => {
    try {
      return statSync(target).isDirectory()
    } catch {
      return false
    }
  })()
  if (isDirectory) {
    return readdirSync(target)
      .filter((name) => /^ledger-\d{4}-\d{2}(\.\d{4})?\.jsonl$/u.test(name))
      .sort()
      .map((name) => join(target, name))
  }
  const name = target.replace(/^.*[\\/]/u, '')
  const month = /^ledger-(\d{4}-\d{2})/u.exec(name)?.[1]
  if (month === undefined) return [target]
  const dir = target.slice(0, target.length - name.length)
  return readdirSync(dir)
    .filter((entry) => new RegExp(`^ledger-${month}(\\.\\d{4})?\\.jsonl$`, 'u').test(entry))
    .sort()
    .map((entry) => join(dir, entry))
}

// Hand-transcribed snapshot (yuan / million tokens).
const RATES = {
  'deepseek-flash': {
    offPeak: { cacheHit: 0.02, cacheMiss: 1.0, output: 4.0 },
    peak: { cacheHit: 0.04, cacheMiss: 2.0, output: 8.0 },
  },
  'deepseek-v4-pro': {
    offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    peak: { cacheHit: 0.3, cacheMiss: 9.0, output: 27.0 },
  },
}

function beijing(epochMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(epochMs))
  const bag = {}
  for (const part of parts) if (part.type !== 'literal') bag[part.type] = part.value
  const hour = Number(bag.hour) % 24
  const weekday = new Date(Date.UTC(Number(bag.year), Number(bag.month) - 1, Number(bag.day))).getUTCDay()
  return {
    day: `${bag.year}-${bag.month}-${bag.day}`,
    minutes: hour * 60 + Number(bag.minute),
    weekday,
  }
}

// Sunday 2026-10-18 in Beijing: weekday 0, so off-peak all day. Hardcode the
// rule, not the outcome, so the script stays honest on another day.
function isPeak(epochMs) {
  const { minutes, weekday } = beijing(epochMs)
  if (weekday < 1 || weekday > 5) return false
  return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080)
}

const today = beijing(Date.now()).day
const files = ledgerFiles(ledgerPath)
console.log('ledger files:', files.map((file) => file.replace(/^.*[\\/]/u, '')).join(', '))
const records = files
  .flatMap((file) => readFileSync(file, 'utf8').split('\n'))
  .filter((line) => line.trim() !== '')
  .map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  })
  .filter((entry) => entry !== null && typeof entry.timestamp === 'string')
  .filter((record) => beijing(Date.parse(record.timestamp)).day === today)

let input = 0
let cacheRead = 0
let cacheWrite = 0
let output = 0
let reasoning = 0
let pricedCalls = 0
let unpricedCalls = 0
let unpricedTokens = 0
let amount = 0
const unpricedSeen = new Set()

for (const record of records) {
  input += record.inputTokens ?? 0
  cacheRead += record.cacheReadTokens ?? 0
  cacheWrite += record.cacheWriteTokens ?? 0
  output += record.outputTokens ?? 0
  reasoning += record.reasoningTokens ?? 0
  const bucketTotal = (record.inputTokens ?? 0) + (record.cacheReadTokens ?? 0)
    + (record.cacheWriteTokens ?? 0) + (record.outputTokens ?? 0)
  if (unpricedModels.includes(record.model) || RATES[record.model] === undefined) {
    unpricedCalls += 1
    unpricedTokens += bucketTotal
    unpricedSeen.add(`${record.provider}/${record.model}`)
    continue
  }
  const rates = RATES[record.model][isPeak(Date.parse(record.timestamp)) ? 'peak' : 'offPeak']
  const miss = (record.inputTokens ?? 0) + (record.cacheWriteTokens ?? 0)
  amount += (miss * rates.cacheMiss + (record.cacheReadTokens ?? 0) * rates.cacheHit
    + (record.outputTokens ?? 0) * rates.output) / 1e6
  pricedCalls += 1
}

const hand = {
  day: today,
  calls: records.length,
  input,
  cacheRead,
  cacheWrite,
  output,
  reasoning,
  billableInput: input + cacheRead + cacheWrite,
  total: input + cacheRead + cacheWrite + output,
  pricedCalls,
  unpricedCalls,
  unpricedTokens,
  unpricedModels: [...unpricedSeen].sort(),
  pricedAmount: amount,
  lowerBound: unpricedCalls > 0,
}

const response = await fetch(url)
const live = await response.json()

const pick = (object) => ({
  calls: object.today.calls,
  billableInput: object.today.tokens.billableInput,
  total: object.today.tokens.total,
  pricedCalls: object.today.cost.pricedCalls,
  unpricedCalls: object.today.cost.unpricedCalls,
  unpricedTokens: object.today.cost.unpricedTokens,
  unpricedModels: object.today.cost.unpricedModels,
  pricedAmount: object.today.cost.pricedAmount,
  lowerBound: object.today.cost.lowerBound,
})

const served = pick(live)
const mine = {
  calls: hand.calls,
  billableInput: hand.billableInput,
  total: hand.total,
  pricedCalls: hand.pricedCalls,
  unpricedCalls: hand.unpricedCalls,
  unpricedTokens: hand.unpricedTokens,
  unpricedModels: hand.unpricedModels,
  pricedAmount: hand.pricedAmount,
  lowerBound: hand.lowerBound,
}

console.log('ledger rows today:', hand.calls)
console.log('hand :', JSON.stringify(mine))
console.log('route:', JSON.stringify(served))

const mismatches = []
for (const key of Object.keys(mine)) {
  if (key === 'pricedAmount') {
    if (Math.abs(mine[key] - served[key]) > 1e-9) mismatches.push(`${key}: hand ${mine[key]} vs route ${served[key]}`)
    continue
  }
  if (JSON.stringify(mine[key]) !== JSON.stringify(served[key])) {
    mismatches.push(`${key}: hand ${JSON.stringify(mine[key])} vs route ${JSON.stringify(served[key])}`)
  }
}

// What the status bar renders, by the client's documented formatting rules.
function formatTokens(value) {
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) return `${String(Number((value / 1000).toFixed(1)))}k`
  return `${String(Number((value / 1_000_000).toFixed(1)))}M`
}
function formatMoney(value) {
  if (!(value > 0)) return '¥0.00'
  if (value < 0.01) return `¥${value.toFixed(4)}`
  if (value < 1) return `¥${value.toFixed(3).replace(/0$/u, '')}`
  return `¥${value.toFixed(2)}`
}
const cost = served
const costLabel = cost.unpricedCalls > 0 && cost.pricedCalls > 0
  ? `≥${formatMoney(cost.pricedAmount)} 未定价`
  : cost.unpricedCalls > 0 ? '未定价' : formatMoney(cost.pricedAmount)
console.log('status bar label:', `今日 ${formatTokens(cost.total)} tok · ${costLabel}`)

if (mismatches.length > 0) {
  console.error('\nMISMATCH:')
  for (const line of mismatches) console.error(`- ${line}`)
  process.exit(1)
}
console.log('\nthe route agrees with the hand-computed ledger aggregate')
