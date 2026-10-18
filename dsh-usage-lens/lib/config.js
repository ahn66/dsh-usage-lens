/**
 * Configuration normalization for the Host half.
 *
 * The plugin deliberately declares no schemastery `Config`, so a linked local
 * bundle needs no resolvable package dependency: every field is read
 * defensively here and falls back to the documented default. Unknown keys are
 * ignored rather than rejected, and a malformed field never prevents
 * activation.
 *
 * @module dsh-usage-lens/lib/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { buildPricingTable } from './pricing.js'
import { DEFAULT_TIME_ZONE } from './time.js'

/** Default size rotation threshold for one ledger file. */
export const DEFAULT_LEDGER_MAX_BYTES = 8 * 1024 * 1024

/** Route path the status bar polls by default. */
export const DEFAULT_STATUS_PATH = '/plugins/dsh-usage-lens/today'
/** Route path the detail panel polls by default. */
export const DEFAULT_SESSION_PATH = '/plugins/dsh-usage-lens/session'
/** Route path the raw-data layer fetches on demand by default. */
export const DEFAULT_RAW_PATH = '/plugins/dsh-usage-lens/raw'

/** Resolve the DeepSeek Harness home directory. */
export function resolveDshHome(env = process.env) {
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim())
  return join(homedir(), '.dsh')
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Normalize the plugin config.
 * @param raw - the `config` object of the plugin's Loader row, if any.
 * @returns resolved settings: ledger directory, zone, route path, pricing table.
 */
export function resolveConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}

  const ledgerDir = (() => {
    const configured = nonEmptyString(config.ledgerDir)
    if (configured === undefined) return join(resolveDshHome(), 'usage-lens')
    return isAbsolute(configured) ? configured : resolve(configured)
  })()

  const statusPath = (() => {
    const configured = nonEmptyString(config.statusPath)
    return configured !== undefined && configured.startsWith('/') ? configured : DEFAULT_STATUS_PATH
  })()

  const sessionPath = (() => {
    const configured = nonEmptyString(config.sessionPath)
    return configured !== undefined && configured.startsWith('/') ? configured : DEFAULT_SESSION_PATH
  })()

  const rawPath = (() => {
    const configured = nonEmptyString(config.rawPath)
    return configured !== undefined && configured.startsWith('/') ? configured : DEFAULT_RAW_PATH
  })()

  const ledgerMaxBytes = (() => {
    const configured = config.ledgerMaxBytes
    if (typeof configured !== 'number' || !Number.isFinite(configured) || configured < 0) {
      return DEFAULT_LEDGER_MAX_BYTES
    }
    return Math.floor(configured)
  })()

  return {
    ledgerDir,
    ledgerMaxBytes,
    statusPath,
    sessionPath,
    rawPath,
    timeZone: nonEmptyString(config.timeZone) ?? DEFAULT_TIME_ZONE,
    pricing: buildPricingTable(config.pricing),
  }
}
