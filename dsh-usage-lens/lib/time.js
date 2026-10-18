/**
 * Beijing (Asia/Shanghai) wall-clock helpers.
 *
 * Every timestamp the plugin persists or displays is resolved through the IANA
 * zone rather than the host's local clock, so a machine in another time zone
 * still bills and groups by Beijing calendar days (AGENTS.md convention 8).
 *
 * @module dsh-usage-lens/lib/time
 */

/** Default zone for day bucketing and peak/off-peak decisions. */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

const formatterCache = new Map()

function formatterFor(timeZone) {
  let formatter = formatterCache.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatterCache.set(timeZone, formatter)
  }
  return formatter
}

const pad2 = (value) => String(value).padStart(2, '0')

/**
 * Resolve one instant into wall-clock fields of a zone.
 * @param epochMs - instant in epoch milliseconds.
 * @param timeZone - IANA zone name.
 * @returns wall-clock fields plus the ISO weekday (0 = Sunday).
 */
export function zonedParts(epochMs, timeZone = DEFAULT_TIME_ZONE) {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs))
  const bag = {}
  for (const part of parts) if (part.type !== 'literal') bag[part.type] = part.value
  const year = Number(bag.year)
  const month = Number(bag.month)
  const day = Number(bag.day)
  const hour = Number(bag.hour) % 24
  const minute = Number(bag.minute)
  const second = Number(bag.second)
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return { year, month, day, hour, minute, second, weekday }
}

/** Zone-local calendar day key, `YYYY-MM-DD`. */
export function dateKey(epochMs, timeZone = DEFAULT_TIME_ZONE) {
  const { year, month, day } = zonedParts(epochMs, timeZone)
  return `${year}-${pad2(month)}-${pad2(day)}`
}

/** Zone-local calendar month key, `YYYY-MM`. */
export function monthKey(epochMs, timeZone = DEFAULT_TIME_ZONE) {
  const { year, month } = zonedParts(epochMs, timeZone)
  return `${year}-${pad2(month)}`
}

/** Clock text `HH:mm` in the zone. */
export function clockText(epochMs, timeZone = DEFAULT_TIME_ZONE) {
  const { hour, minute } = zonedParts(epochMs, timeZone)
  return `${pad2(hour)}:${pad2(minute)}`
}

/**
 * Render one instant as ISO 8601 with the zone's real UTC offset, e.g.
 * `2026-10-18T10:23:00+08:00`.
 * @param epochMs - instant in epoch milliseconds.
 * @param timeZone - IANA zone name.
 */
export function isoWithOffset(epochMs, timeZone = DEFAULT_TIME_ZONE) {
  const parts = zonedParts(epochMs, timeZone)
  const wallAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  const offsetMinutes = Math.round((wallAsUtc - epochMs) / 60_000)
  const sign = offsetMinutes < 0 ? '-' : '+'
  const absolute = Math.abs(offsetMinutes)
  return (
    `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`
    + `T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`
    + `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`
  )
}

/**
 * Decide whether one instant falls in a peak window.
 *
 * Peak is Monday–Friday excluding configured statutory holidays, inside one of
 * the configured half-open `[startMinutes, endMinutes)` windows.
 * @param epochMs - instant in epoch milliseconds.
 * @param table - pricing table carrying `timeZone`, `peakDays`,
 *   `peakWindows` (in minutes) and `holidays` (day keys).
 */
export function isPeakInstant(epochMs, table) {
  const timeZone = table.timeZone ?? DEFAULT_TIME_ZONE
  const parts = zonedParts(epochMs, timeZone)
  const dayKey = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`
  const holidays = table.holidays ?? []
  if (holidays.includes(dayKey)) return false
  if (!(table.peakDays ?? []).includes(parts.weekday)) return false
  const minutes = parts.hour * 60 + parts.minute
  return (table.peakWindows ?? []).some(
    ([start, end]) => minutes >= start && minutes < end,
  )
}

/** True for a syntactically valid `YYYY-MM-DD` day key. */
export function isDayKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
}
