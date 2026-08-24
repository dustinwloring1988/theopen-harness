/**
 * Host-side wire helpers shared by the api-proxy domain impl modules: rpc
 * response wrapping, frame queues, pagination, presenter rendering, list
 * metadata folds, native-open plumbing, and the api-remotes ownership fences.
 * Pure or context-pure only — no gateway closure state lives here.
 */

// Value edge: mints fresh rpcIds for pushed mux frames.
import { randomUUID } from 'node:crypto'
import type { Context } from '@buckeyestudio/cordis'
import type { Agent } from '@buckeyestudio/toh-agent'
import { PresetMountError, resolveSessionPreset, UnknownPresetError } from '@buckeyestudio/toh-agent-presets'
import type { PresetBearingSession } from '@buckeyestudio/toh-agent-presets'
import { isAppendSurfaceEvent, isJsonValue } from '@buckeyestudio/toh-session'
import type { JsonValue, Session, SessionEvent, SessionEventMap, SessionHeader, SessionId, UserMessage } from '@buckeyestudio/toh-session'
import type { Workspace, WorkspaceRecord, WorkspaceId } from '@buckeyestudio/toh-workspace'
import { workspaceRecord } from '@buckeyestudio/toh-workspace'
import type { ScopeKey } from '@buckeyestudio/toh-scope'
import {
  apiRemoteSubagentOwnershipError,
  hasApiRemoteSubagentOwner,
  inspectApiRemoteSession,
} from '@buckeyestudio/toh-api-remotes'
import type {
  HistoryEntry, ModelCatalogFailure, ModelProviderGroup, ModelReasoning, MuxFrame, QueuedInboxItem,
  SessionListMetadata, SessionProjectionsBlock, ToolEventView, WorkspaceView,
} from './index.ts'
import type { RpcError, RpcRequest, RpcResponse } from './rpc.ts'
import { RpcId } from './rpc.ts'
import { canOpenNativePath, openNativePath, openNativeTextFile } from '../native-path-opener.ts'
// Type-only: brings the `ctx.llm` Context merge into this program (buildModelCatalog reads providers).
import type {} from '@buckeyestudio/toh-llm'
// Type-only: brings the `ctx.tools` Context merge into this program (viewFor reads presenters).
import type {} from '@buckeyestudio/toh-tools'

/** Page size when history is called without maxMessages. */
const DEFAULT_MAX_MESSAGES = 50

/** Conversation message event types (the pagination counting unit). */
export const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/** Wrap an ok result echoing the request's rpcId. */
export function ok<T>(request: RpcRequest<unknown>, value: T): RpcResponse<T> {
  return { rpcId: request.rpcId, result: { ok: true, value } }
}

/** Wrap an error result echoing the request's rpcId. */
export function err<T>(request: RpcRequest<unknown>, error: RpcError): RpcResponse<T> {
  return { rpcId: request.rpcId, result: { ok: false, error } }
}

/** Simple async queue: core callbacks push, the AsyncIterable pulls; abort/return cleans up. */
export class FrameQueue<F> {
  private buffer: F[] = []
  private waiter: (() => void) | undefined
  private done = false

  push(item: F): void {
    if (this.done) return
    this.buffer.push(item)
    this.waiter?.()
  }

  end(): void {
    this.done = true
    this.waiter?.()
  }

