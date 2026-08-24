/**
 * sessions domain impl: the session lifecycle over the wire — list, search,
 * create, history, model selection, rename, fork, prompt, attachments, queue
 * edits, and cancel — plus the shared Agent resolver (`agentFor`) every
 * session-addressed method (including goals and agent presets) resolves
 * identities through.
 */

// Value edges: mint session ids, prepare project directories, and stat cold artifacts.
import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import type { Context } from '@buckeyestudio/cordis'
import { installModelSelection } from '@buckeyestudio/toh-agent'
import type { Agent, ModelSelection, ModelSelectionRef, AgentOptions } from '@buckeyestudio/toh-agent'
import { AttachmentError, admitEncodedImages } from '@buckeyestudio/toh-attachment'
import type { ImageAttachmentRef } from '@buckeyestudio/toh-attachment'
import { createUserMessage, freezeMessage, ReasoningEffortId } from '@buckeyestudio/toh-llm'
import type { ContentBlock, MessageSource } from '@buckeyestudio/toh-llm'
import type { Session, SessionEvent, SessionHeader, SessionId, UserMessage } from '@buckeyestudio/toh-session'
import type { SessionPersistence } from '@buckeyestudio/toh-session-persistence'
import { SessionQueryError, type SessionSearchCursor } from '@buckeyestudio/toh-session-query'
import type { Workspace } from '@buckeyestudio/toh-workspace'
import { WorkspaceId as brandWorkspaceId } from '@buckeyestudio/toh-workspace'
import {
  ApiRemoteAgentResult,
  ApiRemoteSubagentSessionOwnership as SubagentSessionOwnership,
  ApiRemoteSessionNotFound as SessionNotFound,
  createApiRemoteAgentResolver,
} from '@buckeyestudio/toh-api-remotes'
import { resolveSessionPreset } from '@buckeyestudio/toh-agent-presets'
import type { PresetBearingSession } from '@buckeyestudio/toh-agent-presets'
// Value edge: the rename impl narrows the title service's validation failure; the import also resolves `ctx.get('sessionTitle')`.
import { SessionTitleInvalidError } from '@buckeyestudio/toh-session-title'
import type { ApiProxy, PromptContentPart, SessionListMetadata, SessionProjectionsBlock, SessionSearchItem, SessionSummary } from './index.ts'
import type { RpcRequest, RpcResponse } from './rpc.ts'
import {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
  truncateUnicodeCodePoints,
} from './session-search.ts'
import type { ApiProxyDefaults } from '../api-proxy.ts'
import {
  apiRemoteFences,
  buildModelCatalog,
  canonicalClientTimeZone,
  detachedProjectionsFor,
  err,
  historyPage,
  isAborted,
  MESSAGE_TYPES,
  ok,
  presetFailure,
  presenterScopeFor,
  projectionsFor,
  sessionListFields,
  sessionListMetadata,
  sessionListUpdatedAt,
} from './proxy-shared.ts'

/** Provider work budget: at most 100 calls and 2,000 inspected hits. */
const SESSION_SEARCH_PROVIDER_CALL_LIMIT = 100

/** Bound cold-log stat fan-out and settle each started batch before cancellation returns. */
const COLD_SUMMARY_BATCH_SIZE = 16

/** Validate one prompt as a batch before publishing any durable image object. */
async function durablePromptContent(ctx: Context, content: readonly PromptContentPart[]): Promise<ContentBlock[]> {
  if (content.every(part => part.type === 'text')) {
    return content.map(part => ({ type: 'text', text: part.text }))
  }
  const refs = await admitEncodedImages(ctx.attachments, content.filter(part => part.type === 'image'))
  let next = 0
  return content.map(part => part.type === 'text'
    ? { type: 'text', text: part.text }
    // admitEncodedImages returns one reference per image part in order.
    : { type: 'image', attachment: refs[next++] as ImageAttachmentRef })
}

/** Search durable content for an image reference, including nested tool results. */
function imageBlockIn(content: unknown, match: (ref: ImageAttachmentRef) => boolean): ImageAttachmentRef | undefined {
  if (!Array.isArray(content)) return undefined
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as { type?: unknown; attachment?: unknown; content?: unknown }
    if (block.type === 'image' && typeof block.attachment === 'object' && block.attachment !== null) {
      const ref = block.attachment as ImageAttachmentRef
      if (match(ref)) return ref
    }
    if (block.type === 'tool-result') {
      const nested = imageBlockIn(block.content, match)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** Search every durable event carrier that can own model-visible content. */
function imageInEvent(event: SessionEvent, match: (ref: ImageAttachmentRef) => boolean): ImageAttachmentRef | undefined {
  const data = event.data as {
    content?: unknown
    message?: { content?: unknown }
    inserted?: Array<{ content?: unknown }>
    chunk?: { type?: unknown; block?: unknown }
  }
  const direct = imageBlockIn(data.content, match)
  if (direct !== undefined) return direct
  if (data.message !== undefined) {
    const wrapped = imageBlockIn(data.message.content, match)
    if (wrapped !== undefined) return wrapped
  }
  if (data.inserted !== undefined) {
    for (const message of data.inserted) {
      const inserted = imageBlockIn(message.content, match)
      if (inserted !== undefined) return inserted
    }
  }
  if (event.type === 'assistant/chunk' && data.chunk?.type === 'block-end') {
    return imageBlockIn([data.chunk.block], match)
  }
  return undefined
}

/** Resolve the first reference matching one opaque id. */
function referencedImage(events: readonly SessionEvent[], attachmentId: string): ImageAttachmentRef | undefined {
  for (const event of events) {
    const found = imageInEvent(event, ref => String(ref.attachmentId) === attachmentId)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Requested identity already belongs to a session with another project cwd.
 */
class SessionCwdConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedCwd: string,
    readonly existingCwd: string | undefined,
  ) {
    super(
      `session "${sessionId}" already exists with cwd ${JSON.stringify(existingCwd)}; `
      + `requested ${JSON.stringify(requestedCwd)}`,
    )
  }
}

/**
 * The requested preset differs from the one this session already runs.
 *
 * A session's composition is fixed at creation: its history was produced under
 * that preset's tools, so adopting the identity under a different one would
 * replay tool calls the rebuilt agent cannot make. Naming a different preset
 * is therefore a caller error rather than a switch.
 */
class AgentPresetConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedPreset: string,
    readonly existingPreset: string | undefined,
  ) {
    super(
      (existingPreset === undefined
        ? `session "${sessionId}" records no agent preset, so it cannot be adopted under one; `
          + 'a deployment composing no roster records none on any session — '
        : `session "${sessionId}" already runs agent preset ${JSON.stringify(existingPreset)}; `)
      + `requested ${JSON.stringify(requestedPreset)}. A session's preset is fixed at creation.`,
    )
  }
}

