/**
 * JSONL ledger: one line per settled model call, token buckets only.
 *
 * Rotation is by Beijing calendar month, and inside a month by size: when the
 * active file would grow past `maxBytes`, it is renamed to
 * `ledger-YYYY-MM.NNNN.jsonl` and marked read-only, and a fresh active file
 * starts. An archive is never opened for append again, so its bytes are
 * immutable facts.
 *
 * Reads span every segment of a month in order (oldest archive first), which is
 * why rotation costs no history. Writes are serialized through a promise chain,
 * so concurrent settlements cannot interleave a half line or race a rotation.
 *
 * @module dsh-usage-lens/lib/ledger
 */

import { appendFile, chmod, mkdir, readFile, readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { dateKey, monthKey } from './time.js'

/** The schema fields every record carries, in the documented order. */
export const LEDGER_FIELDS = [
  'sessionId',
  'turn',
  'step',
  'model',
  'provider',
  'inputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'reasoningTokens',
  'timestamp',
  'durationMs',
  'status',
]

/** Terminal states a call can settle in (AGENTS.md convention 7). */
export const CALL_STATUSES = ['completed', 'failed', 'cancelled']

/** Size rotation stops at this unless configured; `0` keeps month files unbounded. */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

const ACTIVE_NAME = (month) => `ledger-${month}.jsonl`
const ARCHIVE_PATTERN = (month) => new RegExp(`^ledger-${month}\\.(\\d{4})\\.jsonl$`, 'u')

/** Whether one parsed line is a usable record. */
function isRecord(value) {
  if (value === null || typeof value !== 'object') return false
  if (typeof value.timestamp !== 'string' || Number.isNaN(Date.parse(value.timestamp))) return false
  if (typeof value.model !== 'string') return false
  return CALL_STATUSES.includes(value.status)
}

/**
 * Own one ledger directory.
 * @param options - `dir` (absolute ledger directory), `timeZone` for rotation
 *   and day bucketing, `maxBytes` for size rotation (`0` disables it), and
 *   `warn` for non-fatal failures.
 * @returns append and query operations, plus the segment layout for diagnostics.
 */
export function createLedger({ dir, timeZone, maxBytes = DEFAULT_MAX_BYTES, warn = () => {} }) {
  let directoryReady
  let tail = Promise.resolve()
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 0

  function ensureDirectory() {
    if (directoryReady === undefined) {
      directoryReady = mkdir(dir, { recursive: true }).catch((error) => {
        directoryReady = undefined
        throw error
      })
    }
    return directoryReady
  }

  function fileOf(month) {
    return join(dir, ACTIVE_NAME(month))
  }

  /** Archives of one month, oldest first. */
  async function archivesOf(month) {
    let names
    try {
      names = await readdir(dir)
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return []
      throw error
    }
    const pattern = ARCHIVE_PATTERN(month)
    return names
      .map((name) => {
        const match = pattern.exec(name)
        return match === null ? undefined : { name, index: Number(match[1]) }
      })
      .filter(Boolean)
      .sort((left, right) => left.index - right.index)
      .map((entry) => join(dir, entry.name))
  }

  /**
   * Archive the active file when the next line would cross the size limit.
   * Archives are chmod-ed read-only: the rotation makes them history, and
   * history is not appended to.
   */
  async function rotateIfNeeded(month, incomingBytes) {
    if (limit === 0) return
    const active = fileOf(month)
    let size
    try {
      size = (await stat(active)).size
    } catch {
      return
    }
    if (size === 0 || size + incomingBytes <= limit) return
    const archives = await archivesOf(month)
    const nextIndex = archives.length === 0 ? 1 : archives.length + 1
    const archive = join(dir, `ledger-${month}.${String(nextIndex).padStart(4, '0')}.jsonl`)
    await rename(active, archive)
    try {
      await chmod(archive, 0o444)
    } catch (error) {
      warn(`ledger archive could not be marked read-only: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function appendRecord(record) {
    await ensureDirectory()
    const month = record.timestamp.slice(0, 7)
    const line = `${JSON.stringify(record)}\n`
    await rotateIfNeeded(month, Buffer.byteLength(line))
    await appendFile(fileOf(month), line, 'utf8')
  }

  /**
   * Queue one record for append. Failures are reported through `warn` and never
   * propagate into the model call that produced the record.
   * @param record - one record following {@link LEDGER_FIELDS}.
   */
  function append(record) {
    tail = tail
      .then(() => appendRecord(record))
      .catch((error) => {
        warn(`ledger append failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    return tail
  }

  async function readSegment(file) {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return []
      throw error
    }
    const records = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line)
        if (isRecord(parsed)) records.push(parsed)
      } catch {
        // A torn or foreign line never invalidates the rest of the month.
      }
    }
    return records
  }

  /**
   * Read one month's parsed records across every segment: archives oldest
   * first, then the active file. A missing segment is simply empty, and an
   * unparsable line (a torn tail from a crash) is skipped rather than fatal.
   * @param month - `YYYY-MM` Beijing month key.
   */
  async function readMonth(month) {
    const records = []
    for (const archive of await archivesOf(month)) records.push(...await readSegment(archive))
    records.push(...await readSegment(fileOf(month)))
    return records
  }

  /**
   * Read every record whose Beijing calendar day equals `day`.
   * @param day - `YYYY-MM-DD` Beijing day key.
   */
  async function readDay(day) {
    const records = await readMonth(day.slice(0, 7))
    return records.filter((record) => dateKey(Date.parse(record.timestamp), timeZone) === day)
  }

  /**
   * Read every record of one session from the current and previous Beijing
   * month, across all their segments. A session can outlive a month boundary,
   * so both months are consulted; a shared identity is deduplicated once.
   * @param sessionId - the session to collect.
   * @param now - instant that selects the month window (defaults to now).
   */
  async function readSession(sessionId, now = Date.now()) {
    if (typeof sessionId !== 'string' || sessionId === '') return []
    const months = [...new Set([
      monthKey(now, timeZone),
      monthKey(now - 32 * 24 * 60 * 60 * 1000, timeZone),
    ])]
    const records = []
    const seen = new Set()
    for (const month of months) {
      for (const record of await readMonth(month)) {
        if (record.sessionId !== sessionId) continue
        const identity = [
          record.timestamp, record.turn, record.step, record.model,
          record.inputTokens, record.cacheReadTokens, record.outputTokens,
        ].join('|')
        if (seen.has(identity)) continue
        seen.add(identity)
        records.push(record)
      }
    }
    return records
  }

  /** Segment layout of one month, oldest first, for diagnostics and tests. */
  async function segments(month) {
    return [...(await archivesOf(month)), fileOf(month)]
  }

  /** Wait for every queued append to settle (used by tests and shutdown). */
  async function flush() {
    await tail
  }

  return { dir, append, readMonth, readDay, readSession, segments, flush }
}