  async *iterate(signal: AbortSignal, cleanup: () => void): AsyncGenerator<F> {
    const onAbort = (): void => { this.end() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (true) {
        while (this.buffer.length > 0) yield this.buffer.shift() as F
        if (this.done || signal.aborted) return
        await new Promise<void>((resolve) => { this.waiter = resolve })
        this.waiter = undefined
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      cleanup()
    }
  }
}

/**
 * Server-side frame mint: pure pushes get a fresh rpcId per frame (answerable
 * frames — approval/question requested — mint their stable id in their
 * pending registries instead).
 */
export function frame<F>(payload: F): RpcRequest<F> {
  return { rpcId: RpcId(randomUUID()), payload }
}

/**
 * Narrow one allowlisted host event's argument list to the JSON values the
 * wrapper frame carries. A rejected argument is an allowlist mistake (the
 * forwarded path applies no projection), not hostile input, so it throws rather
 * than degrading to a lossy frame. The throw surfaces where the forwarding
 * listener runs, so the emitter's own listener containment logs it and drops
 * that frame — loud in the Host log, not at load or at the emit. Exported for
 * the test that owns this decision: every currently allowlisted event has a
 * statically JSON-safe payload, so a type-legal `ctx.emit` cannot reach the
 * rejection branch.
 * @param event - forwarded host event name, named in the failure.
 * @param args - the emitter's argument list.
 * @returns the same arguments typed as JSON values.
 */
export function assertJsonArgs(event: string, args: readonly unknown[]): JsonValue[] {
  for (const [index, arg] of args.entries()) {
    if (!isJsonValue(arg)) {
      throw new Error(`forwarded host event "${event}" argument ${index} is not lossless JSON data`)
    }
  }
  return args as JsonValue[]
}

/** Queue the subscription baseline frame. */
export function subscribeSession(queue: FrameQueue<RpcRequest<MuxFrame>>, session: Session): void {
  queue.push(frame({ type: 'session/subscribed', sessionId: session.id, lastSeq: session.seq - 1 }))
}

/** Project both durable inbox lists, optionally including the splice currently being emitted. */
export function queueItems(
  agent: Agent,
  splice?: SessionEventMap['agent/inbox/spliced'],
): QueuedInboxItem[] {
  const project = (target: 'next-turn' | 'next-step'): readonly UserMessage[] => {
    const messages = target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep
    return splice?.target === target
      ? messages.toSpliced(splice.start, splice.removedCount ?? 0, ...splice.inserted)
      : messages
  }
  return [
    ...project('next-turn').map(message => ({ id: message.id, placement: 'queued' as const, message })),
    ...project('next-step').map(message => ({
      id: message.id,
      // Only user-origin messages are steering; injected context (approval
      // notices, task completion, attached snapshots) is not a user action
      // and must not render as a pending steering bubble.
      placement: message.source.kind === 'user' ? 'steering' as const : 'context' as const,
      message,
    })),
  ]
}

/** Read live abort state across awaits without treating it as synchronously immutable. */
export function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/** Strict browser-zone profile: UTC or an IANA Area/Location-style identifier. */
const IANA_TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/

/** Validate and canonicalize one browser-supplied IANA zone at the wire boundary. */
export function canonicalClientTimeZone(value: string): string | undefined {
  if (value.length === 0 || value.trim() !== value
    || (value !== 'UTC' && !IANA_TIME_ZONE.test(value))) return undefined
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: value })
      .resolvedOptions().timeZone
    /* v8 ignore next -- Intl returns UTC or a canonical IANA Area/Location for accepted input. */
    if (canonical !== 'UTC' && !IANA_TIME_ZONE.test(canonical)) return undefined
    return canonical
  } catch {
    // Intl rejects unsupported zone names; the RPC maps that parser rejection below.
    return undefined
  }
}

/**
 * Message-boundary pagination: count maxMessages append-origin messages
 * backwards from the window tail. Replacement copies never entered the
 * conversation a reader sees — they restate a shadowed range for the model
 * alone — so they consume no quota; the page stays one contiguous raw range,
 * which keeps a compaction's log-only `compaction/summary` record on the same page as its
 * replacement. The cut is the starting seq of the oldest message group (chunks
 * group via sourceEventSeqs — never cut mid-message). The tail page naturally
 * includes the in-progress partial.
 */
function paginate(
  events: readonly SessionEvent[],
  beforeSeq: number | undefined,
  maxMessages: number,
): { events: SessionEvent[]; hasMore: boolean } {
  const window = beforeSeq === undefined ? [...events] : events.filter(event => event.seq < beforeSeq)
  let count = 0
  let cut = 0
  for (let i = window.length - 1; i >= 0; i--) {
    const event = window[i] as SessionEvent
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue
    count++
    const sources = (event as { sourceEventSeqs?: number[] }).sourceEventSeqs
    let groupStart = event.seq
    if (sources !== undefined) {
      for (const source of sources) {
        if (source < groupStart) groupStart = source
      }
    }
    if (count >= maxMessages) {
      cut = groupStart
      break
    }
  }
  const page = window.filter(event => event.seq >= cut)
  return { events: page, hasMore: cut > 0 }
}

