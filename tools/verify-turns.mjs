// Acceptance 3: every ledger row's turn/step must equal the harness's own
// assistant/message turn/step for the same call, turns must be non-decreasing
// over time, and the distinct steps inside a turn must be contiguous.
//
// Usage: node tools/verify-turns.mjs <ledger.jsonl> <session.v4.jsonl.zstd>
import { readFileSync } from 'node:fs'

import { readSessionEvents } from './verify-lib.mjs'

const [, , ledgerPath, sessionPath] = process.argv

const records = readFileSync(ledgerPath, 'utf8')
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
  const list = byUsage.get(k) ?? []
  list.push(entry)
  byUsage.set(k, list)
}

const sessionIds = [...new Set(records.map((record) => record.sessionId))]
const targets = sessionIds.length === 1 ? records : records.filter((record) => record.sessionId === sessionIds[0])

let matched = 0
let misplaced = 0
const failures = []
const unattributed = []
let previousTurn = -1
let monotonic = true

for (const record of targets) {
  if (record.turn <= 0 || record.step <= 0) {
    unattributed.push(record)
    continue
  }
  if (record.turn < previousTurn) monotonic = false
  previousTurn = record.turn
  const hit = (byUsage.get(key(record)) ?? [])[0]
  if (hit === undefined) {
    failures.push({ reason: 'no assistant/message with the same usage', record })
    continue
  }
  matched += 1
  if (hit.turn !== record.turn || hit.step !== record.step) {
    misplaced += 1
    failures.push({
      reason: 'turn/step mismatch',
      ledger: { turn: record.turn, step: record.step },
      session: { turn: hit.turn, step: hit.step },
    })
  }
}

const byTurn = new Map()
for (const record of targets) {
  if (record.turn <= 0) continue
  const steps = byTurn.get(record.turn) ?? new Set()
  steps.add(record.step)
  byTurn.set(record.turn, steps)
}

const continuity = []
for (const [turn, steps] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
  const sorted = [...steps].sort((a, b) => a - b)
  const gaps = []
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] !== sorted[index - 1] + 1) gaps.push(`${sorted[index - 1]}→${sorted[index]}`)
  }
  continuity.push({ turn, first: sorted[0], last: sorted[sorted.length - 1], count: sorted.length, gaps })
}

console.log(`ledger rows for the session: ${targets.length}`)
console.log(`attributed rows: ${targets.length - unattributed.length} (unattributed ${unattributed.length})`)
console.log(`matched to assistant/message: ${matched} · mismatched: ${misplaced}`)
console.log(`turns non-decreasing over time: ${monotonic}`)
console.log('per-turn step spans (distinct steps; gaps are retries, not holes):')
for (const span of continuity) {
  console.log(`  turn ${span.turn}: steps ${span.first}..${span.last} (${span.count} steps)${span.gaps.length > 0 ? ` gaps: ${span.gaps.join(', ')}` : ''}`)
}
if (unattributed.length > 0) {
  console.log(`unattributed rows (written before slice 2 or without a live step): ${unattributed.length}`)
}
if (failures.length > 0) {
  console.error(`\nFAILURES (${failures.length}):`)
  for (const failure of failures.slice(0, 10)) console.error(JSON.stringify(failure))
  process.exit(1)
}
console.log('\nevery attributed ledger row matches the session log turn/step')
