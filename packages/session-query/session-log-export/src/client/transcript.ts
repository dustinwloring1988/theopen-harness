/** Human-readable Markdown transcripts serialized from assembled conversation nodes. */

import type {
  AssistantBlock, CommandNode, ConversationNode, ModelRetryNode,
  SessionId, ToolCallBlock,
} from '@buckeyestudio/toh-client-runtime/client'
import type { ContentBlock } from '@buckeyestudio/toh-llm/types'

/** Char budget applied to every fenced tool argument/result excerpt. */
const EXCERPT_CHAR_LIMIT = 600

/** One serialization input: the assembled conversation window plus its identity. */
export interface TranscriptSource {
  /** Session whose conversation is serialized. */
  readonly sessionId: SessionId
  /** Finalized conversation nodes in chronological order (the client's loaded window). */
  readonly nodes: readonly ConversationNode[]
  /** Export timestamp; defaults to now. */
  readonly exportedAt?: Date
}

/**
 * Serialize one conversation into a clean GFM transcript: speaker-labeled
 * sections, assistant turn annotations, fenced tool-call summaries, elided
 * reasoning and context machinery, and bounded excerpts. Prose is escaped so
 * transcript text cannot inject raw HTML, document headings, blockquotes,
 * horizontal rules, or code fences; fenced content stays verbatim behind a
 * fence run longer than any run it contains.
 * @param source - session identity and assembled nodes.
 * @returns the complete Markdown document.
 */
export function serializeSessionTranscript(source: TranscriptSource): string {
  const sections: string[] = []
  let entries = 0
  const emit = (section: string | null): void => {
    if (section === null) return
    entries += 1
    sections.push(section)
  }

  for (const node of source.nodes) emit(sectionFor(node))

  return [
    [
      '# Session transcript',
      '',
      `- Session: ${String(source.sessionId)}`,
      `- Exported: ${(source.exportedAt ?? new Date()).toISOString()}`,
      `- Entries: ${entries}`,
    ].join('\n'),
    ...sections,
  ].join('\n\n')
}

/**
 * Render one conversation node, or null when it carries no transcript content.
 * @param node - finalized conversation node.
 * @returns its Markdown section, or null for skipped machinery.
 */
function sectionFor(node: ConversationNode): string | null {
  switch (node.kind) {
    case 'user':
      return messageSection('User', node.content)
    case 'steering':
      return messageSection('Steering', node.content)
    case 'assistant':
      return assistantSection(node.blocks, node.turn)
    case 'tool-result':
      return toolResultSection(node.callId, node.call?.name ?? null, node.isError, node.content, node.subCalls)
    case 'command':
      return commandSection(node)
    case 'compaction':
      return compactionNote(node.summary, node.shadowedItemCount)
    case 'model-retry':
      return retryNote(node)
    case 'turn-error':
      return quoteNote(`Turn failed: ${node.message}`)
    case 'turn-max-tokens':
      return quoteNote('Turn ended at the output token cap.')
    case 'unknown':
      return quoteNote(`Unsupported entry: ${node.type}.`)
    // Context injections are harness machinery, not conversation content.
    case 'context':
      return null
    // SessionEventMap is merge-extensible: later node kinds fall through silently
    // until this serializer learns them.
    default:
      return null
  }
}

/**
 * Render one human message section.
 * @param label - speaker label.
 * @param content - durable content blocks.
 * @returns the section, or null when no block contributes text.
 */
function messageSection(label: string, content: readonly ContentBlock[]): string | null {
  return proseSection(label, proseOfBlocks(content))
}

/**
 * Flatten content blocks to transcript prose: text verbatim, images as placeholders.
 * @param blocks - durable content blocks.
 * @returns flattened prose, or '' when nothing contributes.
 */
function proseOfBlocks(blocks: readonly ContentBlock[]): string {
  const parts = blocks.map((block) => {
    switch (block.type) {
      case 'text':
        return block.text
      case 'image':
        return '[image attachment]'
      default:
        return ''
    }
  }).filter(part => part !== '')
  return parts.join('\n\n')
}

/**
 * Render one assistant section with its turn annotation, visible prose, and
 * per-call request fences; reasoning blocks are elided.
 * @param blocks - UI-classified assistant blocks.
 * @param turn - owning turn number.
 * @returns the section, or null when no block contributes content.
 */
