// Skill cross-validation verdict log.
//
// It drives the real collector with the two cases side by side: a `skill` tool
// call that DOES reach the next frozen request, and one that does not. The
// verdict comes only from the request text, which is what AGENTS.md convention 5
// demands.
//
//   node tools/check-skill-check.mjs
import { createTurnCollector } from '../dsh-usage-lens/lib/turns.js'

const block = (name, body) => [
  `<skill_content name="${name}">`,
  '<skill_resources>',
  `Base directory for this skill: /skills/${name}`,
  '</skill_resources>',
  '<skill_instructions>',
  body,
  '</skill_instructions>',
  '</skill_content>',
].join('\n')

const collector = createTurnCollector({ warn: (message) => console.warn('warn:', message) })
const session = 'skill-check-demo'
let clock = 1_000_000
const at = () => (clock += 1000)

const emit = (type, data) => collector.observe({ id: session }, { type, seq: 1, time: at(), data })
const request = (texts) => ({
  sessionId: session,
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  messages: texts.map((text, index) => ({
    role: index === 0 ? 'user' : 'tool',
    content: [{ type: 'text', text }],
  })),
})
const skillCall = (step, callId, name) => {
  emit('tool/call', { turn: 1, step, callId, name: 'skill', arguments: JSON.stringify({ name }) })
  emit('tool/result', {
    turn: 1,
    step,
    message: { toolCallId: callId, isError: false, content: [{ type: 'text', text: block(name, `${name} instructions body`) }] },
  })
}

emit('turn/start', { turn: 1 })

// --- case A: the tool call claims office-xlsx, and the next request has it ---
emit('step/start', { turn: 1, step: 1 })
console.log('step 1: skill tool call name=office-xlsx -> tool result ok (claim only)')
skillCall(1, 'c-a', 'office-xlsx')
emit('step/start', { turn: 1, step: 2 })
const a = collector.noteRequest(request(['go', block('office-xlsx', 'office-xlsx instructions body')]))
for (const verdict of a.resolved) {
  console.log(`  step 2 request: found ${JSON.stringify(a.skills.map((skill) => skill.name))} -> ${verdict.name}: ${verdict.present ? '已生效 (present in the frozen request)' : '调用未生效 (absent)'}`)
}

// --- case B: the tool call claims ghost-skill, and no request ever has it ---
emit('step/start', { turn: 1, step: 3 })
console.log('\nstep 3: skill tool call name=ghost-skill -> tool result ok (claim only)')
skillCall(3, 'c-b', 'ghost-skill')
emit('step/start', { turn: 1, step: 4 })
const b = collector.noteRequest(request(['go', block('office-xlsx', 'office-xlsx instructions body')]))
for (const verdict of b.resolved) {
  console.log(`  step 4 request: found ${JSON.stringify(b.skills.map((skill) => skill.name))} -> ${verdict.name}: ${verdict.present ? '已生效' : '调用未生效 (absent from the frozen request)'}`)
}

console.log('\n=== resulting pins ===')
for (const pin of collector.pins(session)) {
  console.log(`[${pin.kind}/${pin.tone}] step ${pin.step} · ${pin.name} · ${pin.detail}`)
}