/**
 * Which session a transcript read is served from. An attached session is the
 * live object and keeps appending, so its events and projection baseline are
 * read together in one synchronous step; a detached one is already a frozen
 * inspection.
 */
type HistorySource =
  | { readonly kind: 'attached'; readonly session: Session }
  | { readonly kind: 'detached'; readonly header: SessionHeader; readonly events: SessionEvent[] }

/** Closure values the sessions domain consumes from the gateway assembly. */
export interface SessionsDeps {
  /** Resolved `coldBlankProbeMaxBytes`: maximum artifact size eligible for one cold blankness read. */
  coldBlankProbeMaxBytes: number
}

/** The sessions domain face plus the Agent resolver shared across domains. */
export interface SessionsImpl {
  /** The `session.*` method group. */
  sessions: ApiProxy['sessions']
  /** Resolve one requested identity to a live Agent, creating or resuming it once. */
  agentFor: (sessionId: SessionId) => Promise<ApiRemoteAgentResult>
}

/**
 * Create the sessions domain (and the shared Agent resolver) over a composed
 * host context.
 * @param ctx - a context with the Host spine and Workspace registry mounted.
 * @param defaults - host routing and project-directory defaults.
 * @param deps - resolved gateway configuration consumed by listing.
 * @returns the sessions method group and the shared Agent resolver.
 */
