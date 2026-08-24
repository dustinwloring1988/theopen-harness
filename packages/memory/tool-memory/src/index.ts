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
import type { RecallOptions } from '@buckeyestudio/toh-memory'

export const name = 'tool-memory'
export const inject = ['tools', 'memory', 'systemPrompt']

/** Model-facing memory tool configuration. */
export interface Config {
  /** Maximum facts one `memory_recall` result may list; minimum 1. Default 20. */
  maxRecallResults?: number
}

export const Config: z<Config> = z.object({
  maxRecallResults: z.number().min(1).default(20),
})

/** The effective configuration one registration resolves once and both registration and execution read. */
export interface ResolvedConfig {
  /** Maximum facts one `memory_recall` result may list; minimum 1. */
  readonly maxRecallResults: number
}

/** Default of {@link Config.maxRecallResults}, applied only in {@link resolveConfig}. */
const DEFAULT_MAX_RECALL_RESULTS = 20

/**
 * Resolve validated plugin configuration into the effective values: omitted
 * keys take their documented defaults here, exactly once at the owning
 * boundary, so neither tool registration nor execution re-applies a default.
 * @param config - validated plugin configuration.
 * @returns the frozen effective configuration.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const maxRecallResults = config.maxRecallResults ?? DEFAULT_MAX_RECALL_RESULTS
  if (!Number.isInteger(maxRecallResults) || maxRecallResults < 1) {
    throw new Error(`tool-memory: maxRecallResults (${maxRecallResults}) must be an integer >= 1`)
  }
  return Object.freeze({ maxRecallResults })
}

/** One model-supplied recall call narrowed against the configured ceiling. */
interface RecallRequest {
  /** Query text passed to `ctx.memory.recall`; blank means list newest. */
  readonly query: string
  /** The caller's workspace scope plus any tag conjunction. */
  readonly options: RecallOptions
  /** Effective result ceiling after flooring at 1 and capping at `maxRecallResults`. */
  readonly limit: number
}

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

/**
 * Resolve one model-supplied recall call against the configured ceiling:
 * the query may be blank (list newest), the tag conjunction is normalized,
 * and the requested limit floors at 1 and caps at the configured maximum.
 * @param args - the model's call arguments.
 * @param scope - the caller's workspace scope from {@link requireScope}.
 * @param spec - the resolved configuration owning the result ceiling.
 * @returns the request to dispatch to `ctx.memory.recall`.
 */
function resolveRecallRequest(
  args: { readonly query?: string; readonly tags?: readonly string[]; readonly limit?: number },
  scope: string,
  spec: ResolvedConfig,
): RecallRequest {
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? spec.maxRecallResults)), spec.maxRecallResults)
  const tags = normalizeTags(args.tags)
  return {
    query: args.query ?? '',
    options: {
      scope,
      ...(tags.length > 0 ? { tags } : {}),
    },
    limit,
  }
}

/**
 * Register the three memory tools and their prompt guidance.
 * @param ctx - Cordis context carrying the `tools`, `memory`, and `systemPrompt` services.
 * @param config - validated plugin configuration; omitted keys take the documented defaults through {@link resolveConfig}.
 * @returns void.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const spec = resolveConfig(config)

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
      limit: { type: 'number', description: `Maximum facts to return. The effective result count is capped by the configured maxRecallResults (${spec.maxRecallResults} by default).` },
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
      const request = resolveRecallRequest(args, requireScope(exec), spec)
      const matches = await ctx.memory.recall(request.query, request.options)
      const capped = matches.slice(0, request.limit)
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
    async execute(args, exec) {
      const id = MemoryFactId(validateId(args.id))
      const forgotten = await ctx.memory.forget({ id, scope: requireScope(exec) })
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
