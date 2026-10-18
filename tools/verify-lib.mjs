// Shared reader for dsh session logs: concatenated zstd frames, one per append.
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Decode the framed zstd log into its JSONL text. */
export function decodeFrames(buffer) {
  const hits = []
  let cursor = 0
  for (;;) {
    const at = buffer.indexOf(MAGIC, cursor)
    if (at === -1) break
    hits.push(at)
    cursor = at + MAGIC.length
  }
  if (hits.length === 0) throw new Error('no zstd frame found')

  const parts = []
  let frameStart = hits[0]
  let probe = 1
  while (probe <= hits.length) {
    const end = probe < hits.length ? hits[probe] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(frameStart, end)))
      frameStart = end
      probe += 1
    } catch {
      // That boundary was inside compressed data: extend the frame.
      probe += 1
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

/** Read every event of one session log. */
export function readSessionEvents(file) {
  const events = []
  for (const line of decodeFrames(readFileSync(file)).split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A torn trailing line is not fatal.
    }
  }
  return events
}