export function createSessionsImpl(ctx: Context, defaults: ApiProxyDefaults, deps: SessionsDeps): SessionsImpl {
  const { coldBlankProbeMaxBytes } = deps
  /** The seed model each create/resume declares; re-read so it never goes stale. */
  const agentOptions = (): AgentOptions => {
    const { provider, model } = defaults.defaultModelSelection()
    return { provider, model }
  }
  type WebModelSelectionRef = ModelSelectionRef & { current: ModelSelection }
  const selections = new WeakMap<Agent, WebModelSelectionRef>()
  /** Client-chosen identity creation/resume, deduplicated across concurrent retries. */
  const sessionCreations = new Map<SessionId, Promise<Agent>>()
  const imageAdmissionChains = new WeakMap<Agent, Promise<void>>()

  /** Serialize image admission with model selection for one agent. */
  function serializeImageAdmission<T>(agent: Agent, operation: () => Promise<T>): Promise<T> {
    const result = (imageAdmissionChains.get(agent) ?? Promise.resolve()).then(operation)
    imageAdmissionChains.set(agent, result.then(() => undefined, () => undefined))
    return result
  }

  /**
   * Install or return the session-local model selection that prompt assembly snapshots.
   *
   * Precedence, resolved on EVERY read rather than seeded once: a selection
   * made in this process, else the session's own latest logged request/header,
   * else the live Agent default. Re-reading keeps the two tiers exact in both
   * directions: a session with a recorded request derives its selection from
   * its log, while a blank session (New Session reuses one rather than minting
   * another) reads any default saved after it was created. There is no create-time
   * per-session override tier on this wire — if one returns (a create-options
   * contribution), it must fold in between the selection and the log.
   */
  function selectionFor(agent: Agent): WebModelSelectionRef {
    const installed = selections.get(agent)
    if (installed !== undefined) return installed
    let picked: ModelSelection | undefined
    const selection: WebModelSelectionRef = {
      get current(): ModelSelection {
        if (picked !== undefined) return picked
        // Incrementally folded by the session, so a per-step read costs
        // O(new events) rather than a rescan.
        const logged = agent.session.requestHeader()?.config
        if (logged === undefined) return defaults.defaultModelSelection()
        return {
          provider: logged.provider,
          model: logged.model,
          ...logged.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: logged.reasoningEffort },
        }
      },
      set current(next: ModelSelection) {
        picked = next
      },
      assembled: undefined,
    }
    installModelSelection(agent.ctx, selection)
    selections.set(agent, selection)
    return selection
  }

  /** Pre-publication setup used by both fresh and resumed Web agents. */
  function installSelection(agentCtx: Context): void {
    const agent = agentCtx.agent
    if (agent === undefined) throw new Error('api-proxy: agent setup has no scoped agent')
    selectionFor(agent)
  }

  /**
   * Reject an attempt to run an existing session under a different preset.
   *
   * A caller that names no preset always adopts the session as it is, so the
   * common paths — reconnecting, resuming, retrying a create — are unaffected.
   * @param sessionId - the identity being adopted.
   * @param requested - the preset the request named, if any.
   * @param existing - the preset the session RUNS, if any; both callers resolve
   * it from the log, which differs from the creation header once a blank
   * session has switched.
   * @throws when both are present and differ.
   */
  function assertPresetUnchanged(
    sessionId: SessionId,
    requested: string | undefined,
    existing: string | undefined,
  ): void {
    if (requested === undefined || requested === existing) return
    throw new AgentPresetConflict(sessionId, requested, existing)
  }

  /**
   * Resolve the preset an agent will be composed from, and the setup that
   * installs it.
   *
   * The id is resolved BEFORE the session exists because the session boundary
   * snapshots `meta` before asynchronous setup begins — a preset discovered
   * during setup could never reach the header. Mounting still happens in
   * setup, where a failure rolls the whole creation back rather than leaving a
   * published session whose capabilities are half-installed.
   *
   * A deployment with no preset roster composes nothing and every session
   * shares the host composition, which is the behavior before presets existed.
   * @param presetId - the requested preset, or `undefined` for the default.
   * @returns the id to record on the header (absent without a roster) and the setup callback.
   * @throws when the roster supplies no such preset.
   */
  async function composeAgent(presetId: string | undefined): Promise<{
    agentPreset?: string
    setup: (agentCtx: Context) => Promise<void>
  }> {
    const presets = ctx.get('agentPresets')
    if (presets === undefined) {
      return {
        setup: (agentCtx: Context) => {
          installSelection(agentCtx)
          return Promise.resolve()
        },
      }
    }
    const resolvedId = (await presets.resolve(presetId)).id
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx: Context) => {
        installSelection(agentCtx)
        await presets.mount(agentCtx, resolvedId)
      },
    }
  }

  const { hasSubagentOwner, subagentOwnershipError, inspectServable } = apiRemoteFences(ctx)
  // Cold resume composes the preset the session recorded, for the same reason
  // `session.create` does: its history was produced under that composition.
  // Every generic entry point — prompt, models, commands — arrives here, so
  // leaving it out meant a session opened after a restart ran on host tools
  // and the deployment persona. Resolved from the LOG, not the header: a
  // session that switched while blank ran its turns under the newer
  // composition, and the header is written once at creation. Reading the
  // header here would silently undo the switch on the next restart and
  // restore that history under the old tool set.
  const agentFor = createApiRemoteAgentResolver(ctx, {
    agentOptions,
    setup: async ({ meta, events }) =>
      (await composeAgent(resolveSessionPreset({ header: meta, events }))).setup,
  })

  type SessionReadState = {
    id: SessionId
    header: SessionHeader
    events: SessionEvent[]
  }

  /** Read one stable session prefix without acquiring an Agent owner. */
  async function readSessionState(sessionId: SessionId): Promise<SessionReadState> {
    const attached = ctx.sessions.get(sessionId)
    if (attached !== undefined) {
      return {
        id: attached.id,
        header: attached.header,
        events: [...attached.events],
      }
    }
    const inspected = await inspectServable(sessionId)
    return { id: inspected.meta.id, header: inspected.meta, events: inspected.events }
  }

  /** Resolve the Workspace inherited by a fork without making ordinary loose lineage grouped. */
  async function forkWorkspace(source: Pick<Session, 'id' | 'header'>): Promise<Workspace | undefined> {
    const workspaces = ctx.workspaceRegistry.list()
    const direct = workspaces.find(workspace => workspace.sessionIds.includes(source.id))
    if (direct !== undefined || source.header.origin !== 'subagent') return direct

    const lineage = await ctx.sessionQuery.traceSession(source.id)
    for (const ancestor of lineage.ancestors) {
      const workspace = workspaces.find(candidate => candidate.sessionIds.includes(ancestor.header.id))
      if (workspace !== undefined) return workspace
    }
    return undefined
  }

  /**
   * Resolve which session one transcript read is served from, without
   * acquiring an Agent owner. This is the read's only asynchronous step
   * besides ensuring the composition; {@link historyCutOf} takes the cut.
   * @param sessionId - the transcript being read.
   * @returns the attached session, or the inspected detached header and events.
   * @throws {@link SessionNotFound} when no project-backed session has that identity.
   */
  async function historySourceFor(sessionId: SessionId): Promise<HistorySource> {
    const attached = ctx.sessions.get(sessionId)
    if (attached !== undefined) return { kind: 'attached', session: attached }
    const inspected = await inspectServable(sessionId)
    return { kind: 'detached', header: inspected.meta, events: inspected.events }
  }

  /**
   * The header and events the presenter scope reads to decide which
   * composition a transcript ran under.
   * @param source - the live or detached session this read is served from.
   * @returns that session's creation header and its events.
   */
  function sourceSession(source: HistorySource): PresetBearingSession {
    if (source.kind === 'detached') return { header: source.header, events: source.events }
    return { header: source.session.header, events: source.session.events }
  }

  /**
   * One transcript cut: the events and the projection baseline that describe
   * the SAME log position.
   *
   * Synchronous, and the two reads sit next to each other, because an attached
   * session keeps appending: an `await` between them would serve events cut at
   * N beside a baseline folded to N+1, which is one response describing two
   * moments. The caller does its awaiting before this call.
   * @param source - the live or detached session this read is served from.
   * @param includeProjections - whether the caller asked for the baseline (a tail page does).
   * @returns the events and, when asked, the baseline for that same position.
   */
  function historyCutOf(
    source: HistorySource,
    includeProjections: boolean,
  ): { events: SessionEvent[]; projections?: SessionProjectionsBlock } {
    if (source.kind === 'detached') {
      const projections = includeProjections ? detachedProjectionsFor(ctx, source.events) : undefined
      return { events: source.events, ...projections === undefined ? {} : { projections } }
    }
    const events = [...source.session.events]
    const projections = includeProjections ? projectionsFor(ctx, source.session) : undefined
    return { events, ...projections === undefined ? {} : { projections } }
  }

  /**
   * Reject an attempt to run an existing session under a different preset, or
   * adopt one whose recorded cwd differs.
   */
  async function ensureSession(
    sessionId: SessionId,
    cwd: string,
    checkPersistedIdentity: boolean,
    presetId?: string,
  ): Promise<Agent> {
    let creation = sessionCreations.get(sessionId)
    if (creation === undefined) {
      creation = (async () => {
        const attached = ctx.sessions.get(sessionId)
        const live = ctx.agents.get(sessionId)
        if (attached !== undefined && hasSubagentOwner(attached, live)) {
          throw new SubagentSessionOwnership(sessionId)
        }
        if (live !== undefined) return live

        const persistence = checkPersistedIdentity ? ctx.get('sessionPersistence') : undefined
        const stored = persistence === undefined
          ? undefined
          : (await persistence.list()).find(header => header.id === sessionId)
        if (persistence !== undefined && stored !== undefined) {
          const inspected = await persistence.inspect(sessionId)
          // Ownership first: explicit-id adoption of a session-backed
          // subagent must answer `agent-busy` regardless of the requested
          // cwd (the api/commands.ts contract), not a cwd conflict.
          if (hasSubagentOwner({ header: inspected.meta }, undefined)) {
            throw new SubagentSessionOwnership(sessionId)
          }
          if (inspected.meta.cwd !== cwd) {
            throw new SessionCwdConflict(sessionId, cwd, inspected.meta.cwd)
          }
          // Resolved from the log, not the header: a session that switched
          // while blank ran every turn under the newer composition.
          const storedPreset = resolveSessionPreset({ header: inspected.meta, events: inspected.events })
          assertPresetUnchanged(sessionId, presetId, storedPreset)
          // The stored preset wins over anything the request names: a resumed
          // session's history was produced under that composition, and
          // rebuilding it differently would replay tool calls the model can no
          // longer make.
          return (await ctx.agents.resume({
            resumeSessionId: sessionId,
            agentOptions: agentOptions(),
            setup: (await composeAgent(storedPreset)).setup,
          })).agent
        }

        try {
          await mkdir(cwd, { recursive: true })
        } catch (error: unknown) {
          throw new Error(`failed to ensure project directory "${cwd}": ${String(error)}`, { cause: error })
        }
        const composition = await composeAgent(presetId)
        return (await ctx.agents.create({
          sessionId,
          agentOptions: agentOptions(),
          meta: {
            cwd,
            ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset },
          },
          setup: composition.setup,
        })).agent
      })().catch((error: unknown) => {
        // Another Host entry path may have published the same identity while
        // this operation crossed an asynchronous persistence/filesystem step.
        const live = ctx.agents.get(sessionId)
        if (live !== undefined) {
          if (hasSubagentOwner(live.session, live)) throw new SubagentSessionOwnership(sessionId)
          return live
        }
        const attached = ctx.sessions.get(sessionId)
        if (attached !== undefined && hasSubagentOwner(attached, undefined)) {
          throw new SubagentSessionOwnership(sessionId)
        }
        throw error
      }).finally(() => {
        sessionCreations.delete(sessionId)
      })
      sessionCreations.set(sessionId, creation)
    }
    const agent = await creation
    if (hasSubagentOwner(agent.session, agent)) throw new SubagentSessionOwnership(sessionId)
    // Beside the cwd check for the same reason, and after the await so it
    // covers every path that yields a live agent — freshly created, adopted
    // live, resumed from disk, or recovered by the concurrent-creation catch.
    assertPresetUnchanged(sessionId, presetId, resolveSessionPreset(agent.session))
    if (agent.session.header.cwd !== cwd) {
      throw new SessionCwdConflict(sessionId, cwd, agent.session.header.cwd)
    }
    return agent
  }

  /** SessionSummary projection for attached (in-memory) sessions. */
  function summarize(session: Session, running: boolean): SessionSummary {
    const metadata = sessionListMetadata(session.events)
    return {
      sessionId: session.id,
      updatedAt: sessionListUpdatedAt(session.header, metadata),
      running,
      blank: metadata.blank,
      ...sessionListFields(session.header, session.events),
    }
  }

  /**
   * Verify a possibly blank cold Session only when its physical artifact passes
   * the configured per-Session size check. A stale `blank: true`, an
   * absent cache row, a large or location-less artifact, and read failures all
   * resolve to visible (`false`); listing must never hide a conversation on a
   * cache hint or an unavailable optimization.
   */
  async function probeColdSessionMetadata(
    persistence: SessionPersistence,
    meta: SessionHeader,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<SessionListMetadata | undefined> {
    if (maxBytes === 0) return undefined
    signal?.throwIfAborted()
    const location = persistence.locate(meta)
    if (location === undefined) return undefined
    signal?.throwIfAborted()
    let size: number
    try {
      size = (await stat(location.path)).size
    } catch {
      signal?.throwIfAborted()
      return undefined
    }
    if (size > maxBytes) return undefined
    try {
      const { events } = await persistence.readFrom(meta.id, 0, signal)
      signal?.throwIfAborted()
      return sessionListMetadata(events)
    } catch (error) {
      signal?.throwIfAborted()
      ctx.logger.warn(`session.list: blank probe for "${meta.id}" failed (serving it as visible): ${String(error)}`)
      return undefined
    }
  }

  /** SessionSummary projection for a cold persisted Session. */
  async function summarizeCold(
    persistence: SessionPersistence,
    meta: SessionHeader,
    metadata: SessionListMetadata | undefined,
    blankProbeMaxBytes: number,
    signal?: AbortSignal,
  ): Promise<SessionSummary> {
    const probed = metadata?.blank === false
      ? undefined
      : await probeColdSessionMetadata(persistence, meta, blankProbeMaxBytes, signal)
    return {
      sessionId: meta.id,
      updatedAt: sessionListUpdatedAt(meta, probed ?? metadata),
      running: false,
      blank: metadata?.blank === false ? false : probed?.blank ?? false,
      // Header-only: reading the log for a blank-window preset switch would
      // defeat the same index read, and attaching the session replaces this row
      // with `summarize()`, which resolves the switch from the events.
      ...sessionListFields(meta),
    }
  }

  /**
   * The projection baseline of one session.list row, fail-soft: attached
   * sessions cut the registry's live watermark cache; cold sessions view the
   * persisted projection cache's identity-checked stored rows (zero log loads
   * either way — the listing use case the cache exists for). The block shape
   * (values + asOfSeq) matches the history tail's, so a client seeds its
   * value store under the same higher-seq-wins rule. Any failure — and an
   * empty value set — yields an absent block: a listing without projections
   * is degraded, never broken.
   */
  function listProjectionsFor(ctx: Context, meta: SessionHeader, session: Session | undefined): SessionProjectionsBlock | undefined {
    try {
      const block = session !== undefined
        ? ctx.get('sessionProjections')?.snapshot(session)
        : ctx.get('sessionProjectionCache')?.cachedSnapshot(meta)
      return block !== undefined && Object.keys(block.values).length > 0 ? block : undefined
    } catch (error) {
      ctx.logger.warn(`session.list: projection column for "${meta.id}" failed (serving the row without it): ${String(error)}`)
      return undefined
    }
  }

  /**
   * Build the session.list baseline shared by listing and search visibility.
   * Attached sessions come from memory; servable cold sessions merge from
   * persistence, and the final order is newest-first.
   */
  async function listVisibleSessionSummaries(signal?: AbortSignal): Promise<SessionSummary[]> {
    signal?.throwIfAborted()
    const summarizeAttached = (session: Session): SessionSummary => {
      const agent = ctx.agents.get(session.id)
      const projections = listProjectionsFor(ctx, session.header, session)
      return {
        ...summarize(session, agent?.status === 'running'),
        ...projections === undefined ? {} : { projections },
      }
    }
    const items = ctx.sessions.list().map(summarizeAttached)
    signal?.throwIfAborted()
    const attached = new Set(items.map(item => item.sessionId))
    const persistence = ctx.get('sessionPersistence')
    if (persistence !== undefined) {
      const cold = (await persistence.list(signal))
        .filter(meta => !attached.has(meta.id) && meta.cwd !== undefined)
      signal?.throwIfAborted()
      for (let offset = 0; offset < cold.length; offset += COLD_SUMMARY_BATCH_SIZE) {
        signal?.throwIfAborted()
        const batch = cold.slice(offset, offset + COLD_SUMMARY_BATCH_SIZE)
        const settled = await Promise.allSettled(
          batch.map(async (meta) => {
            // Projection hints remain optional. Blank verification may read
            // this Session's artifact only when it passes the configured size check.
            const projections = listProjectionsFor(ctx, meta, undefined)
            const summary = await summarizeCold(
              persistence,
              meta,
              projections?.values.sessionListMetadata,
              coldBlankProbeMaxBytes,
              signal,
            )
            const attachedSession = ctx.sessions.get(meta.id)
            if (attachedSession !== undefined) return summarizeAttached(attachedSession)
            return {
              ...summary,
              ...projections === undefined ? {} : { projections },
            }
          }),
        )
        const summaries: SessionSummary[] = []
        let rejected = false
        let failure: unknown
        for (const result of settled) {
          if (result.status === 'fulfilled') {
            summaries.push(result.value)
          } else if (!rejected) {
            rejected = true
            failure = result.reason
          }
        }
        if (rejected) throw failure
        signal?.throwIfAborted()
        items.push(...summaries)
      }
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt)
    return items
  }

  /**
   * Whether an adapter currently serves this provider, and therefore whether
   * a session selecting it can start a turn. Catalog membership cannot answer
   * it: an adapter may serve a model its own catalog stopped advertising, so
   * a provider missing from the groups is not the same as one nothing serves.
   * A composition with no llm registry at all cannot judge and says yes —
   * the dispatch it would have refused fails on its own terms.
   */
  function routeServed(provider: string): boolean {
    const llm = ctx.get('llm')
    return llm === undefined || llm.listProviders().some(entry => entry.id === provider)
  }

  /**
   * Resolve the addressed agent for a turn-starting method and refuse when no
   * adapter serves its current selection: a provider nothing serves cannot start a
   * turn, and letting it try spends the whole pre-step path to fail inside
   * the adapter with a message about registration. Refusing here names the
   * model the session is pointed at while the draft is still in the composer.
   * This is `session.prompt`'s enforcement boundary: a client that disables
   * its input is an affordance, and the method stays callable regardless.
   */
  async function turnAgentFor<T>(
    request: RpcRequest<unknown>, sessionId: SessionId,
  ): Promise<{ agent: Agent } | { refused: RpcResponse<T> }> {
    const found = await agentFor(sessionId)
    if ('error' in found) return { refused: err(request, found.error) }
    const agent = found.agent
    const selection = selectionFor(agent).current
    if (!routeServed(selection.provider)) {
      return {
        refused: err(request, {
          code: 'model-unavailable',
          message: `no adapter serves provider "${selection.provider}"; select a model for this session`,
          details: { provider: selection.provider, model: selection.model },
        }),
      }
    }
    return { agent }
  }

  const sessions: ApiProxy['sessions'] = {
    // Attached sessions summarize from memory; persisted-but-unattached (cold)
    // sessions merge in from the persistence store so history survives restarts.
    // Logs without a cwd are not served; every session records its project
    // at create time.
    async list(request) {
      return ok(request, { items: await listVisibleSessionSummaries() })
    },

    async search(request, signal) {
      const cancelled = () => err<{ items: SessionSearchItem[]; hasMore: boolean }>(request, {
        code: 'cancelled',
        message: 'session search was aborted',
        details: {},
      })
      if (isAborted(signal)) return cancelled()
      const sessionQuery = ctx.get('sessionQuery')
      if (sessionQuery === undefined) {
        return err(request, {
          code: 'internal',
          message: 'session search is unavailable: this deployment does not mount @buckeyestudio/toh-session-query',
          details: {},
        })
      }
      try {
        const visible = await listVisibleSessionSummaries(signal)
        if (isAborted(signal)) return cancelled()
        if (visible.length === 0) return ok(request, { items: [], hasMore: false })
        const visibleIds = new Set(visible.map(item => item.sessionId))
        const authorized: SessionSearchItem[] = []
        const acceptedIds = new Set<SessionId>()
        const seenCursors = new Set<SessionSearchCursor>()
        let cursor: SessionSearchCursor | undefined
        let providerCallCount = 0
        let providerPageLimit = SESSION_SEARCH_RESULT_LIMIT
        while (authorized.length <= SESSION_SEARCH_RESULT_LIMIT) {
          if (isAborted(signal)) return cancelled()
          if (providerCallCount >= SESSION_SEARCH_PROVIDER_CALL_LIMIT) {
            throw new Error(
              `session search provider exceeded the ${SESSION_SEARCH_PROVIDER_CALL_LIMIT}-call work budget`,
            )
          }
          providerCallCount++
          const requestedCursor = cursor
          const requestedPageLimit = providerPageLimit
          let page
          try {
            page = await sessionQuery.searchSessions({
              query: request.payload.query,
              eventFilters: [
                { kind: 'type', values: ['user/message', 'assistant/message'] },
                { kind: 'surface', values: ['current'] },
              ],
              limit: requestedPageLimit,
              ...requestedCursor === undefined ? {} : { cursor: requestedCursor },
            }, { signal })
          } catch (error: unknown) {
            if (isAborted(signal)) return cancelled()
            if (
              requestedCursor === undefined
                && error instanceof SessionQueryError
                && error.code === 'SESSION_QUERY_INVALID_LIMIT'
                && requestedPageLimit > 1
            ) {
              providerPageLimit = Math.max(1, Math.floor(requestedPageLimit / 2))
              continue
            }
            if (
              requestedCursor !== undefined
                && error instanceof SessionQueryError
                && error.code === 'SESSION_QUERY_STALE_CURSOR'
            ) {
              authorized.length = 0
              acceptedIds.clear()
              seenCursors.clear()
              cursor = undefined
              continue
            }
            throw error
          }
          if (isAborted(signal)) return cancelled()
          const providerItemCount = page.items.length
          if (providerItemCount > requestedPageLimit) {
            throw new Error(
              `session search provider returned ${providerItemCount} items; maximum is ${requestedPageLimit}`,
            )
          }
          // Host visibility is the authorization boundary. Consume the
          // provider's globally ranked results rather than binding every
          // visible id into one SQLite statement, then require each hit to
          // name a visible session and a current message from that same
          // session before emitting its snippet.
          for (const hit of page.items) {
            if (authorized.length > SESSION_SEARCH_RESULT_LIMIT) continue
            if (
              !visibleIds.has(hit.header.id)
                || hit.bestMatch.sessionId !== hit.header.id
                || hit.bestMatch.surface !== 'current'
                || !MESSAGE_TYPES.has(hit.bestMatch.type)
                || acceptedIds.has(hit.header.id)
            ) continue
            const snippet = truncateUnicodeCodePoints(
              hit.bestMatch.snippet,
              SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
            )
            acceptedIds.add(hit.header.id)
            authorized.push({
              sessionId: hit.header.id,
              snippet,
            })
          }
          const nextCursor = page.nextCursor
          if (nextCursor !== undefined) {
            if (seenCursors.has(nextCursor)) {
              throw new Error('session search provider repeated a continuation cursor')
            }
            seenCursors.add(nextCursor)
          }
          if (authorized.length > SESSION_SEARCH_RESULT_LIMIT || nextCursor === undefined) break
          cursor = nextCursor
        }
        return ok(request, {
          items: authorized.slice(0, SESSION_SEARCH_RESULT_LIMIT),
          hasMore: authorized.length > SESSION_SEARCH_RESULT_LIMIT,
        })
      } catch (error: unknown) {
        if (
          isAborted(signal)
            || (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED')
        ) return cancelled()
        // XXX: Redact provider details before exposing this gateway beyond
        // its current single-user local deployment.
        return err(request, {
          code: 'internal',
          message: `session search failed: ${String(error)}`,
          details: {},
        })
      }
    },

    async create(request) {
      const sessionId = request.payload.sessionId ?? `session-${randomUUID()}` as SessionId
      let workspace: Workspace | undefined
      if (request.payload.workspaceId !== undefined) {
        workspace = ctx.workspaceRegistry.get(brandWorkspaceId(request.payload.workspaceId))
        if (workspace === undefined) {
          return err(request, {
            code: 'workspace-not-found',
            message: `workspace "${request.payload.workspaceId}" not found`,
            details: { workspaceId: request.payload.workspaceId },
          })
        }
      }
      const cwd = workspace?.path ?? request.payload.cwd ?? defaults.cwd
      const requestedPreset = request.payload.agentPreset
      try {
        await ensureSession(sessionId, cwd, request.payload.sessionId !== undefined, requestedPreset)
      } catch (error: unknown) {
        if (error instanceof AgentPresetConflict) {
          return err(request, {
            code: 'agent-preset-conflict',
            message: error.message,
            details: {
              sessionId: error.sessionId,
              requestedPreset: error.requestedPreset,
              ...error.existingPreset === undefined ? {} : { existingPreset: error.existingPreset },
            },
          })
        }
        const refused = presetFailure(request, error)
        if (refused !== undefined) return refused
        if (error instanceof SessionCwdConflict) {
          return err(request, {
            code: 'session-conflict',
            message: error.message,
            details: {
              sessionId: error.sessionId,
              requestedCwd: error.requestedCwd,
              ...error.existingCwd === undefined ? {} : { existingCwd: error.existingCwd },
            },
          })
        }
        if (error instanceof SubagentSessionOwnership) {
          return err(request, subagentOwnershipError(error.sessionId))
        }
        return err(request, {
          code: 'internal',
          message: `failed to create session "${sessionId}": ${String(error)}`,
          details: {},
        })
      }
      if (workspace !== undefined) {
        try {
          await workspace.attachSession(sessionId)
        } catch (error: unknown) {
          return err(request, {
            code: 'workspace-attach-failed',
            message: `session "${sessionId}" was created but could not attach to workspace "${workspace.id}": ${String(error)}`,
            details: { sessionId, workspaceId: workspace.id },
          })
        }
      }
      // Echo the composition the session RUNS so a client can label it
      // without waiting for the next list refresh — the create is the commit
      // point that knows it (a caller that named none gets the default).
      // Resolved from the log for the same reason `sessionListFields()` is:
      // this handler also adopts an already-live session, and one that
      // switched while blank runs a preset its header no longer names, so
      // echoing the header would contradict both the adoption this call just
      // allowed and the row `session.list` serves for the same session.
      const created = ctx.agents.get(sessionId)
      const createdPreset = created === undefined ? undefined : resolveSessionPreset(created.session)
      return ok(request, { sessionId, ...createdPreset === undefined ? {} : { agentPreset: createdPreset } })
    },

    async history(request) {
      const { sessionId, beforeSeq, maxMessages } = request.payload
      try {
        const source = await historySourceFor(sessionId)
        // Both awaits happen BEFORE the cut. Ensuring the recorded
        // composition's standing mount is what registers its projection
        // units, so a first cold read would otherwise serve a baseline
        // missing every preset-owned key; and an attached session keeps
        // appending, so awaiting between the two reads would pair events cut
        // at N with a baseline folded to N+1.
        const scope = await presenterScopeFor(ctx, sessionId, sourceSession(source))
        const cut = historyCutOf(source, beforeSeq === undefined)
        const page = historyPage(ctx, cut.events, beforeSeq, maxMessages, scope)
        return ok(request, {
          events: page.events,
          hasMore: page.hasMore,
          ...cut.projections === undefined ? {} : { projections: cut.projections },
        })
      } catch (error: unknown) {
        if (error instanceof SessionNotFound) {
          return err(request, { code: 'session-not-found', message: error.message, details: { sessionId } })
        }
        return err(request, {
          code: 'internal',
          message: `history unavailable for session "${sessionId}": ${String(error)}`,
          details: {},
        })
      }
    },

    async models(request) {
      const { sessionId } = request.payload
      const found = await agentFor(sessionId)
      if ('error' in found) return err(request, found.error)
      const current = selectionFor(found.agent).current
      const { groups, failures } = await buildModelCatalog(ctx)
      const routable = routeServed(current.provider)
      return ok(request, { current: { ...current }, routable, groups, failures })
    },

    async selectModel(request) {
      const { sessionId, provider, model, reasoningEffort } = request.payload
      const found = await agentFor(sessionId)
      if ('error' in found) return err(request, found.error)
      return serializeImageAdmission(found.agent, async () => {
        try {
          const resolved = await ctx.llm.resolveCallConfig({
            provider,
            model,
            ...reasoningEffort === undefined
              ? {}
              : { reasoningEffort: ReasoningEffortId(reasoningEffort) },
          })
          const selected: ModelSelection = {
            provider: resolved.provider,
            model: resolved.model,
            ...resolved.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: resolved.reasoningEffort },
          }
          selectionFor(found.agent).current = selected
          try {
            await defaults.saveDefaultModelSelection?.(selected)
          } catch (error: unknown) {
            ctx.logger.warn(
              `api-proxy: the model switch applies to this session but was not saved as the default: ${String(error)}`,
            )
          }
          return ok(request, { selected: { ...selected } })
        } catch (error: unknown) {
          return err(request, {
            code: 'model-unavailable',
            message: error instanceof Error ? error.message : String(error),
            details: { provider, model },
          })
        }
      })
    },

    async rename(request) {
      const { sessionId, title } = request.payload
      const found = await agentFor(sessionId)
      if ('error' in found) return err(request, found.error)
      const titles = ctx.get('sessionTitle')
      if (titles === undefined) {
        return err(request, { code: 'internal', message: 'renaming is unavailable: this deployment mounts no session-title service', details: {} })
      }
      try {
        const accepted = titles.rename(found.agent.session, title)
        return ok(request, { title: accepted.title, seq: accepted.eventSeq })
      } catch (error: unknown) {
        // Only the input's fault maps to title-invalid (the message is
        // product-user-visible in the rename dialog); liveness and disposal
        // races are deployment trouble, not a bad title.
        if (error instanceof SessionTitleInvalidError) {
          return err(request, {
            code: 'title-invalid',
            message: error.message,
            details: { sessionId },
          })
        }
        return err(request, {
          code: 'internal',
          message: `failed to rename session "${sessionId}": ${String(error)}`,
          details: {},
        })
      }
    },

    async fork(request) {
      const { sessionId, atSeq } = request.payload
      let source: SessionReadState
      try {
        source = await readSessionState(sessionId)
      } catch (error: unknown) {
        if (error instanceof SessionNotFound) {
          return err(request, { code: 'session-not-found', message: error.message, details: { sessionId } })
        }
        return err(request, {
          code: 'internal',
          message: `fork source unavailable for session "${sessionId}": ${String(error)}`,
          details: {},
        })
      }
      const events = source.events
      // An in-log anchor belongs to the turn containing it and must never
      // clip backward to an earlier completed turn. Omitted and past-end
      // anchors retain the last-completed-turn shortcut.
      const lastSeq = events.at(-1)?.seq ?? -1
      const anchoredBoundary = atSeq === undefined
        ? undefined
        : events.find(e => e.type === 'turn/end' && e.seq >= atSeq)
      const boundary = anchoredBoundary
          ?? (atSeq === undefined || atSeq > lastSeq
            ? events.findLast(e => e.type === 'turn/end')
            : undefined)
      if (boundary === undefined) {
        return err(request, {
          code: 'fork-unavailable',
          message: atSeq !== undefined && atSeq <= lastSeq
            ? `session "${sessionId}" has not completed the turn containing event ${String(atSeq)}`
            : `session "${sessionId}" has no completed turn to fork from`,
          details: { sessionId },
        })
      }
      // Extend the cut through trailing out-of-band appends (session/title,
      // injections) up to the next turn/start: they are standalone events, so
      // the seed stays balanced, and the child inherits a title generated
      // right after the boundary turn.
      let cut = boundary.seq + 1
      while (cut < events.length && events[cut]?.type !== 'turn/start') cut++
      let workspace: Workspace | undefined
      try {
        workspace = await forkWorkspace(source)
      } catch (error: unknown) {
        return err(request, {
          code: 'internal',
          message: `failed to resolve fork workspace for session "${sessionId}": ${String(error)}`,
          details: {},
        })
      }
      const childId = `session-${randomUUID()}` as SessionId
      // The child inherits the parent's composition for the same reason a
      // resumed session keeps its own: the seeded history was produced under
      // those tools, and composing anything else would strand the tool calls
      // it already carries. Now that no model-facing row sits in the host
      // plane, composing nothing would leave the child with no tools at all.
      const forkComposition = await composeAgent(resolveSessionPreset(source))
      try {
        await ctx.agents.create({
          sessionId: childId,
          seed: events.slice(0, cut),
          meta: {
            ...source.header.cwd === undefined ? {} : { cwd: source.header.cwd },
            parentSession: source.id,
            seedLength: cut,
            ...forkComposition.agentPreset === undefined
              ? {}
              : { agentPreset: forkComposition.agentPreset },
          },
          agentOptions: agentOptions(),
          setup: forkComposition.setup,
        })
      } catch (error: unknown) {
        return err(request, {
          code: 'internal',
          message: `failed to fork session "${sessionId}": ${String(error)}`,
          details: {},
        })
      }
      // An ordinary source keeps its direct Workspace. A subagent source is
      // not listed there, so its ordinary fork joins the nearest owning
      // ancestor instead. The child is already published if attach fails.
      if (workspace !== undefined) {
        try {
          await workspace.attachSession(childId)
        } catch (error: unknown) {
          return err(request, {
            code: 'workspace-attach-failed',
            message: `session "${childId}" was forked but could not attach to workspace "${workspace.id}": ${String(error)}`,
            details: { sessionId: childId, workspaceId: workspace.id },
          })
        }
      }
      return ok(request, { sessionId: childId })
    },

    async prompt(request) {
      const { sessionId, mode, content, clientTimeZone } = request.payload
      const canonicalTimeZone = clientTimeZone === undefined
        ? undefined
        : canonicalClientTimeZone(clientTimeZone)
      if (clientTimeZone !== undefined && canonicalTimeZone === undefined) {
        return err(request, {
          code: 'invalid-time-zone',
          message: 'clientTimeZone must be UTC or a valid IANA Area/Location name',
          details: { value: clientTimeZone },
        })
      }
      const resolved = await turnAgentFor<{ accepted: true }>(request, sessionId)
      if ('refused' in resolved) return resolved.refused
      const agent = resolved.agent
      // Request identity and optional browser zone ride the exact durable user message.
      const source: MessageSource = {
        kind: 'user',
        rpcId: request.rpcId,
        ...(canonicalTimeZone === undefined ? {} : { clientTimeZone: canonicalTimeZone }),
      }
      const hasImage = content.some(part => part.type === 'image')
      const admit = async (): Promise<RpcResponse<{ accepted: true }>> => {
        try {
          if (hasImage) {
            const current = selectionFor(agent).current
            const modelInfo = await ctx.llm.resolveModelInfo(current.provider, current.model)
            if (modelInfo.inputModalities !== undefined && !modelInfo.inputModalities.includes('image')) {
              return err(request, {
                code: 'attachment-error',
                message: `Model "${current.model}" does not support image input.`,
                details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
              })
            }
          }
          const durable = await durablePromptContent(ctx, content)
          const message: UserMessage = createUserMessage({ content: durable, source })
          if (mode === 'steer') agent.steer(message)
          else agent.followup(message)
        } catch (error: unknown) {
          if (error instanceof AttachmentError) {
            return err(request, {
              code: 'attachment-error',
              message: error.message,
              details: { reason: error.code },
            })
          }
          return err(request, {
            code: 'agent-busy',
            message: 'prompt rejected',
            details: { reason: String(error) },
          })
        }
        return ok(request, { accepted: true as const })
      }
      return hasImage ? serializeImageAdmission(agent, admit) : admit()
    },

    async attachment(request) {
      const { sessionId, attachmentId } = request.payload
      let state: SessionReadState
      try {
        state = await readSessionState(sessionId)
      } catch (error: unknown) {
        if (error instanceof SessionNotFound) {
          return err(request, {
            code: 'session-not-found',
            message: error.message,
            details: { sessionId },
          })
        }
        return err(request, {
          code: 'internal',
          message: `attachment authorization unavailable for session "${sessionId}": ${String(error)}`,
          details: {},
        })
      }
      const ref = referencedImage(state.events, String(attachmentId))
      if (ref === undefined) {
        return err(request, {
          code: 'attachment-error',
          message: 'Image is not referenced by this session.',
          details: { reason: 'ATTACHMENT_NOT_REFERENCED' },
        })
      }
      try {
        const stored = await ctx.attachments.readImage(ref)
        return ok(request, {
          attachment: stored.ref,
          data: Buffer.from(stored.data).toString('base64'),
        })
      } catch (error: unknown) {
        if (error instanceof AttachmentError) {
          return err(request, {
            code: 'attachment-error',
            message: error.message,
            details: { reason: error.code },
          })
        }
        return err(request, {
          code: 'internal',
          message: 'Unable to read image attachment.',
          details: {},
        })
      }
    },

    updateQueue(request) {
      const { sessionId, itemId, action } = request.payload
      if (action.kind === 'edit' && action.content.some(block => block.type !== 'text')) {
        return Promise.resolve(err(request, {
          code: 'attachment-error',
          message: 'queue edits accept text content only',
          details: { reason: 'QUEUE_EDIT_NON_TEXT' },
        }))
      }
      const agent = ctx.agents.get(sessionId)
      if (agent !== undefined && hasSubagentOwner(agent.session, agent)) {
        return Promise.resolve(err(request, subagentOwnershipError(sessionId)))
      }
      if (agent === undefined) {
        return Promise.resolve(err(request, {
          code: 'queue-item-not-found',
          message: 'queued item is no longer pending',
          details: { itemId },
        }))
      }
      const target = agent.inbox.nextTurn.some(message => message.id === itemId)
        ? 'next-turn'
        : agent.inbox.nextStep.some(message => message.id === itemId) ? 'next-step' : undefined
      const message = target === undefined
        ? undefined
        : (target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep)
          .find(candidate => candidate.id === itemId)
      if (target === undefined || message === undefined) {
        return Promise.resolve(err(request, {
          code: 'queue-item-not-found',
          message: 'queued item is no longer pending',
          details: { itemId },
        }))
      }
      if (action.kind === 'steer' && (target !== 'next-turn' || agent.status !== 'running')) {
        return Promise.resolve(err(request, {
          code: 'steer-unavailable',
          message: 'current turn no longer accepts steering',
          details: { itemId },
        }))
      }
      if (action.kind === 'edit') {
        agent.inbox.replace(itemId, freezeMessage({ ...message, content: action.content }))
      } else {
        agent.inbox.remove(itemId)
        if (action.kind === 'steer') agent.steer(message)
      }
      return Promise.resolve(ok(request, { accepted: true as const }))
    },

    cancel(request) {
      const { sessionId } = request.payload
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) {
        return Promise.resolve(err(request, {
          code: 'session-not-found',
          message: `session "${sessionId}" not found (not attached)`,
          details: { sessionId },
        }))
      }
      if (hasSubagentOwner(agent.session, agent)) {
        return Promise.resolve(err(request, subagentOwnershipError(sessionId)))
      }
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      return Promise.resolve(ok(request, { accepted: true as const }))
    },
  }

  return { sessions, agentFor }
}
