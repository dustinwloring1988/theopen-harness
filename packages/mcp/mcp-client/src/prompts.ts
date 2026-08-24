/**
 * Prompts bridge: discovers a connected MCP server's prompts and publishes
 * them as skill-provider candidates on `ctx.skills`, lazily loading bodies
 * through `prompts/get`.
 *
 * One bridge per plugin instance, registered once for the plugin lifetime.
 * The connection supervisor drives {@link PromptsBridge.sync} on every
 * generation (initial connect, reconnects, `prompts/list_changed`), so the
 * candidate set follows the same reconnect generations as tools. Naming: each
 * prompt's model-facing skill name is the kebab-case slug of its raw name;
 * the raw name is only ever sent on the wire (`prompts/get`).
 *
 * @module
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { GetPromptResultSchema, ListPromptsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Context } from '@buckeyestudio/cordis'
import { isSkillName } from '@buckeyestudio/toh-skill'
import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider, SkillRegistry } from '@buckeyestudio/toh-skill'

/** Automatic prompts-bridging policy for one MCP server connection. */
export interface PromptsConfig {
  /** Bridge this server's MCP Prompts into the skill registry (default false). */
  enabled?: boolean
  /** Advertise bridged prompts to model-facing skill catalogs (default true). */
  modelInvocable?: boolean
}

/** Defaults shared by the Config schema and {@link resolvePromptsPolicy}. */
export const PROMPTS_DEFAULTS: Required<PromptsConfig> = Object.freeze({
  enabled: false,
  modelInvocable: true,
})

/** Fully resolved prompts policy captured at plugin load. */
export type ResolvedPromptsPolicy = Readonly<Required<PromptsConfig>>

/**
 * The explicit resolve step from raw prompts config to the policy the bridge
 * runs. Programmatic construction may bypass Schemastery normalization, so
 * unknown keys are rejected here — misconfiguration fails the plugin instance
 * at load.
 *
 * @param config - Raw `prompts` config; omission disables the bridge.
 * @param path - Diagnostic prefix naming the config location in thrown messages.
 * @returns The frozen resolved policy.
 */
export function resolvePromptsPolicy(config: PromptsConfig | undefined, path: string): ResolvedPromptsPolicy {
  if (config !== undefined) {
    for (const key of Object.keys(config)) {
      if (!Object.hasOwn(PROMPTS_DEFAULTS, key)) throw new Error(`${path}.${key} is not a prompts option`)
    }
  }
  return Object.freeze({
    enabled: config?.enabled ?? PROMPTS_DEFAULTS.enabled,
    modelInvocable: config?.modelInvocable ?? PROMPTS_DEFAULTS.modelInvocable,
  })
}

/**
 * Derive the model-facing skill name for one MCP prompt: lowercase kebab-case
 * of the raw name. An empty result means the raw name carried no
 * alphanumeric characters and cannot address a skill.
 *
 * @param rawName - The MCP server's own prompt name.
 * @returns The kebab-case slug, possibly empty.
 */