/**
 * Build the provider/model catalog over every registered route. Shared by the
 * session-scoped `session.models` and host-scoped `llm.models`. Catalog
 * membership stays advisory: an unlisted session selection remains valid for
 * provider dispatch, but is not injected back into the selector after its
 * owning catalog stops advertising it. Per-provider failures ride `failures`
 * without failing the sound groups; groups that advertise nothing are dropped.
 */
export async function buildModelCatalog(ctx: Context): Promise<{
  groups: ModelProviderGroup[]
  failures: ModelCatalogFailure[]
}> {
  const catalog = await Promise.all(ctx.llm.listProviders().map(async (provider) => {
    try {
      const models = await ctx.llm.listModels(provider.id)
      const entries = await Promise.all(models.map(async (model) => {
        const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id)
        const reasoning: ModelReasoning | undefined = resolved.reasoning === undefined
          ? undefined
          : {
            efforts: resolved.reasoning.efforts.map(effort => ({
              id: effort.id,
              name: effort.name,
              ...effort.description === undefined
                ? {}
                : { description: effort.description },
            })),
            ...resolved.reasoning.defaultEffort === undefined
              ? {}
              : { defaultEffort: resolved.reasoning.defaultEffort },
          }
        return {
          id: model.id,
          name: model.name,
          ...model.description === undefined ? {} : { description: model.description },
          ...reasoning === undefined ? {} : { reasoning },
        }
      }))
      const group: ModelProviderGroup = {
        id: provider.id,
        name: provider.name,
        models: entries,
      }
      return { kind: 'group' as const, group }
    } catch (error: unknown) {
      const failure: ModelCatalogFailure = {
        id: provider.id,
        name: provider.name,
        message: error instanceof Error ? error.message : String(error),
      }
      return { kind: 'failure' as const, failure }
    }
  }))
  return {
    groups: catalog.flatMap(item => item.kind === 'group' ? [item.group] : []).filter(group => group.models.length > 0),
    failures: catalog.flatMap(item => item.kind === 'failure' ? [item.failure] : []),
  }
}

/**
 * The RPC refusal a preset failure becomes, or undefined when the failure is
 * about something else.
 *
 * Both the session-create path and the switch path can be handed the same two
 * failures, and a client that has to branch on the code needs them worded the
 * same from either.
 * @param request - the request being answered.
 * @param error - the thrown value.
 * @returns the refusal, or undefined when the caller should keep handling.
 */
export function presetFailure(request: RpcRequest<unknown>, error: unknown): RpcResponse<never> | undefined {
  if (error instanceof UnknownPresetError) {
    return err(request, {
      code: 'agent-preset-not-found',
      message: error.message,
      details: { agentPreset: error.presetId, available: [...error.available] },
    })
  }
  if (error instanceof PresetMountError) {
    return err(request, {
      code: 'agent-preset-invalid',
      message: error.message,
      details: { agentPreset: error.presetId, reason: error.reason },
    })
  }
  return undefined
}

/** The tool/call payload fields the presenter path reads. */
export interface ToolCallData { callId: string; name: string; arguments: string }

/**
 * Compute the render intent for a tool/call or tool/result event through the
 * presenters registered at this moment; every other event type gets none. A
 * result's presenter needs its call's parsed args — `argsFor` supplies them
 * (live: the per-session call table; history: an in-page backscan), returning
 * undefined when the pairing is unavailable (e.g. the call fell off the page),
 * which soft-falls to no view. Presenter or JSON.parse throws also soft-fall:
 * the client's documented default (generic JSON card) covers every miss.
 */
