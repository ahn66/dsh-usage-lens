/**
 * Turn/step collector: the `session/event` half of the accounting.
 *
 * It owns three narrow facts and nothing else:
 * 1. which `(turn, step)` a provider call belongs to — plus the tool names and
 *    per-call detail seen inside each step;
 * 2. the four kinds of pinned key step (Skill load, tool failure, approval or
 *    permission denial, sub-agent dispatch);
 * 3. the raw payloads the "查看原始" layer may show on demand.
 *
 * It never stores tokens and never re-reads the session log: the ledger stays
 * the durable token record, and this is a live index beside it.
 *
 * Why the call can be attributed before its `assistant/message` exists: the
 * agent loop appends `step/start` *before* dispatching the model call, and
 * `session/event` dispatches post-commit, synchronously. So when the stream
 * interceptor settles in its `finally`, the current step is already known.
 *
 * Boundary handling:
 * - a turn with no `turn/end` stays `open` (an interrupted turn is still a
 *   real turn);
 * - a new `turn/start` closes any earlier still-open turn, so the projection
 *   never reports two open turns;
 * - state is keyed by `session.id`, so concurrent subagent sessions cannot
 *   contaminate each other.
 *
 * @module dsh-usage-lens/lib/turns
 */

import { parseRequestSkills, skillNames } from './skill-parse.js'

/** How many sessions keep a live turn index. */
const MAX_SESSIONS = 200
/** How many turns per session; the oldest closed turn is dropped first. */
const MAX_TURNS_PER_SESSION = 60
/** How many steps per turn keep detail. */
const MAX_STEPS_PER_TURN = 160
/** How many pins one session keeps. */
const MAX_PINS = 80
/** Raw payload caps: enough to inspect, bounded so a long session stays cheap. */
const RAW_ARGS_CHARS = 4000
const RAW_RESULT_CHARS = 8000
const RAW_TEXT_CHARS = 1600

function integerOr(value, fallback) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback
}

function textOf(value, limit = RAW_TEXT_CHARS) {
  const text = typeof value === 'string' ? value : ''
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Flatten one content-block array into plain text, bounded. */
function contentText(content, limit = RAW_RESULT_CHARS) {
  if (typeof content === 'string') return textOf(content, limit)
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text)
    if (parts.join('\n').length > limit) break
  }
  return textOf(parts.join('\n'), limit)
}

function createTurn(turn, at) {
  return {
    turn,
    startedAt: at,
    endedAt: undefined,
    reason: undefined,
    open: true,
    steps: new Map(),
    tools: [],
  }
}

function createStep(step, at) {
  return {
    step,
    startedAt: at,
    endedAt: undefined,
    tools: [],
    calls: new Map(),
    reasoning: '',
    text: '',
    skills: [],
    request: undefined,
  }
}

/**
 * Create the collector.
 * @param options - `warn` for contained failures, `now` for tests.
 */
