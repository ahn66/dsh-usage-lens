/**
 * Turn projection: the pure fold the detail panel renders.
 *
 * Inputs are two sources that never overlap: the ledger owns token buckets and
 * money inputs, the turn collector owns `(turn, step)` membership and tool
 * names. A missing collector entry degrades to "tools unknown" — the turn and
 * its per-call rows still come from the ledger, so a Host restart never blanks
 * the panel.
 *
 * Money is computed here, per record, at that record's own instant, and never
 * stored: a price-table change reprices a turn that already happened.
 *
 * @module dsh-usage-lens/lib/aggregator
 */

import { billableTokens, priceRecord } from './pricing.js'

function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function emptyTokens() {
  // `billableInput` and `total` must exist here: they are accumulated with `+=`,
  // so a missing key would turn a whole turn's total into NaN.
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, billableInput: 0, total: 0 }
}

/** Four buckets plus the two derived totals, from one record. */
function tokensOf(record) {
  const tokens = {
    input: tokenCount(record.inputTokens),
    cacheRead: tokenCount(record.cacheReadTokens),
    cacheWrite: tokenCount(record.cacheWriteTokens),
    output: tokenCount(record.outputTokens),
    reasoning: tokenCount(record.reasoningTokens),
  }
  const billableInput = tokens.input + tokens.cacheRead + tokens.cacheWrite
  return { ...tokens, billableInput, total: billableInput + tokens.output }
}

function addTokens(target, tokens) {
  target.input += tokens.input
  target.cacheRead += tokens.cacheRead
  target.cacheWrite += tokens.cacheWrite
  target.output += tokens.output
  target.reasoning += tokens.reasoning
  target.billableInput += tokens.billableInput
  target.total += tokens.total
  return target
}

/** Money bucket of one step or one turn. */
function emptyCost() {
  return { pricedAmount: 0, pricedCalls: 0, unpricedCalls: 0, unpricedTokens: 0, lowerBound: false }
}

function stepTools(turnInfo, step) {
  if (turnInfo === undefined) return []
  const entry = turnInfo.steps?.find((candidate) => candidate.step === step)
  return entry !== undefined && Array.isArray(entry.tools) ? [...entry.tools] : []
}

/**
 * Project one session's turns.
 *
 * Turn totals are sums over the rendered step rows, and the step rows sum over
 * the ledger records, so "card total === sum of expanded rows" holds by
 * construction rather than by a second, drifting calculation.
 * @param options - `records` (ledger rows for the session), `turns` (collector
 *   index, possibly empty), `pricing` (table in force).
 * @returns turns newest first, each with steps ascending by step number.
 */
export function projectSession({ records, turns = [], pricing }) {
  const infoByTurn = new Map()
  for (const info of turns) {
    if (typeof info?.turn === 'number') infoByTurn.set(info.turn, info)
  }

  const rowsByTurn = new Map()
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue
    const turn = typeof record.turn === 'number' && Number.isFinite(record.turn) ? record.turn : 0
    if (!rowsByTurn.has(turn)) rowsByTurn.set(turn, [])
    rowsByTurn.get(turn).push(record)
  }

  const projected = []
  for (const [turn, rows] of rowsByTurn) {
    const info = infoByTurn.get(turn)
    rows.sort((left, right) => {
      const stepDelta = tokenCount(left.step) - tokenCount(right.step)
      if (stepDelta !== 0) return stepDelta
      return String(left.timestamp).localeCompare(String(right.timestamp))
    })

    const turnTokens = emptyTokens()
    const turnCost = emptyCost()
    const turnTools = []
    const statuses = { completed: 0, failed: 0, cancelled: 0 }
    const unpricedModels = new Set()

    const steps = rows.map((record) => {
      const tokens = tokensOf(record)
      const priced = priceRecord(pricing, record)
      const status = typeof record.status === 'string' ? record.status : 'failed'
      const tools = stepTools(info, record.step)
      const step = {
        step: typeof record.step === 'number' ? record.step : 0,
        model: typeof record.model === 'string' ? record.model : '',
        provider: typeof record.provider === 'string' ? record.provider : '',
        tokens,
        cost: {
          priced: priced.priced,
          amount: priced.priced ? priced.amount : 0,
          peak: priced.peak,
        },
        status,
        failed: status !== 'completed',
        timestamp: typeof record.timestamp === 'string' ? record.timestamp : '',
        durationMs: tokenCount(record.durationMs),
        tools,
      }

      addTokens(turnTokens, tokens)
      if (status in statuses) statuses[status] += 1
      if (priced.priced) {
        turnCost.pricedAmount += priced.amount
        turnCost.pricedCalls += 1
      } else {
        turnCost.unpricedCalls += 1
        turnCost.unpricedTokens += billableTokens(record)
        if (typeof record.model === 'string') {
          unpricedModels.add(`${record.provider === '' ? '?' : record.provider}/${record.model}`)
        }
      }
      for (const tool of tools) if (!turnTools.includes(tool)) turnTools.push(tool)
      return step
    })

    // A turn whose collector entry is gone still reports the tools it can see.
    if (info !== undefined && Array.isArray(info.tools)) {
      for (const tool of info.tools) if (!turnTools.includes(tool)) turnTools.push(tool)
    }

    projected.push({
      turn,
      attributed: turn > 0,
      open: info?.open === true,
      startedAt: typeof info?.startedAt === 'number' ? info.startedAt : undefined,
      endedAt: typeof info?.endedAt === 'number' ? info.endedAt : undefined,
      reason: typeof info?.reason === 'string' ? info.reason : undefined,
      calls: steps.length,
      statuses,
      tokens: turnTokens,
      cost: {
        pricedAmount: turnCost.pricedAmount,
        pricedCalls: turnCost.pricedCalls,
        unpricedCalls: turnCost.unpricedCalls,
        unpricedTokens: turnCost.unpricedTokens,
        unpricedModels: [...unpricedModels].sort(),
        lowerBound: turnCost.unpricedCalls > 0,
      },
      toolCount: turnTools.length,
      tools: turnTools,
      steps,
    })
  }

  // Newest turn first: the panel is "本次询问明细", so the turn just run leads.
  projected.sort((left, right) => right.turn - left.turn)
  return projected
}
