// Join today's ledger rows against the harness's own assistant/message usage,
// which is the check acceptance 2 of slice 1 asks for.
// Usage: node tools/verify-ledger.mjs <ledger.jsonl> <session.v4.jsonl.zstd>
import { readFileSync } from 'node:fs'

import { readSessionEvents } from './verify-lib.mjs'

const [, , ledgerPath, sessionPath] = process.argv

const ledger = readFileSync(ledgerPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line))

const assistant = readSessionEvents(sessionPath)
  .filter((event) => event.type === 'assistant/message' && event.data?.usage !== undefined)
  .map((event) => ({
    seq: event.seq,
    turn: event.data.turn,
    step: event.data.step,
    usage: event.data.usage,
  }))

const types = new Map()
for (const event of readSessionEvents(sessionPath)) types.set(event.type, (types.get(event.type) ?? 0) + 1)

const key = (usage) => [
  usage.inputTokens ?? 0,
  usage.cacheReadTokens ?? 0,
  usage.cacheWriteTokens ?? 0,
  usage.outputTokens ?? 0,
  usage.reasoningTokens ?? 0,
].join('/')

const byUsage = new Map()
for (const entry of assistant) {
  const k = key(entry.usage)
  byUsage.set(k, [...(byUsage.get(k) ?? []), entry])
}

let matched = 0
const rows = []
for (const record of ledger) {
  const hit = (byUsage.get(key(record)) ?? [])[0]
  if (hit !== undefined) matched += 1
  rows.push({
    timestamp: record.timestamp,
    status: record.status,
    model: record.model,
    ledger: {
      input: record.inputTokens,
      cacheRead: record.cacheReadTokens,
      cacheWrite: record.cacheWriteTokens,
      output: record.outputTokens,
    },
    session: hit === undefined ? 'NO MATCH' : { turn: hit.turn, step: hit.step, seq: hit.seq, output: hit.usage.outputTokens },
    equal: hit !== undefined,
  })
}

console.log('event types:', [...types.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '))
console.log(`ledger rows: ${ledger.length} · assistant/message with usage: ${assistant.length} · exact usage matches: ${matched}`)
for (const row of rows.filter((entry) => !entry.equal)) console.log('unmatched:', JSON.stringify(row))