export function viewFor(
  ctx: Context,
  event: SessionEvent,
  argsFor: (callId: string) => unknown,
  // Presenters live with the definitions, and definitions live in the scope
  // chain: a preset registers its tools into its standing layer. A live agent
  // is a scope whose chain passes through its preset; a cold read passes the
  // preset's standing key directly — no agent, no resume. An undefined scope
  // sees only the global layer, which is the pre-preset deployment shape.
  scope?: ScopeKey,
): ToolEventView | undefined {
  try {
    if (event.type === 'tool/call') {
      const { name, arguments: raw } = event.data as ToolCallData
      const view = ctx.tools.get(name, scope)?.presentCall?.(JSON.parse(raw))
      return view === undefined ? undefined : { for: 'call', view }
    }
    if (event.type === 'tool/result') {
      const { message, meta } = event.data
      const [result] = message.content
      const callId = message.source.callId
      const call = argsFor(callId) as { name: string; args: unknown } | undefined
      if (call === undefined) return undefined
      const view = ctx.tools.get(call.name, scope)?.presentResult?.(call.args, {
        content: result.content,
        isError: result.isError === true,
        ...meta === undefined ? {} : { meta },
      })
      return view === undefined ? undefined : { for: 'result', view }
    }
  } catch (error: unknown) {
    // A throwing presenter (or unparseable arguments) must not break delivery;
    // the event still ships, just without a view.
    console.error(`api-proxy: presenter failed for ${event.type}, falling back to generic: ${String(error)}`)
  }
  return undefined
}

/**
 * Resolve a tool/result's call pairing by scanning a window of events backwards
 * for the matching tool/call. Used by the history path (the page is the
 * window — a cross-page pairing soft-falls to no view) and by live-path table
 * misses after a reconnect-eviction.
 */
export function backscanArgs(events: readonly SessionEvent[], callId: string): { name: string; args: unknown } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as SessionEvent
    if (event.type !== 'tool/call') continue
    const data = event.data as ToolCallData
    if (data.callId !== callId) continue
    try {
      return { name: data.name, args: JSON.parse(data.arguments) }
    } catch {
      // Unparseable stored arguments: same soft-fall as a live parse failure.
      return undefined
    }
  }
  return undefined
}

/** Render one detached history page through the same presenter path as ordinary history. */
export function historyPage(
  ctx: Context,
  events: readonly SessionEvent[],
  beforeSeq: number | undefined,
  maxMessages: number | undefined,
  scope?: ScopeKey,
): { events: HistoryEntry[]; hasMore: boolean } {
  const page = paginate(events, beforeSeq, maxMessages ?? DEFAULT_MAX_MESSAGES)
  return {
    events: page.events.map((event) => {
      const view = viewFor(ctx, event, callId => backscanArgs(page.events, callId), scope)
      return { event, ...view === undefined ? {} : { view } }
    }),
    hasMore: page.hasMore,
  }
}

/**
 * The projection baseline for one history tail page: the registry's
 * watermark-cache snapshot — one fully synchronous read (no await between the
 * page slice and this), so all values and `asOfSeq` form a single consistent
 * cut and `asOfSeq` equals the window tail event seq. The carrier holds zero
 * domain knowledge (each value passed its unit's own schema inside the
 * registry). An absent registry means the deployment has no projection seam:
 * the whole block is absent and clients treat every key as capability-absent.
 */
export function projectionsFor(ctx: Context, session: Session): SessionProjectionsBlock | undefined {
  const registry = ctx.get('sessionProjections')
  if (registry === undefined) return undefined
  return registry.snapshot(session)
}

/** Projection baseline for a detached history tail without Agent activation. */
export function detachedProjectionsFor(
  ctx: Context,
  events: readonly SessionEvent[],
): SessionProjectionsBlock | undefined {
  const registry = ctx.get('sessionProjections')
  if (registry === undefined) return undefined
  return registry.restore({}, events, 0).snapshot
}

