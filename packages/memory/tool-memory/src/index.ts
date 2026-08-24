/**
 * Model-facing `memory_remember`, `memory_recall`, and `memory_forget` tools
 * over `ctx.memory`, plus the system-prompt guidance that tells the model
 * when cross-session memory applies. Facts are scoped to the calling agent's
 * workspace directory; every call resolves it from the session header and
 * fails loud without one.
 *
 * @module @buckeyestudio/toh-tool-memory
 */

import type { Context } from '@buckeyestudio/cordis'
import z from '@buckeyestudio/schemastery'
import { defineTool } from '@buckeyestudio/toh-tools'
import type { GenericCallView, ToolExecution } from '@buckeyestudio/toh-tools'
import { MemoryFactId } from '@buckeyestudio/toh-memory'

export const name = 'tool-memory'
export const inject = ['tools', 'memory', 'systemPrompt']

/** Model-facing memory tool configuration. */
export interface Config {
  /** Maximum facts one `memory_recall` result may list; minimum 1. */
  maxRecallResults?: number
}

export const Config: z<Config> = z.object({
  maxRecallResults: z.number().min(1).default(20),
})

const MEMORY_PROMPT_TEXT = [
  'You have persistent cross-session memory for this workspace through three tools:',
  'memory_remember stores a fact, memory_recall searches stored facts, and memory_forget deletes one by id.',
  'Record durable, reusable facts — user preferences, project decisions, environment quirks, task outcomes —',
  'as short self-contained statements with a few specific tags. Recall before acting on an assumption a',
  'previous session may have settled: search your stored facts first and prefer them over guesswork.',
  'Stored facts survive this conversation and are shared across sessions in this workspace.',
  'Do not store secrets (keys, tokens, passwords) or ephemeral scratch state; the working tree remains the source of truth for code state.',
].join(' ')

/** Shared fact fields of a recall hit. */
const FACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    text: { type: 'string', required: true },
    tags: { type: 'array', items: { type: 'string' }, required: true },
    scope: { type: 'string', required: true },
    createdAt: { type: 'number', required: true },
  },
} as const

/**
 * Resolve the storage scope for one tool execution: the calling agent's
 * workspace directory. Memory is workspace-scoped by design, so a call
 * without a session cwd cannot pick a silent default.
 * @param exec - the executing tool call.
 * @returns the canonical scope string.
 */
function requireScope(exec: ToolExecution): string {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined || cwd.length === 0) {
    throw new Error('memory tools require a calling agent whose session header carries a workspace cwd')
  }
  return cwd
}

/** Normalize model-supplied tags: trimmed, non-empty, deduplicated in first-seen order. */
function normalizeTags(tags: readonly string[] | undefined): string[] {
  const normalized: string[] = []
  for (const tag of tags ?? []) {
    const trimmed = tag.trim()
    if (trimmed.length === 0) throw new Error('invalid tags: tags must be non-empty strings')
    if (!normalized.includes(trimmed)) normalized.push(trimmed)
  }
  return normalized
}

/** Validate the non-empty constraint the parameter schema cannot express. */
function validateText(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new Error(`invalid fact: expected a non-empty string, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Validate the non-empty constraint the parameter schema cannot express. */
function validateId(value: string): string {
  if (value.length === 0) {
    throw new Error(`invalid id: expected a non-empty string, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Render one recalled fact as a single stable line.
 * @param fact - the fact to render.
 * @returns its model-facing line.
 */
export function renderRecallLine(fact: {
  readonly id: string
  readonly text: string
  readonly tags: readonly string[]
}): string {
  const tags = fact.tags.length > 0 ? ` [${fact.tags.join(', ')}]` : ''
  return `- ${fact.id}: ${fact.text}${tags}`
}

/** Register the three memory tools and their prompt guidance. */
export function apply(ctx: Context, config: Config = {}): void {
  const maxResults = config.maxRecallResults ?? 20

  ctx.systemPrompt.section({ name: 'tool:memory', order: 113, text: MEMORY_PROMPT_TEXT })

  ctx.tools.register(defineTool({
    name: 'memory_remember',
    description: 'Store a durable fact for future sessions in this workspace. Use for user preferences, project decisions, environment quirks, and task outcomes worth recalling later. Keep each fact short and self-contained.',
    parameters: {
      fact: { type: 'string', required: true, description: 'The statement to store, as one short self-contained sentence.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional routing labels, e.g. ["build", "windows"]. Later recall can filter by them.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          tags: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Stored memory ${value.id}.`,
      }],
    },
    async execute(args, exec) {
      const tags = normalizeTags(args.tags)
      const fact = await ctx.memory.remember({
        text: validateText(args.fact),
        ...tags.length > 0 ? { tags } : {},
        scope: requireScope(exec),
      })
      return { id: fact.id, tags: [...fact.tags] }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Remember fact',
      kind: 'execute',
      rawInput: args.fact,
    } satisfies GenericCallView),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: 'Search facts stored by earlier sessions in this workspace. Every keyword must appear in the stored text; use short distinctive keywords rather than full sentences. Omit the query to list the newest stored facts.',
    parameters: {
      query: { type: 'string', description: 'Space-separated keywords; all must match. Omit to list without keyword filtering.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Only return facts carrying every listed tag.' },
      limit: { type: 'number', description: `Maximum facts to return (capped at ${maxResults}).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          returned: { type: 'number', required: true },
          truncated: { type: 'boolean', required: true },
          facts: { type: 'array', items: FACT_SCHEMA, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.facts.length === 0
          ? 'No stored memories matched.'
          : [
            `${value.returned} of ${value.total} matching ${value.truncated ? `(showing first ${value.returned})` : ''}`.trim(),
            ...value.facts.map(renderRecallLine),
          ].join('\n'),
      }],
    },
    async execute(args, exec) {
      const limit = Math.min(Math.max(1, Math.floor(args.limit ?? maxResults)), maxResults)
      const matches = await ctx.memory.recall(args.query ?? '', {
        scope: requireScope(exec),
        ...(normalizeTags(args.tags).length > 0 ? { tags: normalizeTags(args.tags) } : {}),
      })
      const capped = matches.slice(0, limit)
      return {
        total: matches.length,
        returned: capped.length,
        truncated: matches.length > capped.length,
        facts: capped.map(fact => ({ ...fact, tags: [...fact.tags] })),
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Search memories',
      kind: 'search',
      rawInput: args.query,
    } satisfies GenericCallView),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Delete one stored memory by its id, e.g. when a fact is outdated or wrong. Ids come from memory_recall results.',
    parameters: {
      id: { type: 'string', required: true, description: 'The exact fact id from a memory_recall result.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          forgotten: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.forgotten ? `Forgot memory ${value.id}.` : `No stored memory with id ${value.id}.`,
      }],
    },
    async execute(args) {
      const id = MemoryFactId(validateId(args.id))
      const forgotten = await ctx.memory.forget(id)
      return { id: args.id, forgotten }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Forget memory ${validateId(args.id)}`,
      kind: 'delete',
      rawInput: args.id,
    } satisfies GenericCallView),
  }))
}