function assistantSection(blocks: readonly AssistantBlock[], turn: number): string | null {
  const parts = blocks.map((block) => {
    switch (block.kind) {
      case 'text':
        return escapeProse(block.text)
      case 'tool-call':
        return toolCallPart(block.name, block.argsRaw)
      case 'reasoning':
        return ''
      case 'image':
        return '[image attachment]'
      default:
        return ''
    }
  }).filter(part => part !== '')
  if (parts.length === 0) return null
  return section(`## Assistant (turn ${turn})`, parts.join('\n\n'))
}

/**
 * Render one tool-request summary: name plus compact verbatim arguments.
 * @param name - called tool name.
 * @param argsRaw - raw JSON arguments as produced by the model.
 * @returns the fenced summary, or the no-arguments fallback.
 */
function toolCallPart(name: string, argsRaw: string): string {
  if (argsRaw.trim() === '') return `${sectionHeading(3, `Tool call: ${name}`)}\n\nNo arguments.`
  return `${sectionHeading(3, `Tool call: ${name}`)}\n\n${fenced('json', excerpt(argsRaw))}`
}

/**
 * Render one flow-level tool result: resolved name, error flag, compact output
 * excerpt, and direct subcall names.
 * @param callId - pairing id used when the call head fell outside the window.
 * @param name - called tool name, or null without an in-window call head.
 * @param isError - whether the tool reported a failure.
 * @param content - durable result blocks.
 * @param subCalls - child calls owned by the root call.
 * @returns the section.
 */
function toolResultSection(
  callId: string,
  name: string | null,
  isError: boolean,
  content: readonly ContentBlock[],
  subCalls: readonly ToolCallBlock[],
): string | null {
  const heading = sectionHeading(3, `Tool result: ${name ?? callId}${isError ? ' (error)' : ''}`)
  const parts = [heading]
  if (subCalls.length > 0) {
    parts.push(`Subcalls: ${subCalls.map(subcallName).join(', ')}`)
  }
  const output = excerpt(proseOfBlocks(content))
  if (output !== '') parts.push(fenced('text', output))
  return parts.join('\n\n')
}

/**
 * Read one call's display name across lifecycle states.
 * @param call - running or settled subcall.
 * @returns the tool name, or the pairing id when the head fell outside the window.
 */
function subcallName(call: ToolCallBlock): string {
  if (!('kind' in call)) return call.name
  return call.call?.name ?? call.callId
}

/**
 * Render one slash-command row with its verbatim input and settlement.
 * @param node - folded command lifecycle.
 * @returns the section.
 */
function commandSection(node: CommandNode): string {
  const parts = [sectionHeading(2, `Command /${node.name ?? 'unknown'}`)]
  if (node.args !== null && node.args.trim() !== '') parts.push(fenced('text', excerpt(node.args)))
  switch (node.outcome?.kind) {
    case 'success':
      parts.push('Outcome: success')
      break
    case 'error':
      parts.push(`Outcome: error — ${inline(node.outcome.text ?? '')}`)
      break
    default:
      parts.push('Outcome: pending')
  }
  return parts.join('\n\n')
}

/**
 * Render one compaction marker with its optional counts and summary excerpt.
 * @param summary - checkpoint summary text, or null outside the window.
 * @param shadowedItemCount - replaced surface-item count, or null when unknown.
 * @returns the note, or null when the checkpoint carries nothing readable.
 */
function compactionNote(summary: string | null, shadowedItemCount: number | null): string | null {
  const count = shadowedItemCount === null ? '' : ` (${shadowedItemCount} items summarized)`
  if (summary === null || summary.trim() === '') {
    return shadowedItemCount === null ? null : quoteNote(`Compaction checkpoint${count}.`)
  }
  return quoteNote(`Compaction checkpoint${count}:`, '', ...excerpt(summary).split('\n'))
}

/**
 * Render one model-retry notice.
 * @param node - durable retry chain node.
 * @returns the note.
 */
function retryNote(node: ModelRetryNode): string {
  const attempt = 'maxRetries' in node ? ` of ${node.maxRetries}` : ''
  return quoteNote(`Model retry scheduled (attempt ${node.retry}${attempt}).`)
}

// ---- Section assembly ----

