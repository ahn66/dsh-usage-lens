/**
 * Execution-process projection: the "执行过程" block's data.
 *
 * Three layers, one document:
 * - `pins` — the fixed pinned rule set (Skill load, tool failure, approval or
 *   permission denial, sub-agent dispatch), newest last, each citing the step it
 *   belongs to so the panel can jump there;
 * - `steps` — the folded process flow, one entry per step with its tool calls,
 *   their summaries, timings and tokens;
 * - nothing raw. Raw payloads are fetched only when a person asks for them, by
 *   the separate raw route.
 *
 * Tokens come from the ledger, everything else from the live collector, so a
 * Host restart degrades only the process detail — never the numbers.
 *
 * @module dsh-usage-lens/lib/process
 */

/** How many of the newest steps the flow keeps. */
const MAX_FLOW_STEPS = 80

function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function tokensOf(record) {
  const input = tokenCount(record?.inputTokens)
  const cacheRead = tokenCount(record?.cacheReadTokens)
  const cacheWrite = tokenCount(record?.cacheWriteTokens)
  const output = tokenCount(record?.outputTokens)
  return {
    input,
    cacheRead,
    cacheWrite,
    output,
    reasoning: tokenCount(record?.reasoningTokens),
    billableInput: input + cacheRead + cacheWrite,
    total: input + cacheRead + cacheWrite + output,
  }
}

function pinView(pin) {
  return {
    id: pin.id,
    kind: pin.kind,
    tone: pin.tone,
    step: typeof pin.step === 'number' ? pin.step : undefined,
    turn: typeof pin.turn === 'number' ? pin.turn : undefined,
    name: typeof pin.name === 'string' ? pin.name : '',
    detail: typeof pin.detail === 'string' ? pin.detail : '',
    callId: pin.callId,
    at: pin.at,
  }
}

/**
 * Build the execution-process document for one turn.
 * @param options - `turn` (the collector's turn entry for the chosen turn),
 *   `records` (ledger rows of that turn), `pins` (collector pins of the session).
 */
export function projectProcess({ turn, records = [], pins = [] }) {
  const rowsByStep = new Map()
  for (const record of records) {
    const step = typeof record.step === 'number' ? record.step : 0
    if (!rowsByStep.has(step)) rowsByStep.set(step, [])
    rowsByStep.get(step).push(record)
  }

  const collectorSteps = new Map()
  for (const step of turn?.steps ?? []) collectorSteps.set(step.step, step)

  const stepNumbers = [...new Set([...rowsByStep.keys(), ...collectorSteps.keys()])]
    .filter((step) => step > 0)
    .sort((left, right) => left - right)

  const steps = stepNumbers.map((step) => {
    const rows = [...(rowsByStep.get(step) ?? [])].sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)))
    const tokens = rows.reduce((total, row) => {
      const next = tokensOf(row)
      total.input += next.input
      total.cacheRead += next.cacheRead
      total.cacheWrite += next.cacheWrite
      total.output += next.output
      total.reasoning += next.reasoning
      total.billableInput += next.billableInput
      total.total += next.total
      return total
    }, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, billableInput: 0, total: 0 })

    const info = collectorSteps.get(step)
    const calls = info?.calls ?? []
    const statuses = rows.map((row) => (typeof row.status === 'string' ? row.status : 'failed'))
    const startedAt = info?.startedAt
    const endedAt = info?.endedAt ?? rows[rows.length - 1]?.timestamp

    return {
      step,
      startedAt,
      endedAt,
      durationMs: rows.reduce((total, row) => total + tokenCount(row.durationMs), 0),
      model: rows[0]?.model ?? undefined,
      tokens,
      status: statuses.includes('failed') ? 'failed' : statuses.includes('cancelled') ? 'cancelled' : 'completed',
      failed: statuses.some((status) => status !== 'completed'),
      reasoning: typeof info?.reasoning === 'string' ? info.reasoning : '',
      text: typeof info?.text === 'string' ? info.text : '',
      skills: Array.isArray(info?.skills) ? [...info.skills] : [],
      request: info?.request,
      tools: calls.map((call) => ({
        callId: call.callId,
        name: call.name,
        argsSummary: call.argsSummary,
        resultSummary: call.resultSummary,
        isError: call.isError === true,
        errorCode: call.errorCode,
        durationMs: call.endedAt !== undefined && call.at !== undefined
          ? Math.max(0, call.endedAt - call.at)
          : undefined,
      })),
    }
  })

  const kept = steps.slice(-MAX_FLOW_STEPS)
  const turnPins = pins
    .filter((pin) => pin.turn === turn?.turn || pin.turn === undefined)
    .map(pinView)

  return {
    turn: typeof turn?.turn === 'number' ? turn.turn : undefined,
    open: turn?.open === true,
    reason: typeof turn?.reason === 'string' ? turn.reason : undefined,
    startedAt: turn?.startedAt,
    endedAt: turn?.endedAt,
    pins: turnPins,
    steps: kept,
    truncated: steps.length > kept.length,
  }
}
