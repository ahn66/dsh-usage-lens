// Print the execution-process block of one session: pinned key steps, then the
// folded flow with its tool summaries.
//
// Usage: node tools/check-process.mjs <sessionId> [--url URL]
const argv = process.argv
const sessionId = argv[2]
const urlFlag = argv.indexOf('--url')
const base = urlFlag === -1 ? 'http://127.0.0.1:3631' : argv[urlFlag + 1]

const document = await (await fetch(`${base}/plugins/dsh-usage-lens/session?sessionId=${encodeURIComponent(sessionId)}`)).json()
if (document.ok !== true) {
  console.error('route error:', JSON.stringify(document))
  process.exit(1)
}

const block = document.process
if (block === undefined) {
  console.error('no process block for this session')
  process.exit(1)
}

const fmtTokens = (value) => {
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) return `${String(Number((value / 1000).toFixed(1)))}k`
  return `${String(Number((value / 1_000_000).toFixed(1)))}M`
}

console.log(`pricing: ${document.pricingVersion}`)
console.log(`process turn: ${block.turn ?? '-'} · open=${block.open} · reason=${block.reason ?? '-'} · steps=${block.steps.length} · pins=${block.pins.length}`)

console.log('\n=== pinned key steps ===')
if (block.pins.length === 0) console.log('(none)')
for (const pin of block.pins) {
  console.log(`[${pin.kind}/${pin.tone}] step ${pin.step ?? '-'} · ${pin.name} · ${pin.detail}${pin.callId !== undefined ? ` · callId=${pin.callId}` : ''}`)
}

console.log('\n=== folded process flow (last 10) ===')
for (const step of block.steps.slice(-10)) {
  const tools = step.tools.map((tool) => `${tool.name}${tool.isError ? '!' : ''}`).join(', ') || '思考'
  console.log(`第 ${step.step} 步 · ${tools} · ${Math.round(step.durationMs)}ms · ${fmtTokens(step.tokens.total)} tok${step.failed ? ' · FAILED' : ''}`)
  if (step.reasoning !== '') console.log(`    reasoning: ${step.reasoning.slice(0, 110)}`)
  for (const tool of step.tools) {
    console.log(`    - ${tool.name} ${tool.durationMs !== undefined ? `${tool.durationMs}ms ` : ''}in: ${tool.argsSummary.slice(0, 80)}`)
    console.log(`      out: ${tool.resultSummary.slice(0, 80)}${tool.errorCode !== undefined ? ` [${tool.errorCode}]` : ''}`)
  }
}
