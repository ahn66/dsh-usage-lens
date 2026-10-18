/**
 * Frozen-request Skill extraction.
 *
 * A skill is "loaded" only when its instructions are actually in the request the
 * provider sees. The harness renders one canonical block for both load paths —
 * the `skill` tool result and a user-explicit `/name` injection (AGENTS.md
 * convention 5):
 *
 * ```markdown
 * <skill_content name="office-recalculate">
 * <skill_resources>…</skill_resources>
 * <skill_instructions>…</skill_instructions>
 * </skill_content>
 * ```
 *
 * `<available_skills>` is only the catalog of names and summaries, so it never
 * counts as a load. This module reads the frozen request and nothing else.
 *
 * @module dsh-usage-lens/lib/skill-parse
 */

/** Marker that must appear for any skill text to be present at all. */
const MARKER = '<skill_content'

const BLOCK = /<skill_content\s+name="([^"]*)"\s*>([\s\S]*?)<\/skill_content>/gu
const INSTRUCTIONS = /<skill_instructions>([\s\S]*?)<\/skill_instructions>/u

/** Snippet length kept for the collapsed flow. */
const SNIPPET_CHARS = 240
/** Body length kept for the raw layer. */
const BODY_CHARS = 8000

const ENTITIES = new Map([
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', "'"],
])

/**
 * A real skill id: letters, digits and the punctuation providers use. This is
 * also what keeps documentation *about* the format out of the result: a README
 * quoting `<skill_content name="<escaped-name>">` inside a code fence is not a
 * load, and its placeholder name cannot survive this check.
 */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u

/** Bodies that carry the template's own placeholders are documentation. */
const PLACEHOLDER_BODY = '<provider-owned-instruction-body>'

function unescapeName(value) {
  return value.replace(/&(?:amp|lt|gt|quot|#39);/gu, (entity) => ENTITIES.get(entity) ?? entity)
}

/** Every text block of one request message, in order. */
function messageTexts(message) {
  const texts = []
  if (typeof message?.content === 'string') {
    texts.push(message.content)
    return texts
  }
  for (const block of message?.content ?? []) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text)
    }
  }
  return texts
}

/** Cheap pre-check so an ordinary request costs one `includes` per text block. */
function mayCarrySkills(text) {
  return typeof text === 'string' && text.includes(MARKER)
}

function blocksIn(text) {
  const found = []
  BLOCK.lastIndex = 0
  let match
  while ((match = BLOCK.exec(text)) !== null) {
    const name = unescapeName(match[1].trim())
    if (!SKILL_NAME.test(name)) continue
    const body = match[2]
    if (body.includes(PLACEHOLDER_BODY)) continue
    const instructions = INSTRUCTIONS.exec(body)
    const instructionBody = instructions !== null ? instructions[1] : body
    found.push({
      name,
      snippet: instructionBody.trim().slice(0, SNIPPET_CHARS),
      body: instructionBody.trim().slice(0, BODY_CHARS),
      truncated: instructionBody.trim().length > BODY_CHARS,
    })
  }
  return found
}

/**
 * Every skill actually present in one frozen request.
 * @param request - the intercepted `GenerateOptions`.
 * @returns one entry per `<skill_content>` block: `{ name, snippet, body,
 *   truncated, source, messageIndex }`, where `source` is `tool` when the block
 *   arrived in a tool result and `user` when it arrived in user content.
 */
export function parseRequestSkills(request) {
  if (request === null || typeof request !== 'object') return []
  const found = []
  const seen = new Set()

  const push = (blocks, source, messageIndex) => {
    for (const block of blocks) {
      if (block.name === '') continue
      const identity = `${block.name}|${source}|${messageIndex}`
      if (seen.has(identity)) continue
      seen.add(identity)
      found.push({ ...block, source, messageIndex })
    }
  }

  if (mayCarrySkills(request.system)) push(blocksIn(request.system), 'system', -1)

  const messages = Array.isArray(request.messages) ? request.messages : []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const source = message?.role === 'tool' ? 'tool' : 'user'
    for (const text of messageTexts(message)) {
      if (mayCarrySkills(text)) push(blocksIn(text), source, index)
    }
  }
  return found
}

/** Distinct skill names of a parsed request. */
export function skillNames(skills) {
  const names = []
  for (const skill of skills) if (!names.includes(skill.name)) names.push(skill.name)
  return names
}