/**
 * The registry view scope a transcript's presenters resolve in.
 *
 * A live agent is that scope itself (its chain passes through its preset's
 * standing layer). A cold session resolves its preset from the LOG, and the
 * preset's STANDING key serves without resuming anything — ensuring the
 * mount composes plugins but starts no agent, session, or turn. No roster,
 * no recorded preset, or a preset the roster no longer supplies all fall
 * back to the global layer: the transcript still serves, with the generic
 * cards a viewless entry renders.
 *
 * Reading the header alone would render a session that switched while blank
 * through the composition it was CREATED with. Every tool only the newer
 * preset registers resolves to no presenter there, and the transcript
 * silently degrades to generic cards for exactly the calls its history is
 * made of.
 * @param ctx - Host context carrying the live Agent registry and preset roster.
 * @param sessionId - the transcript being read.
 * @param session - that session's header and log (attached or inspected).
 * @returns the scope to pass to presenter lookups, or undefined for global.
 */
export async function presenterScopeFor(
  ctx: Context,
  sessionId: SessionId,
  session: PresetBearingSession,
): Promise<ScopeKey | undefined> {
  const live = ctx.get('agents')?.get(sessionId)
  if (live !== undefined) return live
  const presets = ctx.get('agentPresets')
  if (presets === undefined) return undefined
  try {
    // An unrecorded preset (a log from before the roster existed) renders
    // through the DEFAULT preset's standing layer: that is the composition
    // an unnamed session composes today, and presenters are pure display,
    // so the worst a mismatch produces is the generic card it had anyway.
    return await presets.standingKeyFor(resolveSessionPreset(session))
  } catch {
    // Swallows only the unknown/unusable-preset rejection from the roster:
    // a deleted or broken preset must degrade this read, never fail it.
    return undefined
  }
}

/**
 * Whether the session's conversation has started: no turn has run yet (a
 * turn is one model-loop execution). Standalone plugin events — command
 * lifecycle records, plan/mode, titles, goals — never open a turn, so
 * running `/plan` or `/goal` on a fresh session keeps it blank
 * (list-hidden, reusable).
 */
export function sessionBlank(session: Session): boolean {
  return !session.events.some(event => event.type === 'turn/start')
}

/** Advance the Session-list hint projection by one committed event. */
export function applySessionListMetadata(state: SessionListMetadata, event: SessionEvent): SessionListMetadata {
  const blank = state.blank && event.type !== 'turn/start'
  const lastPromptAt = event.type === 'user/message' && event.data.source.kind === 'user'
    ? event.time
    : state.lastPromptAt
  return blank === state.blank && lastPromptAt === state.lastPromptAt
    ? state
    : { blank, lastPromptAt }
}

/** Fold exact list metadata for an attached Session. */
export function sessionListMetadata(events: readonly SessionEvent[]): SessionListMetadata {
  let state: SessionListMetadata = { blank: true, lastPromptAt: null }
  for (const event of events) state = applySessionListMetadata(state, event)
  return state
}

/** Sort by creation or latest human prompt, whichever is newer. */
export function sessionListUpdatedAt(header: SessionHeader, metadata: SessionListMetadata | undefined): number {
  return Math.max(header.createdAt, metadata?.lastPromptAt ?? 0)
}

/** Shared Session-header projection for list baselines and creation frames. */
export function sessionListFields(header: SessionHeader, events: readonly SessionEvent[] = []): {
  parentSessionId?: SessionId
  origin?: 'subagent'
  cwd?: string
  agentPreset?: string
} {
  // The preset comes from the log, not the header: a session that switched
  // while blank ran its turns under the newer composition, and a picker
  // showing the creation-time value would contradict what the model saw.
  const agentPreset = resolveSessionPreset({ header, events })
  return {
    ...header.parentSession === undefined ? {} : { parentSessionId: header.parentSession },
    ...header.origin === undefined ? {} : { origin: header.origin },
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    ...agentPreset === undefined ? {} : { agentPreset },
  }
}

