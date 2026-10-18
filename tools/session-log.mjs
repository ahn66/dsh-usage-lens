// Dump assistant/message usage from one compressed session log, so a ledger row
// can be compared field by field with the log the harness itself wrote.
// Usage: node tools/session-log.mjs <session.v4.jsonl.zstd> [--tail N]
import { readSessionEvents } from './verify-lib.mjs'

const [, , file, tailFlag] = process.argv
const tail = tailFlag === '--tail' ? Number(process.argv[4] ?? 6) : Infinity

const events = readSessionEvents(file)
const messages = events.filter((event) => event.type === 'assistant/message')

const usageChunks = new Map()
for (const event of events) {
  if (event.type !== 'assistant/chunk') continue
  if (event.data?.chunk?.type !== 'usage') continue
  const key = `${event.data.turn}/${event.data.step}`
  usageChunks.set(key, (usageChunks.get(key) ?? 0) + 1)
}

for (const event of messages.slice(-tail)) {
  const key = `${event.data?.turn}/${event.data?.step}`
  console.log(JSON.stringify({
    seq: event.seq,
    turn: event.data?.turn,
    step: event.data?.step,
    usage: event.data?.usage ?? null,
    usageChunksForStep: usageChunks.get(key) ?? 0,
    interrupted: event.data?.interrupted === true,
  }))
}
console.log(`# events ${events.length} · assistant/message ${messages.length}`)