export function promptSkillSlug(rawName: string): string {
  return rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * Remote server prompts rank below every local root — project, user, and
 * bundled skills shadow same-named MCP prompt slugs within one layer.
 */
const MCP_PROMPT_SKILL_RANK = 700

/** Origin bucket reported to the skill registry for bridged prompts. */
const MCP_SKILL_SOURCE = 'mcp'

/** Resolved options relevant to prompts bridging. */
export interface PromptsBridgeOptions {
  serverName: string
  /** Whether candidates advertise as model-invocable; users always may invoke. */
  modelInvocable: boolean
  /** Timeout per `prompts/get` load in milliseconds. */
  toolCallTimeoutMs: number
}

/** One declared prompt argument captured at discovery time. */
export interface PromptArgumentRecord {
  name: string
  required: boolean
  description?: string
}

/** Opaque provider-owned handle passed back by the skill registry. */
export interface PromptLocator {
  rawName: string
  args: readonly PromptArgumentRecord[]
}

/** The wire shape the bridge reads from one listed prompt. */
interface ListedPrompt {
  name?: unknown
  description?: unknown
  arguments?: unknown
}

/** The wire shape the bridge reads from one `prompts/get` message. */
interface PromptMessage {
  role?: unknown
  content?: unknown
}

/** Lifecycle handle the connection supervisor owns alongside tool disposal. */
export interface PromptsBridge {
  /**
   * Fetch this generation's `prompts/list` and swap the candidate set inside
   * the serialized supervisor queue. Fetch failures never reject: the previous
   * candidates stay published and the next discovery reports incomplete.
   * @param generation - the live client generation to read from.
   */
  sync(generation: Client): Promise<void>
  /** Publish an empty candidate set after the reconnect budget is exhausted. */
  giveUp(): void
  /** Unregister the provider registration; safe to call more than once. */
  dispose(): void
}

/**
 * Stable provider label shown by skill consumers.
 * @param serverName - Stable local namespace from plugin config.
 * @returns The unique skill-provider label for this server's prompts.
 */
export function promptsProviderName(serverName: string): string {
  return `mcp:${serverName}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Capture the declared arguments of one listed prompt, dropping malformed entries. */
function collectArguments(rawArguments: unknown): PromptArgumentRecord[] {
  if (!Array.isArray(rawArguments)) return []
  const args: PromptArgumentRecord[] = []
  for (const entry of rawArguments) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name.length === 0) continue
    const description = typeof entry.description === 'string' && entry.description.length > 0
      ? entry.description
      : undefined
    args.push({
      name: entry.name,
      required: entry.required === true,
      ...(description !== undefined ? { description } : {}),
    })
  }
  return args
}

/**
 * Register the prompts provider on the skill registry and return its
 * supervision handle. Registration happens synchronously so the provider
 * files into the calling context's layer per the registry contract; the
 * candidate set fills in when the supervisor completes the first sync.
 *
 * @param ctx - Cordis context providing the logger.
 * @param skills - The mounted skill registry service.
 * @param opts - Bridge options: server namespace, invocation policy, timeout.
 * @returns The supervised bridge driven by the connection supervisor.
 */
export function registerPromptsBridge(ctx: Context, skills: SkillRegistry, opts: PromptsBridgeOptions): PromptsBridge {
  const label = `mcp-client(${opts.serverName}): prompts`
  const providerLabel = promptsProviderName(opts.serverName)
  let invalidate: (() => void) | undefined
  let currentGeneration: Client | undefined
  /**
   * The generation whose `prompts/list` produced {@link candidates}; committed
   * together with them. Lookups resolve only while this equals the live
   * {@link currentGeneration}, so a candidate's raw name and argument
   * metadata never reach a generation that did not list them.
   */
  let catalogGeneration: Client | undefined
  let candidates: readonly SkillCandidate[] = []
  /** Discovery has completed at least once without a fetch failure. */
  let complete = false
  /** True between a sync's entry and its commit-or-failure settlement. */
  let syncing = false
  let disposed = false

  const fallbackDescription = `MCP prompt provided by server "${opts.serverName}".`

  function buildCandidate(record: ListedPrompt, seenSlugs: Map<string, string>): SkillCandidate | undefined {
    if (typeof record.name !== 'string' || record.name.length === 0) {
      ctx.logger.warn(`${label}: skipped a listed prompt without a usable name`)
      return undefined
    }
    const slug = promptSkillSlug(record.name)
    if (!isSkillName(slug)) {
      ctx.logger.warn(`${label}: prompt "${record.name}" has no kebab-case slug and is not bridged`)
      return undefined
    }
    const collision = seenSlugs.get(slug)
    if (collision !== undefined) {
      throw new Error(
        `${label}: server listed prompt "${record.name}" whose skill slug "${slug}" collides with "${collision}" — invalid prompt list`,
      )
    }
    seenSlugs.set(slug, record.name)
    const description = typeof record.description === 'string' && record.description.length > 0
      ? record.description
      : fallbackDescription
    return {
      name: slug,
      description,
      invocation: { modelInvocable: opts.modelInvocable, userInvocable: true },
      source: MCP_SKILL_SOURCE,
      provider: providerLabel,
      rank: MCP_PROMPT_SKILL_RANK,
      locator: {
        rawName: record.name,
        args: collectArguments(record.arguments),
      },
    }
  }

  const provider: SkillProvider = {
    name: providerLabel,
    list(): Promise<readonly SkillCandidate[] | { candidates: readonly SkillCandidate[]; complete: boolean }> {
      if (complete) return Promise.resolve(candidates)
      // Until the first successful discovery (or after a failed re-sync) the
      // catalog may be missing usable candidates, so consumers must not cache.
      return Promise.resolve({ candidates, complete: false })
    },
    async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
      options.signal?.throwIfAborted()
      // A candidate's locator and argument metadata describe the listing that
      // produced them. While a newer listing — a reconnect or a same-generation
      // list_changed re-sync — is in flight, or the committed listing's
      // generation is no longer live, report unloadable so consumers retry
      // through invalidation instead of sending stale names and argument
      // metadata to a server state the catalog may no longer describe.
      const generation = catalogGeneration
      if (generation === undefined || disposed || syncing || generation !== currentGeneration) return undefined
      const locator = candidate.locator as PromptLocator
      let result: { messages?: unknown }
      try {
        result = await generation.request(
          { method: 'prompts/get', params: { name: locator.rawName } },
          GetPromptResultSchema,
          {
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
            timeout: opts.toolCallTimeoutMs,
          },
        )
      } catch {
        // Cancellation propagates to its caller; a mid-outage generation close
        // or a server-side rejection reports the body as unloadable.
        options.signal?.throwIfAborted()
        return undefined
      }
      options.signal?.throwIfAborted()
      return {
        name: candidate.name,
        description: candidate.description,
        invocation: candidate.invocation,
        source: candidate.source,
        provider: candidate.provider,
        content: renderPromptBody(locator, result.messages),
      }
    },
  }

  const unregister = skills.registerProvider((control) => {
    invalidate = () => { control.invalidate() }
    return provider
  })

  async function sync(generation: Client): Promise<void> {
    if (disposed) return
    currentGeneration = generation
    syncing = true
    try {
      const records = await listAllPrompts(generation)
      const seenSlugs = new Map<string, string>()
      const next: SkillCandidate[] = []
      for (const record of records) {
        const candidate = buildCandidate(record, seenSlugs)
        if (candidate !== undefined) next.push(candidate)
      }
      candidates = next
      catalogGeneration = generation
      complete = true
    } catch (error) {
      // Fetch-phase failure: keep serving the last good candidate set and let
      // consumers retry through an incomplete observation.
      complete = false
      ctx.logger.warn(`${label}: prompt synchronization failed: ${String(error)}`)
    } finally {
      syncing = false
    }
    invalidate?.()
  }

  /**
   * Drain uncached `prompts/list` pagination into one flat record list. Only
   * an absent `nextCursor` ends the chain; a repeated cursor (including a
   * server that echoes an empty string every page) throws so the containing
   * sync fails instead of requesting pages forever.
   */
  async function listAllPrompts(generation: Client): Promise<ListedPrompt[]> {
    const records: ListedPrompt[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    do {
      const response = await generation.request(
        { method: 'prompts/list', ...cursor === undefined ? {} : { params: { cursor } } },
        ListPromptsResultSchema,
      )
      records.push(...response.prompts)
      if (response.nextCursor !== undefined) {
        if (seenCursors.has(response.nextCursor)) {
          throw new Error(`${label}: server repeated a prompts/list cursor — invalid prompt list`)
        }
        seenCursors.add(response.nextCursor)
      }
      cursor = response.nextCursor
    } while (cursor !== undefined)
    return records
  }

  return {
    sync,
    giveUp(): void {
      candidates = []
      currentGeneration = undefined
      catalogGeneration = undefined
      complete = true
      invalidate?.()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      currentGeneration = undefined
      catalogGeneration = undefined
      unregister()
    },
  }
}

/** Render one prompt message's single content block, diagnosing unsupported blocks. */
function renderMessageContent(block: unknown): string {
  if (!isRecord(block)) return '[unsupported MCP prompt content block: expected an object]'
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  return `[unsupported MCP prompt content block: ${String(block.type)}]`
}

/**
 * Build the loaded skill body: an argument guide derived from the discovery
 * metadata, then the server-rendered prompt messages under role tags. The
 * body is a pure function of the locator plus the `prompts/get` result.
 */
function renderPromptBody(locator: PromptLocator, messages: unknown): string {
  const lines: string[] = []
  if (locator.args.length > 0) {
    lines.push('Supply these arguments when applying this skill:')
    for (const arg of locator.args) {
      lines.push(`- ${arg.name} (${arg.required ? 'required' : 'optional'})${arg.description !== undefined ? `: ${arg.description}` : ''}`)
    }
    lines.push('')
  }
  if (Array.isArray(messages)) {
    for (const entry of messages as PromptMessage[]) {
      lines.push(`[${typeof entry.role === 'string' && entry.role.length > 0 ? entry.role : 'user'}]`)
      lines.push(renderMessageContent(entry.content))
      lines.push('')
    }
  }
  return lines.join('\n').trimEnd()
}