export function createTurnCollector({ warn = () => {}, now = () => Date.now() } = {}) {
  /** sessionId -> { turns, pins, pendingSkills, approvals, currentTurn, currentStep, touchedAt } */
  const sessions = new Map()

  function evictSessionsIfNeeded() {
    if (sessions.size <= MAX_SESSIONS) return
    const oldest = [...sessions.entries()]
      .sort((left, right) => left[1].touchedAt - right[1].touchedAt)
      .slice(0, sessions.size - MAX_SESSIONS)
    for (const [id] of oldest) sessions.delete(id)
  }

  function sessionState(sessionId) {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = {
        turns: new Map(),
        pins: [],
        pendingSkills: [],
        approvals: new Map(),
        currentTurn: undefined,
        currentStep: undefined,
        touchedAt: now(),
      }
      sessions.set(sessionId, state)
      evictSessionsIfNeeded()
    }
    state.touchedAt = now()
    return state
  }

  /** Keep the per-session turn map bounded, dropping the oldest closed turn. */
  function pruneTurns(state) {
    if (state.turns.size <= MAX_TURNS_PER_SESSION) return
    const closed = [...state.turns.values()].filter((turn) => !turn.open).sort((a, b) => a.turn - b.turn)
    let excess = state.turns.size - MAX_TURNS_PER_SESSION
    for (const turn of closed) {
      if (excess <= 0) break
      state.turns.delete(turn.turn)
      excess -= 1
    }
  }

  function turnState(state, turn, at) {
    let entry = state.turns.get(turn)
    if (entry === undefined) {
      entry = createTurn(turn, at)
      state.turns.set(turn, entry)
      pruneTurns(state)
    }
    return entry
  }

  function stepState(turnEntry, step, at) {
    let entry = turnEntry.steps.get(step)
    if (entry === undefined) {
      entry = createStep(step, at)
      if (turnEntry.steps.size >= MAX_STEPS_PER_TURN) {
        const oldestClosed = [...turnEntry.steps.values()]
          .filter((candidate) => candidate.endedAt !== undefined)
          .sort((left, right) => left.step - right.step)[0]
        if (oldestClosed !== undefined) turnEntry.steps.delete(oldestClosed.step)
      }
      turnEntry.steps.set(step, entry)
    }
    return entry
  }

  function addToolName(turnEntry, stepEntry, name) {
    if (typeof name !== 'string' || name === '') return
    if (!stepEntry.tools.includes(name)) stepEntry.tools.push(name)
    if (!turnEntry.tools.includes(name)) turnEntry.tools.push(name)
  }

  // --- pins ---------------------------------------------------------------

  /** Insert or replace one pin, keyed so a later outcome upgrades it in place. */
  function upsertPin(state, pin) {
    const existing = state.pins.findIndex((candidate) => candidate.key === pin.key)
    if (existing !== -1) {
      state.pins[existing] = { ...state.pins[existing], ...pin }
      return state.pins[existing]
    }
    const created = { id: `pin-${state.pins.length + 1}-${pin.key}`, at: now(), ...pin }
    state.pins.push(created)
    if (state.pins.length > MAX_PINS) state.pins.splice(0, state.pins.length - MAX_PINS)
    return created
  }

  function pinToolError(state, turn, step, entry) {
    const code = entry.errorCode !== undefined ? entry.errorCode : entry.errorReason
    upsertPin(state, {
      key: `tool:${entry.callId}`,
      kind: 'tool-error',
      tone: 'error',
      turn,
      step,
      name: entry.name,
      detail: typeof code === 'string' && code !== '' ? code : 'error',
      callId: entry.callId,
    })
  }

  // --- turn/step events ---------------------------------------------------

  function observe(session, event) {
    try {
      const sessionId = typeof session?.id === 'string' ? session.id : undefined
      if (sessionId === undefined || event === null || typeof event !== 'object') return
      const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
      const at = typeof event.time === 'number' ? event.time : now()
      const state = sessionState(sessionId)

      switch (event.type) {
        case 'turn/start': {
          const turn = integerOr(data.turn, undefined)
          if (turn === undefined) return
          for (const other of state.turns.values()) {
            if (other.turn !== turn && other.open) {
              other.open = false
              other.endedAt ??= at
              other.reason ??= 'superseded'
            }
          }
          const entry = turnState(state, turn, at)
          entry.startedAt = at
          entry.endedAt = undefined
          entry.open = true
          state.currentTurn = turn
          state.currentStep = undefined
          return
        }
        case 'turn/end': {
          const turn = integerOr(data.turn, state.currentTurn)
          if (turn === undefined) return
          const entry = turnState(state, turn, at)
          entry.open = false
          entry.endedAt = at
          entry.reason = typeof data.reason?.kind === 'string' ? data.reason.kind : 'unknown'
          if (state.currentTurn === turn) state.currentStep = undefined
          return
        }
        case 'step/start': {
          const turn = integerOr(data.turn, state.currentTurn)
          const step = integerOr(data.step, undefined)
          if (turn === undefined || step === undefined) return
          const entry = turnState(state, turn, at)
          const stepEntry = stepState(entry, step, at)
          stepEntry.startedAt = at
          state.currentTurn = turn
          state.currentStep = step
          return
        }
        case 'step/end': {
          const turn = integerOr(data.turn, state.currentTurn)
          const step = integerOr(data.step, state.currentStep)
          if (turn === undefined || step === undefined) return
          const entry = turnState(state, turn, at)
          stepState(entry, step, at).endedAt = at
          return
        }
        case 'tool/call': {
          const turn = integerOr(data.turn, state.currentTurn)
          const step = integerOr(data.step, state.currentStep)
          if (turn === undefined || step === undefined) return
          const turnEntry = turnState(state, turn, at)
          const stepEntry = stepState(turnEntry, step, at)
          addToolName(turnEntry, stepEntry, data.name)
          const callId = typeof data.callId === 'string' ? data.callId : String(data.callId ?? '')
          if (callId !== '' && !stepEntry.calls.has(callId)) {
            stepEntry.calls.set(callId, {
              callId,
              name: typeof data.name === 'string' ? data.name : '',
              at,
              endedAt: undefined,
              argsRaw: textOf(typeof data.arguments === 'string' ? data.arguments : '', RAW_ARGS_CHARS),
              argsSummary: textOf(typeof data.arguments === 'string' ? data.arguments : '', 160),
              resultRaw: '',
              resultSummary: '',
              isError: false,
              errorCode: undefined,
              errorReason: undefined,
            })
          }
          return
        }
        case 'tool/result': {
          const turn = integerOr(data.turn, state.currentTurn)
          const step = integerOr(data.step, state.currentStep)
          if (turn === undefined || step === undefined) return
          const turnEntry = turnState(state, turn, at)
          const stepEntry = stepState(turnEntry, step, at)
          const callId = typeof data.message?.toolCallId === 'string'
            ? data.message.toolCallId
            : (typeof data.callId === 'string' ? data.callId : '')
          const entry = callId === '' ? undefined : stepEntry.calls.get(callId)
          const isError = data.message?.isError === true || data.error !== undefined
          const resultText = contentText(data.message?.content)
          if (entry !== undefined) {
            entry.endedAt = at
            entry.resultRaw = resultText
            entry.resultSummary = textOf(resultText, 200)
            entry.isError = isError
            entry.errorCode = typeof data.error?.code === 'string' ? data.error.code : undefined
            entry.errorReason = typeof data.error?.reason === 'string' ? data.error.reason : undefined
          }
          if (isError) {
            if (entry !== undefined) pinToolError(state, turn, step, entry)
            else {
              upsertPin(state, {
                key: `tool:${callId || `${turn}/${step}`}`,
                kind: 'tool-error',
                tone: 'error',
                turn,
                step,
                name: typeof data.error?.name === 'string' ? data.error.name : '',
                detail: typeof data.error?.code === 'string' ? data.error.code : 'error',
              })
            }
          }
          // A successful `skill` call is only a claim; the next frozen request
          // decides whether the instructions actually reached the model.
          if (!isError && entry !== undefined && entry.name === 'skill') {
            const name = skillNameFrom(entry) ?? skillNameFromText(resultText)
            if (name !== undefined) {
              const skillBody = skillBodyFromText(resultText)
              state.pendingSkills.push({
                name,
                turn,
                step,
                at,
                callId,
                body: skillBody.body,
                truncated: skillBody.truncated,
                snippet: skillBody.snippet,
              })
            }
          }
          return
        }
        case 'assistant/message': {
          const turn = integerOr(data.turn, state.currentTurn)
          const step = integerOr(data.step, state.currentStep)
          if (turn === undefined) return
          const turnEntry = turnState(state, turn, at)
          const stepEntry = step !== undefined ? stepState(turnEntry, step, at) : undefined
          if (stepEntry !== undefined) {
            const reasoning = []
            const text = []
            for (const block of data.message?.content ?? []) {
              if (block?.type === 'reasoning' && typeof block.text === 'string') reasoning.push(block.text)
              else if (block?.type === 'text' && typeof block.text === 'string') text.push(block.text)
            }
            if (reasoning.length > 0) stepEntry.reasoning = textOf(reasoning.join('\n'), 600)
            if (text.length > 0) stepEntry.text = textOf(text.join('\n'), 600)
          }
          return
        }
        case 'approval/asked': {
          const asked = {
            id: typeof data.id === 'string' ? data.id : '',
            toolName: typeof data.toolName === 'string' ? data.toolName : '',
            reason: typeof data.reason === 'string' ? data.reason : '',
            turn: state.currentTurn,
            step: state.currentStep,
          }
          if (asked.id !== '') state.approvals.set(asked.id, asked)
          upsertPin(state, {
            key: `approval:${asked.id}`,
            kind: 'approval-asked',
            tone: 'info',
            turn: state.currentTurn,
            step: state.currentStep,
            name: asked.toolName,
            detail: asked.reason,
            callId: typeof data.callId === 'string' ? data.callId : undefined,
          })
          return
        }
        case 'approval/decided': {
          const id = typeof data.id === 'string' ? data.id : ''
          const outcome = typeof data.outcome === 'string' ? data.outcome : 'unknown'
          const asked = state.approvals.get(id)
          const denied = outcome !== 'allowed-once'
          upsertPin(state, {
            key: `approval:${id}`,
            kind: denied ? 'approval-denied' : 'approval-allowed',
            tone: denied ? 'error' : 'ok',
            turn: asked?.turn ?? state.currentTurn,
            step: asked?.step ?? state.currentStep,
            name: asked?.toolName ?? '',
            detail: outcome,
            callId: undefined,
          })
          if (asked !== undefined) state.approvals.delete(id)
          return
        }
        case 'subagent/catalog': {
          const childId = typeof data.childId === 'string' ? data.childId : ''
          upsertPin(state, {
            key: `subagent:${childId}`,
            kind: 'subagent',
            tone: 'info',
            turn: state.currentTurn,
            step: state.currentStep,
            name: typeof data.label === 'string' && data.label !== '' ? data.label : childId,
            detail: childId,
            callId: undefined,
          })
          return
        }
        default:
          return
      }
    } catch (error) {
      warn(`turn collector failed on ${String(event?.type)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function skillNameFrom(entry) {
    try {
      const parsed = JSON.parse(entry.argsRaw)
      const name = parsed?.name
      return typeof name === 'string' && name !== '' ? name : undefined
    } catch {
      return undefined
    }
  }

  function skillNameFromText(text) {
    const marker = /<skill_content\s+name="([^"]*)"/u.exec(typeof text === 'string' ? text : '')
    return marker === null ? undefined : marker[1]
  }

  function skillBodyFromText(text) {
    const source = typeof text === 'string' ? text : ''
    const marker = /<skill_instructions>([\s\S]*?)<\/skill_instructions>/u.exec(source)
    const body = (marker !== null ? marker[1] : source).trim()
    return {
      snippet: body.slice(0, 240),
      body: textOf(body, RAW_RESULT_CHARS),
      truncated: body.length > RAW_RESULT_CHARS,
    }
  }

  /**
   * Record one frozen request: its envelope for the process flow, and the
   * Skill cross-check the pinned layer reports.
   * @param request - the intercepted `GenerateOptions`.
   * @returns `{ skills, resolved }` for logging and tests.
   */
  function noteRequest(request) {
    try {
      const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : undefined
      if (sessionId === undefined) return { skills: [], resolved: [] }
      const state = sessions.get(sessionId)
      const skills = parseRequestSkills(request)
      const names = skillNames(skills)
      if (state === undefined) return { skills, resolved: [] }

      const turn = state.currentTurn
      const step = state.currentStep
      if (turn !== undefined && step !== undefined) {
        const stepEntry = stepState(turnState(state, turn, now()), step, now())
        stepEntry.request = {
          provider: typeof request.provider === 'string' ? request.provider : '',
          model: typeof request.model === 'string' ? request.model : '',
          messages: Array.isArray(request.messages) ? request.messages.length : 0,
          systemChars: typeof request.system === 'string' ? request.system.length : 0,
          tools: Array.isArray(request.tools) ? request.tools.length : 0,
          skills: names,
        }
      }

      const resolved = []
      for (const pending of state.pendingSkills) {
        const present = names.includes(pending.name)
        upsertPin(state, {
          key: `skill:${pending.name}`,
          kind: present ? 'skill-loaded' : 'skill-not-effective',
          tone: present ? 'ok' : 'error',
          turn: pending.turn,
          step: pending.step,
          name: pending.name,
          detail: present ? `request:${turn ?? '?'}/${step ?? '?'}` : 'absent',
          body: pending.body,
          truncated: pending.truncated,
          snippet: pending.snippet,
          verifiedAtStep: present ? step : undefined,
        })
        resolved.push({ name: pending.name, present, toolStep: pending.step, requestStep: step })
      }
      state.pendingSkills = []

      // A skill present without a `skill` tool claim came from user content —
      // an explicit `/name` gesture injects it into this very step. Tool-role
      // blocks without a claim are history from before this Host loaded (or
      // from another step already pinned), so they are not re-pinned here.
      for (const skill of skills) {
        if (skill.source !== 'user' && skill.source !== 'system') continue
        if (state.pins.some((pin) => pin.key === `skill:${skill.name}`)) continue
        upsertPin(state, {
          key: `skill:${skill.name}`,
          kind: 'skill-loaded',
          tone: 'ok',
          turn,
          step,
          name: skill.name,
          detail: `injected:${turn ?? '?'}/${step ?? '?'}`,
          body: skill.body,
          truncated: skill.truncated,
          snippet: skill.snippet,
          verifiedAtStep: step,
        })
      }
      return { skills, resolved }
    } catch (error) {
      warn(`skill cross-check failed: ${error instanceof Error ? error.message : String(error)}`)
      return { skills: [], resolved: [] }
    }
  }

  /** Record one `tools/pre-execute` denial without changing the decision. */
  function noteToolDecision(exec, decision) {
    try {
      const sessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id : undefined
      if (sessionId === undefined) return
      if (decision === null || typeof decision !== 'object') return
      if (decision.kind !== 'deny' && decision.kind !== 'cancel') return
      const state = sessionState(sessionId)
      upsertPin(state, {
        key: `perm:${exec.callId}`,
        kind: 'permission-denied',
        tone: 'warn',
        turn: state.currentTurn,
        step: state.currentStep,
        name: typeof exec.name === 'string' ? exec.name : '',
        detail: decision.kind === 'deny'
          ? textOf(typeof decision.reason === 'string' ? decision.reason : 'denied', 200)
          : 'cancelled',
        callId: exec.callId,
      })
    } catch (error) {
      warn(`tool decision observation failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * The `(turn, step)` a settling provider call belongs to.
   * @param sessionId - the call's session.
   * @returns `{ turn, step }`, or `undefined` when no step is known.
   */
  function context(sessionId) {
    if (typeof sessionId !== 'string') return undefined
    const state = sessions.get(sessionId)
    if (state === undefined) return undefined
    if (state.currentTurn === undefined || state.currentStep === undefined) return undefined
    return { turn: state.currentTurn, step: state.currentStep }
  }

  /**
   * Serializable turn index for one session. Slice-2 fields are unchanged; the
   * slice-3 additions (`reasoning`, `calls`, `request`, `skills`) ride alongside.
   * @param sessionId - the session to describe.
   */
  function sessionTurns(sessionId) {
    if (typeof sessionId !== 'string') return []
    const state = sessions.get(sessionId)
    if (state === undefined) return []
    return [...state.turns.values()]
      .sort((left, right) => left.turn - right.turn)
      .map((turn) => ({
        turn: turn.turn,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
        reason: turn.reason,
        open: turn.open,
        tools: [...turn.tools],
        steps: [...turn.steps.values()]
          .sort((left, right) => left.step - right.step)
          .map((step) => ({
            step: step.step,
            startedAt: step.startedAt,
            endedAt: step.endedAt,
            tools: [...step.tools],
            reasoning: step.reasoning,
            text: step.text,
            skills: [...step.skills],
            request: step.request,
            calls: [...step.calls.values()].map((call) => ({
              callId: call.callId,
              name: call.name,
              at: call.at,
              endedAt: call.endedAt,
              argsSummary: call.argsSummary,
              resultSummary: call.resultSummary,
              isError: call.isError,
              errorCode: call.errorCode,
              errorReason: call.errorReason,
            })),
          })),
      }))
  }

  /** Pins of one session, oldest first. */
  function pins(sessionId) {
    if (typeof sessionId !== 'string') return []
    const state = sessions.get(sessionId)
    if (state === undefined) return []
    return state.pins.map((pin) => ({ ...pin }))
  }

  /**
   * One raw payload, for the "查看原始" layer.
   * @param sessionId - the owning session.
   * @param query - `{ turn, step, kind, callId, name }`; kind is `args`,
   *   `result`, `request` or `skill`.
   */
  function raw(sessionId, { turn, step, kind, callId, name }) {
    const state = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
    if (state === undefined) return undefined
    const turnEntry = state.turns.get(integerOr(turn, -1))
    if (turnEntry === undefined) return undefined
    const stepEntry = turnEntry.steps.get(integerOr(step, -1))
    if (stepEntry === undefined) return undefined

    if (kind === 'skill') {
      const pin = state.pins.find((candidate) => candidate.kind === 'skill-loaded' && candidate.name === name)
      if (pin === undefined) return undefined
      return { kind, label: pin.name, text: pin.body ?? '', truncated: pin.truncated === true }
    }
    if (kind === 'request') {
      return {
        kind,
        label: `request ${turn}/${step}`,
        text: JSON.stringify(stepEntry.request ?? { note: 'no request captured for this step' }, null, 2),
        truncated: false,
      }
    }
    const entry = stepEntry.calls.get(typeof callId === 'string' ? callId : '')
    if (entry === undefined) return undefined
    if (kind === 'args') {
      return { kind, label: `${entry.name} arguments`, text: entry.argsRaw, truncated: entry.argsRaw.length >= RAW_ARGS_CHARS }
    }
    return { kind, label: `${entry.name} result`, text: entry.resultRaw, truncated: entry.resultRaw.length >= RAW_RESULT_CHARS }
  }

  /** Drop one session's index (session closed). */
  function forget(sessionId) {
    sessions.delete(sessionId)
  }

  return { observe, noteRequest, noteToolDecision, context, sessionTurns, pins, raw, forget }
}