/** Wire projection of one workspace entity (the workspace.* value row). */
export function workspaceView(workspace: Workspace): WorkspaceView {
  return {
    workspaceId: workspace.id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...workspace.sessionIds],
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

/** Wire projection of the durable record carried by `domain/changed`. */
export function changedWorkspaceView(workspaceId: string, value: unknown): WorkspaceView {
  const record: WorkspaceRecord = workspaceRecord.parse(value)
  return {
    workspaceId: workspaceId as WorkspaceId,
    path: record.path,
    title: record.title,
    sessionIds: [...record.sessionIds],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/** The native-open injectables {@link ApiProxyDefaults} carries for open paths. */
interface NativeOpenDefaults {
  /** Native open-with-default-application; injectable for carrier tests. */
  openPath?: (path: string, signal: AbortSignal) => Promise<void>
  /** Native text-editor handoff; injectable for settings-document tests. */
  openTextFile?: (path: string, signal: AbortSignal) => Promise<void>
  /**
   * Whether handing a path to the native opener can work at all.
   * Absent, an injected `openPath` counts as openable and everything else
   * falls back to platform detection ({@link canOpenNativePath}).
   */
  canOpenPath?: () => boolean
}

/** Open one Host-resolved target and map native failures onto the wire vocabulary. */
async function openTarget(
  request: RpcRequest<unknown>, path: string, signal: AbortSignal,
  open: (path: string, signal: AbortSignal) => Promise<void>,
): Promise<RpcResponse<{ opened: true }>> {
  try {
    await open(path, signal)
    return ok(request, { opened: true as const })
  } catch (error: unknown) {
    if (signal.aborted) {
      return err(request, {
        code: 'cancelled',
        message: 'path open was aborted',
        details: {},
      })
    }
    return err(request, {
      code: 'internal',
      message: `path open failed: ${error instanceof Error ? error.message : String(error)}`,
      details: {},
    })
  }
}

/** Open one Host-resolved path with its default application. */
export function openPath(
  defaults: NativeOpenDefaults,
  request: RpcRequest<unknown>, path: string, signal: AbortSignal,
): Promise<RpcResponse<{ opened: true }>> {
  const open = defaults.openPath
    ?? ((target: string, openSignal: AbortSignal) => openNativePath(target, openSignal))
  return openTarget(request, path, signal, open)
}

/** Open one Host-resolved text document in a native editor. */
export function openTextFile(
  defaults: NativeOpenDefaults,
  request: RpcRequest<unknown>, path: string, signal: AbortSignal,
): Promise<RpcResponse<{ opened: true }>> {
  const open = defaults.openTextFile
    ?? ((target: string, openSignal: AbortSignal) => openNativeTextFile(target, openSignal))
  return openTarget(request, path, signal, open)
}

/** Whether this deployment can hand a path to a native opener at all. */
export function canOpenPaths(defaults: NativeOpenDefaults): boolean {
  if (defaults.canOpenPath !== undefined) return defaults.canOpenPath()
  // An injected opener is by definition usable; otherwise ask the platform.
  return defaults.openPath !== undefined || canOpenNativePath()
}

/** The ctx-bound api-remotes fences shared by the session and subagent domains. */
export interface ApiRemoteFences {
  /** Test whether generic routing must leave an identity to subagent routing. */
  hasSubagentOwner: (session: Pick<Session, 'header'>, agent: Agent | undefined) => boolean
  /** The stable caller-facing ownership rejection. */
  subagentOwnershipError: (sessionId: SessionId) => ReturnType<typeof apiRemoteSubagentOwnershipError>
  /** Inspect one cold served session without repairing, resuming, or publishing it. */
  inspectServable: (sessionId: SessionId) => Promise<{ meta: SessionHeader; events: SessionEvent[] }>
}

/**
 * Bind the api-remotes ownership fences and cold-inspection read to one Host
 * context — the closures every session-addressed method resolves identities
 * through.
 * @param ctx - Host context carrying the Agent registry and persistence.
 * @returns the fence predicates and the non-resuming inspection read.
 */
export function apiRemoteFences(ctx: Context): ApiRemoteFences {
  const hasSubagentOwner = (
    session: Pick<Session, 'header'>,
    agent: Agent | undefined,
  ): boolean => hasApiRemoteSubagentOwner(ctx, session, agent)
  const subagentOwnershipError = (sessionId: SessionId): ReturnType<typeof apiRemoteSubagentOwnershipError> =>
    apiRemoteSubagentOwnershipError(sessionId)
  const inspectServable = (sessionId: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> =>
    inspectApiRemoteSession(ctx, sessionId)
  return { hasSubagentOwner, subagentOwnershipError, inspectServable }
}