/**
 * Join one heading with its body under the shared blank-line rule.
 * @param heading - literal heading line.
 * @param body - pre-rendered body.
 * @returns the complete section.
 */
function section(heading: string, body: string): string {
  return `${heading}\n\n${body}`
}

/**
 * Render one ATX heading at a fixed level.
 * @param level - heading depth (2–4).
 * @param text - literal heading text.
 * @returns the heading line.
 */
function sectionHeading(level: number, text: string): string {
  return `${'#'.repeat(level)} ${text}`
}

/**
 * Render one labeled prose section, dropping it when the prose is empty.
 * @param label - speaker label.
 * @param prose - flattened message prose.
 * @returns the section, or null without prose.
 */
function proseSection(label: string, prose: string): string | null {
  if (prose.trim() === '') return null
  return section(`## ${label}`, escapeProse(prose))
}

/**
 * Render one blockquote note; every line survives escaping before the quote prefix.
 * @param lines - note lines.
 * @returns the quoted note.
 */
function quoteNote(...lines: string[]): string {
  return lines.map(line => `> ${line}`.trimEnd()).join('\n')
}

// ---- Escaping and bounds ----

/**
 * Escape transcript prose so it cannot inject document structure: every raw
 * `<` becomes literal text, and leading backtick or tilde runs (fences), ATX
 * headings, blockquotes, and full-line horizontal rules (compact or spaced)
 * lose their structural meaning while rendering literally.
 * @param text - multi-line transcript prose.
 * @returns escaped prose.
 */
function escapeProse(text: string): string {
  return text.split('\n').map(escapeLine).join('\n')
}

/**
 * Escape one prose line against structure injection. Every `<` becomes the
 * `&lt;` entity — including inside closing tags and would-be autolinks — so
 * raw HTML renders as text instead of markup; the entity form cannot create
 * new markup the way inserted backslashes can when they pair into `\\`.
 * @param line - one raw prose line.
 * @returns the escaped line.
 */
function escapeLine(line: string): string {
  const literal = line.replace(/</gu, '&lt;')
  const fence = /^( {0,3})(`{3,}|~{3,})/.exec(literal)
  if (fence !== null) {
    const run = fence[2] ?? ''
    const escapedRun = run.split('').map(character => `\\${character}`).join('')
    return `${fence[1] ?? ''}${escapedRun}${literal.slice(fence[0].length)}`
  }
  if (/^ {0,3}#{1,6}(\s|$)/.test(literal)) return literal.replace('#', '\\#')
  if (/^ {0,3}>/.test(literal)) return literal.replace('>', '\\>')
  if (/^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,}|={3,}\s*)$/.test(literal)) {
    return literal.replace(/^( {0,3})([-=*_])/, '$1\\$2')
  }
  return literal
}

/**
 * Collapse prose to one safe inline line for labels.
 * @param text - arbitrary detail text.
 * @returns one-line escaped text.
 */
function inline(text: string): string {
  return escapeProse(text.replace(/\s+/gu, ' ').trim())
}

/**
 * Bound one verbatim excerpt to the shared character budget.
 * @param text - complete verbatim text.
 * @returns the excerpt, with an explicit truncation marker when cut.
 */
function excerpt(text: string): string {
  if (text.length <= EXCERPT_CHAR_LIMIT) return text
  return `${text.slice(0, EXCERPT_CHAR_LIMIT)}\n… [truncated ${text.length - EXCERPT_CHAR_LIMIT} characters]`
}

/**
 * Wrap verbatim content in a code fence long enough to survive any backtick
 * run inside it; a closing fence reuses the opener's character, so embedded
 * tilde runs stay inert.
 * @param language - fence info string.
 * @param content - verbatim fenced content.
 * @returns the fenced block.
 */
function fenced(language: string, content: string): string {
  const longestRun = Math.max(0, ...content.split('\n').map(backtickRunLength))
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return [fence + language, content.replace(/\n+$/u, ''), fence].join('\n')
}

/**
 * Measure one line's opening backtick run (fences allow up to three leading spaces).
 * @param line - one fenced-content line.
 * @returns the length of the leading backtick run.
 */
function backtickRunLength(line: string): number {
  const match = /^ {0,3}(`+)/.exec(line)
  return match?.[1]?.length ?? 0
}
