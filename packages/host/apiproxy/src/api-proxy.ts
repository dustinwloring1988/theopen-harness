/**
 * Host-side ApiProxy implementation. Signature discipline: unary takes the
 * narrow RpcRequest<P> and echoes request.rpcId on the RpcResponse<T>.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { z as zod } from 'zod'
import type { Context } from '@buckeyestudio/cordis'
import { installModelSelection } from '@buckeyestudio/toh-agent'
import type { Agent, ModelSelection, ModelSelectionRef, AgentOptions, AgentStatus } from '@buckeyestudio/toh-agent'
import type {} from '@buckeyestudio/toh-agent-presets/types'
import { AttachmentError, admitEncodedImages } from '@buckeyestudio/toh-attachment'
import type { ImageAttachmentRef } from '@buckeyestudio/toh-attachment'
import { createUserMessage, freezeMessage, ReasoningEffortId } from '@buckeyestudio/toh-llm'
import { errorChain } from '@buckeyestudio/toh-llm'
import type { ContentBlock, MessageSource } from '@buckeyestudio/toh-llm'
import type { Session, SessionEvent, SessionHeader, SessionId, UserMessage } from '@buckeyestudio/toh-session'
import type { SessionPersistence } from '@buckeyestudio/toh-session-persistence'
import { SessionQueryError, type SessionSearchCursor } from '@buckeyestudio/toh-session-query'
import { SubagentError } from '@buckeyestudio/toh-subagent'
import type { SubagentListEntry as CatalogSubagentListEntry } from '@buckeyestudio/toh-subagent'
import { isUserInvocable } from '@buckeyestudio/toh-skill'
import type { Workspace } from '@buckeyestudio/toh-workspace'
import {
  workspaceDomainState, WorkspaceId as brandWorkspaceId,
  WorkspaceMoveInvalidError, WorkspaceOrderInvalidError, WorkspaceUnknownSessionError,
} from '@buckeyestudio/toh-workspace'
import {
  InvalidPresetIdError, PresetExistsError, PresetNotWritableError, resolveSessionPreset,
  UnknownPresetError,
} from '@buckeyestudio/toh-agent-presets'
import type { PresetBearingSession } from '@buckeyestudio/toh-agent-presets'
import {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  sessionLogExportDeps,
  sessionLogZipFilename,
  streamSessionLogZip,
  type SessionLogExportReady,
  type SessionLogCompressionLevel,
} from './session-export.ts'
import type { SessionRawArtifact } from '@buckeyestudio/toh-session-persistence'
import {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
  truncateUnicodeCodePoints,
} from './api/session-search.ts'
// Type-only: resolves `ctx.get('sessionProjections')` to the projection registry.
import type {} from '@buckeyestudio/toh-session-projection'
// Type-only: resolves `ctx.get('tasks')` to the background job registry.
import type {} from '@buckeyestudio/toh-jobs'
import type { JobSnapshot } from '@buckeyestudio/toh-jobs'
// Type-only: resolves `ctx.get('sessionProjectionCache')` (the cold listing column).
import type {} from '@buckeyestudio/toh-session-projection-cache'
// GoalError narrows domain rejections to their stable codes at the wire boundary.
import { GoalError } from '@buckeyestudio/toh-goal'
import type { GoalRef as CoreGoalRef } from '@buckeyestudio/toh-goal'
// Type-only edges: resolve the command-change stream and `ctx.get('skills')`.
import type {} from '@buckeyestudio/toh-commands'
// Type-only: the dynamic-package runner's forwarded-event declarations. Its
// client-safe `./types` subpath deliberately, not the package root — the root
// merges `ctx.dynamicCordisRunner`, and a dependency on that package would
// rebuild the api-remotes cycle this direction exists to avoid.
import type {} from '@buckeyestudio/toh-cordis-host-runner/types'
import type {} from '@buckeyestudio/toh-skill'
// The settings/credentials seams: brand guards run at this wire boundary; the
// service reads stay optional (`ctx.get`) so a composition without either
// provider still serves every other domain.
import { SettingsConflictError, settingsNamespace } from '@buckeyestudio/toh-settings'
import type { SettingsDescriptor, SettingsNamespace, SettingsPathOp } from '@buckeyestudio/toh-settings'
import { credentialRef } from '@buckeyestudio/toh-credentials'
// Value edge: the rename impl narrows the title service's validation failure; the import also resolves `ctx.get('sessionTitle')`.
import { SessionTitleInvalidError } from '@buckeyestudio/toh-session-title'
import type {
  ApiProxy, ConfigurableProviderView, CredentialView, GoalRef, HostFrame,
  MuxFrame, PromptContentPart, SessionListMetadata, SessionProjectionsBlock, SessionSearchItem,
  SessionSummary, SettingsNamespaceView, SubagentAddress, JobView,
  WorkspaceId,
} from './api/index.ts'
import type { RpcError, RpcRequest, RpcResponse } from './api/rpc.ts'
import { DirectoryPickerError } from '@buckeyestudio/toh-host-directory-picker'
import {
  ApiRemoteSessionNotFound as SessionNotFound,
  ApiRemoteSubagentSessionOwnership as SubagentSessionOwnership,
  API_REMOTE_FORWARDED_EVENTS,
  apiRemoteSubagentOwnershipError,
  createApiRemoteAgentResolver,
  hasApiRemoteSubagentOwner,
  inspectApiRemoteSession,
} from '@buckeyestudio/toh-api-remotes'
import {
  applySessionListMetadata,
  assertJsonArgs,
  backscanArgs,
  buildModelCatalog,
  canOpenPaths,
  canonicalClientTimeZone,
  changedWorkspaceView,
  detachedProjectionsFor,
  err,
  frame,
  FrameQueue,
  historyPage,
  isAborted,
  MESSAGE_TYPES,
  ok,
  openPath,
  openTextFile,
  presetFailure,
  presenterScopeFor,
  projectionsFor,
  queueItems,
  sessionBlank,
  sessionListFields,
  sessionListMetadata,
  sessionListUpdatedAt,
  subscribeSession,
  viewFor,
  workspaceView,
} from './api/proxy-shared.ts'
import type { ToolCallData } from './api/proxy-shared.ts'
import { createInteractionsImpl, requestedFrame } from './api/interactions-impl.ts'
import { imageLimitsProjectionSchema, sessionListMetadataProjectionSchema } from './api/sessions.schema.ts'

export { assertJsonArgs } from './api/proxy-shared.ts'

/** Provider work budget: at most 100 calls and 2,000 inspected hits. */
const SESSION_SEARCH_PROVIDER_CALL_LIMIT = 100

/** Bound cold-log stat fan-out and settle each started batch before cancellation returns. */
const COLD_SUMMARY_BATCH_SIZE = 16
/** Default maximum artifact size eligible for one cold blankness read. */
export const DEFAULT_COLD_BLANK_PROBE_MAX_BYTES = 1024

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
 * Project registry snapshots onto the wire view, dropping the three internal
 * fields {@link JobView} documents as absent.
 */
function jobViews(snapshots: readonly JobSnapshot[]): JobView[] {
  return snapshots.map(job => ({
    id: job.id,
    kind: job.kind,
    label: job.label,
    status: job.status,
    ...job.detail === undefined ? {} : { detail: job.detail },
    startedAt: job.startedAt,
    ...job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt },
  }))
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
  ctx: Context,
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
  ctx: Context,
  persistence: SessionPersistence,
  meta: SessionHeader,
  metadata: SessionListMetadata | undefined,
  blankProbeMaxBytes: number,
  signal?: AbortSignal,
): Promise<SessionSummary> {
  const probed = metadata?.blank === false
    ? undefined
    : await probeColdSessionMetadata(ctx, persistence, meta, blankProbeMaxBytes, signal)
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

/** Map a browse-primitive failure onto the wire error vocabulary (unknown throws stay internal). */
function directoryError(error: unknown): RpcError {
  if (error instanceof DirectoryPickerError) {
    return { code: error.code, message: error.message, details: { path: error.path } }
  }
  return { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} }
}

/** Resolved Agent model and project-directory defaults consumed by the API implementation. */
export interface ApiProxyDefaults {
  /**
   * The model selection a session starts from when its own log names none. Read on
   * every access rather than captured, so a default saved during this process
   * reaches the sessions that have not run a turn yet.
   */
  defaultModelSelection: () => ModelSelection
  /**
   * Record a selection as the new default. Either absent, or a closure that
   * may itself decline — the gateway plugin always passes one, and it no-ops
   * when the deployment mounts no settings provider or when the write races
   * service teardown. A switch then stays process-local. A rejection is
   * reported and swallowed: the switch already applies to its own session,
   * and undoing it because storage failed would be the worse outcome.
   */
  saveDefaultModelSelection?: (selection: ModelSelection) => Promise<void>
  /** Default project directory for new sessions whose create request carries no cwd. */
  cwd: string
  /** Native open-with-default-application; injectable for carrier tests. */
  openPath?: (path: string, signal: AbortSignal) => Promise<void>
  /** Native text-editor handoff; injectable for settings-document tests. */
  openTextFile?: (path: string, signal: AbortSignal) => Promise<void>
  /** Validated DEFLATE level for session-log ZIP entries; defaults to 6. */
  sessionExportCompressionLevel?: SessionLogCompressionLevel
  /** Maximum artifact size eligible for one cold blankness read. */
  coldBlankProbeMaxBytes?: number
  /**
   * Whether handing a path to the native opener can work at all — the
   * `hasDocument` capability the preset roster reports, and the switch
   * between opening a preset directory and answering its path as text.
   * Absent, an injected `openPath` counts as openable and everything else
   * falls back to platform detection ({@link canOpenNativePath}).
   */
  canOpenPath?: () => boolean
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
 * Best-effort projections for one subagent history page, fail-soft like
 * {@link listProjectionsFor}: a registered unit throwing on a corrupt payload
 * never blocks transcript reading — the page is served without the block.
 * @param ctx - context carrying the logger for the degradation warning.
 * @param childSessionId - the child whose page is being decorated.
 * @param compute - the arm-specific fold (live watermark or detached restore).
 * @returns the projections block, or undefined when the fold failed.
 */
function subagentHistoryProjections(
  ctx: Context,
  childSessionId: SessionId,
  compute: () => SessionProjectionsBlock | undefined,
): SessionProjectionsBlock | undefined {
  try {
    return compute()
  } catch (error) {
    ctx.logger.warn(`subagent.history: projections for "${childSessionId}" failed (serving the page without them): ${String(error)}`)
    return undefined
  }
}

/** Map continuation admission failures without exposing provider details. */
function subagentPromptError(
  request: RpcRequest<{ childSessionId: SessionId }>,
  error: unknown,
  signal: AbortSignal,
): RpcResponse<never> {
  const childSessionId = request.payload.childSessionId
  if (signal.aborted) {
    return err(request, { code: 'cancelled', message: 'subagent prompt was cancelled', details: {} })
  }
  if (error instanceof SubagentError) {
    switch (error.code) {
      case 'NOT_RESUMABLE':
        return err(request, {
          code: 'subagent-not-resumable',
          message: 'subagent cannot be resumed',
          details: { childSessionId },
        })
      case 'UNAUTHORIZED':
        return err(request, {
          code: 'subagent-unauthorized',
          message: 'subagent does not belong to this parent',
          details: { childSessionId },
        })
      case 'DRAINING':
      case 'ACTIVATION_CLOSING':
      case 'CONTINUATION_UNAVAILABLE':
      case 'PERSISTENCE_UNAVAILABLE':
        return err(request, {
          code: 'subagent-delivery-unavailable',
          message: 'subagent follow-up is temporarily unavailable',
          details: { childSessionId },
        })
      default:
        break
    }
  }
  return err(request, { code: 'internal', message: 'subagent prompt failed', details: {} })
}

/** Stable RPC face of the missing projections capability, shared by every catalog read path. */
function projectionsUnavailableError(): RpcError {
  return {
    code: 'internal',
    message: 'subagent catalog is unavailable: this deployment does not mount the sessionProjections registry (load @buckeyestudio/toh-session-projection)',
    details: {},
  }
}

/** Verify one address and mode against the complete direct-child catalog. */
async function catalogChild(
  ctx: Context,
  address: SubagentAddress,
  signal?: AbortSignal,
): Promise<{
  entry?: Extract<CatalogSubagentListEntry, { kind: 'child' }>
  error?: RpcError
}> {
  const { parentSessionId, childSessionId, mode } = address
  try {
    const entries = await ctx.subagents.listChildren(parentSessionId, signal)
    const entry = entries.find(candidate => candidate.id === childSessionId)
    if (entry === undefined || (entry.kind === 'child' && entry.mode !== mode)) {
      return {
        error: {
          code: 'subagent-not-found',
          message: `session "${childSessionId}" is not a ${mode} direct child of "${parentSessionId}"`,
          details: { parentSessionId, childSessionId },
        },
      }
    }
    if (entry.kind === 'diagnostic') {
      return {
        error: {
          code: 'subagent-catalog-diagnostic',
          message: `subagent "${childSessionId}" is ${entry.reason}`,
          details: { parentSessionId, childSessionId, reason: entry.reason },
        },
      }
    }
    return { entry }
  } catch (error: unknown) {
    if (signal?.aborted || (error instanceof SubagentError && error.code === 'CANCELLED')) {
      return { error: { code: 'cancelled', message: 'subagent catalog read was cancelled', details: {} } }
    }
    if (error instanceof SubagentError && error.code === 'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE') {
      return { error: projectionsUnavailableError() }
    }
    return { error: { code: 'internal', message: 'subagent catalog read failed', details: {} } }
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
/** The roster is absent: this deployment composes no agent presets at all. */
function noRoster(agentPreset: string): RpcError {
  return {
    code: 'agent-preset-not-found',
    message: 'this deployment composes no agent presets',
    details: { agentPreset, available: [] },
  }
}

/** Map one authoring/roster failure onto its wire code. */
function presetError(agentPreset: string, error: unknown): RpcError {
  if (error instanceof UnknownPresetError) {
    return {
      code: 'agent-preset-not-found',
      message: error.message,
      details: { agentPreset: error.presetId, available: [...error.available] },
    }
  }
  if (error instanceof PresetNotWritableError) {
    return { code: 'agent-preset-read-only', message: error.message, details: { agentPreset, reason: error.message } }
  }
  if (error instanceof InvalidPresetIdError || error instanceof PresetExistsError) {
    return { code: 'agent-preset-invalid', message: error.message, details: { agentPreset, reason: error.message } }
  }
  return { code: 'internal', message: `agent preset "${agentPreset}": ${String(error)}`, details: {} }
}

class AgentPresetConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedPreset: string,
    readonly existingPreset: string | undefined,
  ) {
    super(
      existingPreset === undefined
        ? `session "${sessionId}" records no agent preset, so it cannot be adopted under one; `
        + 'a deployment composing no roster records none on any session — '
        : `session "${sessionId}" already runs agent preset ${JSON.stringify(existingPreset)}; `
      + `requested ${JSON.stringify(requestedPreset)}. A session's preset is fixed at creation.`,
    )
  }
}

/** Requested identity already belongs to a session with another project cwd. */
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

/** An explicit Host naming operation would duplicate another Workspace title. */
class WorkspaceNameConflictError extends Error {
  constructor(readonly workspaceName: string) {
    super(`workspace name '${workspaceName}' is already in use`)
    this.name = 'WorkspaceNameConflictError'
  }
}

/** Shared workspace-not-found error response of the workspace.* mutation rows. */
function workspaceNotFound<T>(request: RpcRequest<unknown>, workspaceId: string): RpcResponse<T> {
  return err(request, {
    code: 'workspace-not-found',
    message: `workspace "${workspaceId}" not found`,
    details: { workspaceId },
  })
}

/**
 * Implement ApiProxy over a composed host context.
 * @param ctx - a context with the Host spine and Workspace registry mounted.
 * @param defaults - host routing and project-directory defaults.
 * @returns the ApiProxy implementation.
 */
export function createApiProxy(ctx: Context, defaults: ApiProxyDefaults): ApiProxy {
  const sessionExportCompressionLevel = defaults.sessionExportCompressionLevel
    ?? DEFAULT_SESSION_LOG_COMPRESSION_LEVEL
  const coldBlankProbeMaxBytes = defaults.coldBlankProbeMaxBytes
    ?? DEFAULT_COLD_BLANK_PROBE_MAX_BYTES
  /** The seed model each create/resume declares; re-read so it never goes stale. */
  const agentOptions = (): AgentOptions => {
    const { provider, model } = defaults.defaultModelSelection()
    return { provider, model }
  }
  type WebModelSelectionRef = ModelSelectionRef & { current: ModelSelection }
  const selections = new WeakMap<Agent, WebModelSelectionRef>()
  /**
   * Serializes `agentPreset.select` per session. Two concurrent selects both
   * pass the blank check, and the second `unmountPresetFor` then finds nothing
   * to unmount because the first already removed the record — leaving two
   * compositions registered into one agent layer. The client's `busy` flag is
   * not enforcement: the wire is reachable directly.
   */
  const presetSwitches = new Map<SessionId, Promise<unknown>>()
  /** Client-chosen identity creation/resume, deduplicated across concurrent retries. */
  const sessionCreations = new Map<SessionId, Promise<Agent>>()
  /** Serializes path ownership and explicit title checks with Workspace mutations. */
  let workspaceCreationChain = Promise.resolve()
  const muxQueues = new Set<FrameQueue<RpcRequest<MuxFrame>>>()
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

  const hasSubagentOwner = (
    session: Pick<Session, 'header'>,
    agent: Agent | undefined,
  ): boolean => hasApiRemoteSubagentOwner(ctx, session, agent)
  const subagentOwnershipError = (sessionId: SessionId): RpcError =>
    apiRemoteSubagentOwnershipError(sessionId)
  const inspectServable = (sessionId: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> =>
    inspectApiRemoteSession(ctx, sessionId)
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

  /** Send one transient frame to every connected mux consumer. */
  function broadcast(payload: MuxFrame): void {
    const envelope = frame(payload)
    for (const queue of muxQueues) queue.push(envelope)
  }

  // Projection change feed → session/projection push frames. The carrier
  // mints the wire frame (the Service Definition package holds no wire vocabulary); the
  // child activates only when a projection registry is composed, and the
  // subscription unwinds with this gateway's fiber.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.onChanged((session, key, value, seq) => {
      broadcast({ type: 'session/projection', sessionId: session.id, key, value, seq })
    })
  })

  // The cache supplies recency and a monotonic non-blank hint. A cached
  // `blank: true` remains only a prefix fact and is verified on the cold path.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register<'sessionListMetadata', SessionListMetadata>({
      key: 'sessionListMetadata',
      stateSchema: sessionListMetadataProjectionSchema,
      init: () => ({ blank: true, lastPromptAt: null }),
      apply: applySessionListMetadata,
      wire: { viewSchema: sessionListMetadataProjectionSchema, view: state => state },
      stateVersion: 1,
    })
  })

  // The imageLimits projection unit: the attachments config this proxy
  // enforces at prompt admission, constant per host boot. `apply` keeps the
  // same state reference for every event, so no change frames are ever
  // pushed — baselines alone carry the value — and clients pre-check intake
  // and label upload affordances from it. Registered here, not in the
  // attachment Service Definition: toh-llm depends on toh-attachment, so the
  // seam package cannot reference the projection registry without a cycle,
  // and the per-message rules the value describes are this proxy's own
  // admission checks. The child activates only while both seams are composed.
  // `view` reading the live service instead of the (null) state is sanctioned
  // exactly for boot-constant units: the value cannot change within a process
  // lifetime, so the fold stays observationally pure, and a stale persisted
  // cache row re-viewing to the current config is the correct outcome.
  ctx.inject(['sessionProjections', 'attachments'], (projectionCtx) => {
    projectionCtx.sessionProjections.register<'imageLimits', null>({
      key: 'imageLimits',
      stateSchema: zod.null(),
      init: () => null,
      apply: state => state,
      wire: { viewSchema: imageLimitsProjectionSchema, view: () => projectionCtx.attachments.imageLimits },
      stateVersion: 1,
    })
  })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'agent/inbox/spliced') return
    const agent = ctx.agents.get(session.id)
    if (agent?.session !== session) return
    broadcast({ type: 'session/queue', sessionId: session.id, items: queueItems(agent, event.data) })
  })

  // The interaction channel: the question provider, the approval waterfall,
  // and POST /api/respond route over their shared pending registries.
  const { respond, pendingQuestions, pendingApprovals } = createInteractionsImpl(ctx, { broadcast, muxQueues })

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
   * @throws {@link ApiRemoteSessionNotFound} when no project-backed session has that identity.
   */
  async function historySourceFor(sessionId: SessionId): Promise<HistorySource> {
    const attached = ctx.sessions.get(sessionId)
    if (attached !== undefined) return { kind: 'attached', session: attached }
    const inspected = await inspectServable(sessionId)
    return { kind: 'detached', header: inspected.meta, events: inspected.events }
  }

  /**
   * The header and events {@link presenterScopeFor} reads to decide which
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

  /** Resolve one requested identity to a live agent, creating or resuming it once. */
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

  /** Resolve or create one path while holding the Host's workspace-create chain. */
  function ensureWorkspace(path: string): Promise<{ workspace: Workspace; created: boolean }> {
    const operation = workspaceCreationChain.then(async () => {
      const existing = await ctx.workspaceRegistry.resolveByPath(path)
      if (existing !== undefined) return { workspace: existing, created: false }
      return { workspace: await ctx.workspaceRegistry.create(path), created: true }
    })
    workspaceCreationChain = operation.then(() => undefined, () => undefined)
    return operation
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
              ctx,
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
   * Resolve the goal service THIS agent runs.
   *
   * The service is per session: an agent preset mounts it behind an `isolate`
   * realm, which no host context resolves. Reading it from the root would
   * answer "absent" for a session whose composition mounts it — so the lookup
   * is keyed by the agent, and only a deployment composing it nowhere is
   * genuinely absent.
   */
  function goalServiceFor(agent: Agent): NonNullable<ReturnType<typeof ctx.get<'goals'>>> | { error: RpcError } {
    const presets = ctx.get('agentPresets')
    const goals = presets?.serviceFor(agent, 'goals') ?? ctx.get('goals')
    if (goals === undefined) {
      return { error: { code: 'internal', message: 'goal service is absent: neither this session\'s agent preset nor the host composition mounts @buckeyestudio/toh-goal', details: {} } }
    }
    return goals
  }

  /** Map one goal-domain rejection to the wire error (stable GoalError codes ride in details). */
  function goalError(request: RpcRequest<unknown>, error: unknown): RpcResponse<never> {
    const details = error instanceof GoalError ? { goalCode: error.code } : {}
    return err(request, { code: 'internal', message: String(error), details })
  }

  /** Resolve a session's agent, apply one goal mutation, and acknowledge with the new CAS ref. */
  async function mutateGoal(
    request: RpcRequest<{ sessionId: SessionId }>,
    mutation: (goals: NonNullable<ReturnType<typeof ctx.get<'goals'>>>, agent: Agent) => CoreGoalRef,
  ): Promise<RpcResponse<{ ref: GoalRef }>> {
    const found = await agentFor(request.payload.sessionId)
    if ('error' in found) return err(request, found.error)
    const goals = goalServiceFor(found.agent)
    if ('error' in goals) return err(request, goals.error)
    try {
      const ref = mutation(goals, found.agent)
      return ok(request, { ref: { id: ref.id, revision: ref.revision } })
    } catch (error: unknown) {
      return goalError(request, error)
    }
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

  /** Missing-service report shared by the settings domain (skills-domain stance). */
  function settingsAbsent(): RpcError {
    return { code: 'internal', message: 'settings service is absent: this deployment does not mount a settings provider (e.g. @buckeyestudio/toh-settings-file) in its composition', details: {} }
  }

  /** Missing-service report shared by the credentials domain. */
  function credentialsAbsent(): RpcError {
    return { code: 'internal', message: 'credentials service is absent: this deployment does not mount a credential provider (e.g. @buckeyestudio/toh-credentials-local) in its composition', details: {} }
  }

  /** Map one redacted settings descriptor to its wire view. */
  function namespaceView(descriptor: SettingsDescriptor): SettingsNamespaceView {
    return {
      ns: String(descriptor.ns),
      schema: descriptor.schema,
      value: descriptor.value,
      ...descriptor.base === undefined ? {} : { base: descriptor.base },
      ...descriptor.user === undefined ? {} : { user: descriptor.user },
      applies: descriptor.applies,
      secrets: (descriptor.secrets ?? []).map(secret => ({ path: [...secret.path], set: secret.set })),
      revision: descriptor.revision,
    }
  }

  /**
   * Run one settings write (merge or wholesale replace) and acknowledge with
   * the namespace's new redacted view. Every seam refusal — unknown or invalid
   * namespace, read-only provider, schema validation, storage — becomes one
   * `settings-rejected` carrying the seam's own message.
   */
  async function settingsWrite(
    request: RpcRequest<unknown>,
    ns: string,
    mode: 'update' | 'replace' | 'mutate',
    section: object,
    expectedRevision?: number,
  ): Promise<RpcResponse<SettingsNamespaceView>> {
    const settings = ctx.get('settings')
    if (settings === undefined) return err(request, settingsAbsent())
    const rejected = (error: unknown): RpcResponse<SettingsNamespaceView> => {
      // A stale writer is its own outcome, not a malformed request: the client
      // must re-read and re-apply rather than treat the write as invalid.
      if (error instanceof SettingsConflictError) {
        return err(request, {
          code: 'settings-conflict',
          message: error.message,
          details: { ns, expected: error.expected, actual: error.actual },
        })
      }
      return err(request, {
        code: 'settings-rejected',
        message: error instanceof Error ? error.message : String(error),
        details: { ns },
      })
    }
    let branded: SettingsNamespace
    try {
      branded = settingsNamespace(ns)
    } catch (error: unknown) {
      // A malformed name can address no registration, so it fails exactly as
      // an unregistered one does.
      return rejected(error)
    }
    try {
      if (mode === 'update') await settings.update(branded, section, expectedRevision)
      else if (mode === 'replace') await settings.replace(branded, section, expectedRevision)
      else await settings.mutate(branded, section as SettingsPathOp[], expectedRevision)
    } catch (error: unknown) {
      return rejected(error)
    }
    const descriptor = settings.describe({ redactSecrets: true }).find(candidate => candidate.ns === branded)
    if (descriptor === undefined) {
      // The write committed but the namespace vanished before this read: only
      // a concurrent registrant disposal can produce it.
      return err(request, { code: 'internal', message: `settings namespace "${ns}" was disposed after the ${mode}`, details: {} })
    }
    return ok(request, namespaceView(descriptor))
  }

  return {
    sessions: {
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
    },

    subagents: {
      async list(request, signal) {
        try {
          const entries = await ctx.subagents.listChildren(request.payload.parentSessionId, signal)
          return ok(request, {
            entries: entries.map(entry => entry.kind === 'child'
              ? {
                ...entry,
                activity: ctx.agents.get(entry.id)?.status === 'running' ? 'running' : 'inactive',
              }
              : entry),
            parentAvailable: ctx.agents.get(request.payload.parentSessionId) !== undefined,
          })
        } catch (error: unknown) {
          if (signal?.aborted || (error instanceof SubagentError && error.code === 'CANCELLED')) {
            return err(request, {
              code: 'cancelled',
              message: 'subagent catalog read was cancelled',
              details: {},
            })
          }
          if (error instanceof SubagentError && error.code === 'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE') {
            return err(request, projectionsUnavailableError())
          }
          return err(request, {
            code: 'internal',
            message: 'subagent catalog read failed',
            details: {},
          })
        }
      },

      async history(request, signal) {
        const {
          parentSessionId, childSessionId, mode, beforeSeq, maxMessages,
        } = request.payload
        const verified = await catalogChild(ctx, {
          parentSessionId, childSessionId, mode,
        }, signal)
        if (verified.error !== undefined) return err(request, verified.error)
        // The generic-history data plane: an attached child serves its
        // in-memory snapshot and the registry's live watermark projections; a
        // cold child is one persistence inspection plus a detached fold.
        let header: SessionHeader
        let events: SessionEvent[]
        let projections: SessionProjectionsBlock | undefined
        const attached = ctx.sessions.get(childSessionId)
        if (attached !== undefined) {
          header = attached.header
          events = [...attached.events]
          projections = beforeSeq === undefined
            ? subagentHistoryProjections(ctx, childSessionId, () => projectionsFor(ctx, attached))
            : undefined
        } else {
          try {
            const inspected = await inspectServable(childSessionId)
            header = inspected.meta
            events = inspected.events
            projections = beforeSeq === undefined
              ? subagentHistoryProjections(ctx, childSessionId, () => detachedProjectionsFor(ctx, inspected.events))
              : undefined
          } catch (error: unknown) {
            if (signal?.aborted) {
              return err(request, {
                code: 'cancelled',
                message: 'subagent history read was cancelled',
                details: {},
              })
            }
            if (error instanceof SessionNotFound) {
              return err(request, {
                code: 'subagent-not-found',
                message: 'subagent disappeared during history read',
                details: { parentSessionId, childSessionId },
              })
            }
            return err(request, {
              code: 'internal',
              message: 'subagent history read failed',
              details: {},
            })
          }
        }
        if (signal?.aborted) {
          return err(request, {
            code: 'cancelled',
            message: 'subagent history read was cancelled',
            details: {},
          })
        }
        if (header.parentSession !== parentSessionId) {
          return err(request, {
            code: 'subagent-unauthorized',
            message: 'subagent parent changed during history read',
            details: { childSessionId },
          })
        }
        const page = historyPage(ctx, events, beforeSeq, maxMessages)
        return ok(request, { ...page, ...projections === undefined ? {} : { projections } })
      },

      async prompt(request, signal) {
        const { parentSessionId, childSessionId, content, clientTimeZone } = request.payload
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
        const parent = ctx.agents.get(parentSessionId)
        if (parent === undefined) {
          return err(request, {
            code: 'subagent-parent-unavailable',
            message: `parent session "${parentSessionId}" is not live`,
            details: { parentSessionId },
          })
        }
        const verified = await catalogChild(ctx, {
          parentSessionId, childSessionId, mode: 'continuable',
        }, signal)
        if (verified.error !== undefined) return err(request, verified.error)
        try {
          const messageId = await ctx.subagents.followup(parent, childSessionId, content, {
            source: {
              kind: 'user',
              rpcId: request.rpcId,
              ...(canonicalTimeZone === undefined ? {} : { clientTimeZone: canonicalTimeZone }),
            },
            signal,
          })
          return ok(request, { messageId })
        } catch (error: unknown) {
          return subagentPromptError(request, error, signal)
        }
      },

      // Deliberately no catalog, history, persistence, or parent Agent lookup:
      // the core primitive alone authorizes the durable address against the
      // live Activation, which is what keeps a live child interruptible while
      // its parent Agent is offline. Absent targets are accepted no-ops there.
      interrupt(request) {
        const { parentSessionId, childSessionId } = request.payload
        try {
          ctx.subagents.interrupt(childSessionId, { kind: 'user', parentSessionId })
        } catch (error: unknown) {
          if (error instanceof SubagentError && error.code === 'UNAUTHORIZED') {
            return Promise.resolve(err(request, {
              code: 'subagent-unauthorized',
              message: 'subagent does not belong to this parent',
              details: { childSessionId },
            }))
          }
          return Promise.resolve(err(request, {
            code: 'internal',
            message: 'subagent interrupt failed',
            details: {},
          }))
        }
        return Promise.resolve(ok(request, { accepted: true as const }))
      },
    },

    workspace: {
      list(request) {
        return Promise.resolve(ok(request, {
          items: ctx.workspaceRegistry.list().map(workspaceView),
          archivedSessionIds: [...ctx.workspaceRegistry.archivedSessionIds],
        }))
      },

      async create(request) {
        const { path } = request.payload
        try {
          const { workspace, created } = await ensureWorkspace(path)
          return ok(request, { workspace: workspaceView(workspace), created })
        } catch (error: unknown) {
          // The registry rejects a path that does not resolve to an existing
          // directory (realpath ENOENT / not-a-directory) — the business
          // error of the typed-path flow, surfaced as a validation failure.
          return err(request, {
            code: 'workspace-invalid-path',
            message: `cannot create a workspace at "${path}": ${error instanceof Error ? error.message : String(error)}`,
            details: { path },
          })
        }
      },

      async rename(request) {
        const { payload } = request
        const workspace = ctx.workspaceRegistry.get(brandWorkspaceId(payload.workspaceId))
        if (workspace === undefined) return workspaceNotFound(request, payload.workspaceId)
        const title = payload.title.trim()
        // Uniqueness AND the same-title no-op both ride the create chain so
        // they observe the state left by earlier queued renames — checked
        // up front, a queued A→A could report success while an earlier A→B
        // still lands afterwards.
        const operation = workspaceCreationChain.then(async () => {
          if (title === workspace.title) return
          if (ctx.workspaceRegistry.list().some(other => other.id !== workspace.id && other.title === title)) {
            throw new WorkspaceNameConflictError(title)
          }
          await workspace.setTitle(title)
        })
        workspaceCreationChain = operation.then(() => undefined, () => undefined)
        try {
          await operation
        } catch (error: unknown) {
          if (error instanceof WorkspaceNameConflictError) {
            return err(request, {
              code: 'workspace-name-conflict',
              message: error.message,
              details: { name: error.workspaceName },
            })
          }
          throw error
        }
        return ok(request, { workspace: workspaceView(workspace) })
      },

      async delete(request) {
        const { workspaceId } = request.payload
        const operation = workspaceCreationChain.then(() =>
          ctx.workspaceRegistry.delete(brandWorkspaceId(workspaceId)))
        workspaceCreationChain = operation.then(() => undefined, () => undefined)
        if (!await operation) return workspaceNotFound(request, workspaceId)
        return ok(request, { deleted: true as const })
      },

      async insertBefore(request) {
        const { workspaceId, beforeWorkspaceId } = request.payload
        try {
          const workspaceIds = await ctx.workspaceRegistry.insertBefore(
            brandWorkspaceId(workspaceId),
            beforeWorkspaceId === undefined ? undefined : brandWorkspaceId(beforeWorkspaceId),
          )
          return ok(request, { workspaceIds: [...workspaceIds] })
        } catch (error: unknown) {
          if (!(error instanceof WorkspaceOrderInvalidError)) throw error
          return workspaceNotFound(request, error.workspaceId)
        }
      },

      async insertSessionBefore(request) {
        const { payload } = request
        const workspace = ctx.workspaceRegistry.get(brandWorkspaceId(payload.workspaceId))
        if (workspace === undefined) return workspaceNotFound(request, payload.workspaceId)
        try {
          await workspace.insertSessionBefore(payload.sessionId, payload.beforeSessionId)
        } catch (error: unknown) {
          // Only the entity's unaccounted-id rejection is the business code;
          // storage/durability failures propagate as internal errors.
          if (!(error instanceof WorkspaceMoveInvalidError)) throw error
          return err(request, {
            code: 'workspace-move-invalid',
            message: error.message,
            details: {
              workspaceId: payload.workspaceId,
              sessionId: payload.sessionId,
              ...payload.beforeSessionId === undefined ? {} : { beforeSessionId: payload.beforeSessionId },
            },
          })
        }
        return ok(request, { workspace: workspaceView(workspace) })
      },

      async archiveSession(request) {
        const { sessionId } = request.payload
        try {
          await ctx.workspaceRegistry.archiveSession(sessionId)
        } catch (error: unknown) {
          // Only the registry's unknown-session rejection is the business
          // code; storage/durability failures propagate as internal errors.
          if (!(error instanceof WorkspaceUnknownSessionError)) throw error
          return err(request, {
            code: 'session-not-found',
            message: error.message,
            details: { sessionId },
          })
        }
        return ok(request, { archivedSessionIds: [...ctx.workspaceRegistry.archivedSessionIds] })
      },
    },

    host: {
      describe(request) {
        // TODO: version should read apps/cli's package.json; placeholder for now.
        const selection = defaults.defaultModelSelection()
        return Promise.resolve(ok(request, {
          version: '0.0.1',
          // Same source as session.create's fallback: the UI's default project
          // must match where an unspecified-cwd session actually lands.
          cwd: defaults.cwd,
          // Read live for the same reason: this is what the NEXT session will
          // start from, so a saved default has to be what it reports.
          provider: selection.provider,
          model: selection.model,
          attachedSessions: ctx.agents.list().length,
          home: homedir(),
          canOpenPath: canOpenPaths(defaults),
        }))
      },

      async pickDirectory(request, signal) {
        const capability = ctx.directoryPicker.capability()
        if (capability.kind !== 'native') {
          return err(request, {
            code: 'directory-picker-unavailable',
            message: `host.pickDirectory needs the native capability; the composed picker serves "${capability.kind}"`,
            details: { capability: capability.kind },
          })
        }
        try {
          const path = await capability.pick(signal)
          return ok(request, { path })
        } catch (error: unknown) {
          if (signal.aborted) {
            return err(request, {
              code: 'cancelled',
              message: 'directory picker was aborted',
              details: {},
            })
          }
          return err(request, {
            code: 'internal',
            message: `directory picker failed: ${error instanceof Error ? error.message : String(error)}`,
            details: {},
          })
        }
      },

      async listDirectory(request, signal) {
        const capability = ctx.directoryPicker.capability()
        if (capability.kind !== 'browse') {
          return err(request, {
            code: 'directory-picker-unavailable',
            message: `host.listDirectory needs the browse capability; the composed picker serves "${capability.kind}"`,
            details: { capability: capability.kind },
          })
        }
        try {
          // The carrier's signal follows the caller: a disconnect or timeout
          // stops the backend's directory scan instead of outliving it.
          return ok(request, await capability.list(request.payload.path, signal))
        } catch (error: unknown) {
          // An abort is the caller's own timeout/disconnect, not a server
          // failure — same code pickDirectory and command.execute report.
          if (signal.aborted) {
            return err(request, { code: 'cancelled', message: 'directory listing was aborted', details: {} })
          }
          return err(request, directoryError(error))
        }
      },

      async createDirectory(request) {
        const capability = ctx.directoryPicker.capability()
        if (capability.kind !== 'browse') {
          return err(request, {
            code: 'directory-picker-unavailable',
            message: `host.createDirectory needs the browse capability; the composed picker serves "${capability.kind}"`,
            details: { capability: capability.kind },
          })
        }
        try {
          return ok(request, { path: await capability.createDirectory(request.payload.path, request.payload.name) })
        } catch (error: unknown) {
          return err(request, directoryError(error))
        }
      },

      async openPath(request, signal) {
        return openPath(defaults, request, request.payload.path, signal)
      },
    },

    goals: {
      // Mutations only — the read side is the 'goal' session projection.
      // Every verb resolves the session's agent (agentFor: implicit cold
      // resume, the command.* precedent) and acknowledges with the new CAS
      // ref; the committed goal/change event carries the whole value to every
      // client through the projection frames.
      async create(request) {
        const { objective, maxGoalRounds } = request.payload
        return mutateGoal(request, (goals, agent) => goals.create(agent, {
          objective,
          ...(maxGoalRounds !== undefined ? { maxGoalRounds } : {}),
        }))
      },

      async edit(request) {
        const { ref, objective, maxGoalRounds } = request.payload
        return mutateGoal(request, (goals, agent) => goals.edit(agent, ref, {
          ...(objective !== undefined ? { objective } : {}),
          ...(maxGoalRounds !== undefined ? { maxGoalRounds } : {}),
        }))
      },

      async pause(request) {
        return mutateGoal(request, (goals, agent) => goals.pause(agent, request.payload.ref))
      },

      async resume(request) {
        return mutateGoal(request, (goals, agent) => goals.resume(agent, request.payload.ref))
      },

      async complete(request) {
        return mutateGoal(request, (goals, agent) => goals.complete(agent, request.payload.ref))
      },

      async clear(request) {
        const found = await agentFor(request.payload.sessionId)
        if ('error' in found) return err(request, found.error)
        const goals = goalServiceFor(found.agent)
        if ('error' in goals) return err(request, goals.error)
        try {
          goals.clear(found.agent, request.payload.ref)
          return ok(request, { cleared: true as const })
        } catch (error: unknown) {
          return goalError(request, error)
        }
      },
    },

    agentPresets: {
      // A deployment with no roster answers with an empty list rather than an
      // error: composing no presets is a valid deployment, and the browser
      // simply offers no choice.
      async list(request) {
        const presets = ctx.get('agentPresets')
        if (presets === undefined) return ok(request, { presets: [], authorable: false, hasDocument: false })
        const defaultId = presets.defaultId
        return ok(request, {
          presets: (await presets.list()).map(preset => ({
            id: preset.id,
            trust: preset.trust,
            isDefault: preset.id === defaultId,
            ...preset.name === undefined ? {} : { name: preset.name },
            ...preset.description === undefined ? {} : { description: preset.description },
            ...preset.broken === undefined ? {} : { broken: preset.broken },
          })),
          authorable: presets.authorable,
          hasDocument: canOpenPaths(defaults),
        })
      },

      // Recomposing is limited to a blank session because a started
      // conversation's history was produced under its preset's tools; the
      // agent and the session survive, only the composition is swapped.
      async select(request) {
        const { sessionId, agentPreset } = request.payload
        const presets = ctx.get('agentPresets')
        if (presets === undefined) {
          return err(request, {
            code: 'agent-preset-not-found',
            message: 'this deployment composes no agent presets',
            details: { agentPreset, available: [] },
          })
        }
        const found = await agentFor(sessionId)
        if ('error' in found) return err(request, found.error)
        const { agent } = found
        const swap = async (): Promise<RpcResponse<{ agentPreset: string }>> => {
          // Re-read inside the queue: an earlier switch may have run, and a
          // conversation may have started, since this request arrived.
          if (!sessionBlank(agent.session)) {
            return err(request, {
              code: 'agent-preset-locked',
              message: `session "${sessionId}" has already started; its agent preset is fixed`,
              details: { sessionId, agentPreset },
            })
          }
          try {
            const preset = await presets.recompose(agent.ctx, agentPreset)
            // Recorded only after the swap committed: the log states what the
            // agent runs, and a rejected mount leaves the previous composition.
            agent.session.append('agent-preset/selected', { agentPreset: preset.id })
            return ok(request, { agentPreset: preset.id })
          } catch (error: unknown) {
            const refused = presetFailure(request, error)
            if (refused !== undefined) return refused
            return err(request, {
              code: 'internal',
              message: `failed to select agent preset "${agentPreset}": ${String(error)}`,
              details: {},
            })
          }
        }
        const queued = presetSwitches.get(sessionId) ?? Promise.resolve()
        const turn = queued.then(swap)
        presetSwitches.set(sessionId, turn.catch(() => undefined))
        try {
          return await turn
        } finally {
          if (presetSwitches.get(sessionId) === turn) presetSwitches.delete(sessionId)
        }
      },

      // Authoring is privileged (see PRIVILEGED_METHODS in toh-client-connection):
      // a composition names the plugins a session runs, so reading one is
      // reconnaissance, and copy/remove/openDocument manage the roster and
      // drive the host desktop.
      async read(request) {
        const { agentPreset } = request.payload
        const presets = ctx.get('agentPresets')
        if (presets === undefined) return err(request, noRoster(agentPreset))
        try {
          const preset = await presets.resolve(agentPreset)
          return ok(request, {
            agentPreset: preset.id,
            trust: preset.trust,
            content: await presets.read(preset.id),
            ...preset.name === undefined ? {} : { name: preset.name },
            ...preset.description === undefined ? {} : { description: preset.description },
          })
        } catch (error: unknown) {
          return err(request, presetError(agentPreset, error))
        }
      },

      async copy(request) {
        const { from, agentPreset, name } = request.payload
        const presets = ctx.get('agentPresets')
        if (presets === undefined) return err(request, noRoster(agentPreset))
        try {
          await presets.copy(from, agentPreset, name)
          return ok(request, { agentPreset })
        } catch (error: unknown) {
          return err(request, presetError(agentPreset, error))
        }
      },

      async openDocument(request, signal) {
        const { agentPreset } = request.payload
        const presets = ctx.get('agentPresets')
        if (presets === undefined) return err(request, noRoster(agentPreset))
        try {
          const preset = await presets.resolve(agentPreset)
          // Same line as copy/remove draw: the shipped install is not the
          // user's to manage, and pointing an editor into it invites edits an
          // upgrade will silently overwrite.
          if (preset.trust !== 'user') {
            throw new PresetNotWritableError(preset.id, 'it ships with the deployment')
          }
          // The id resolved against the Host's own roots is what selects the
          // directory — no browser payload carries a path in either direction
          // unless the deployment has no opener to hand it to.
          const directory = dirname(preset.path)
          if (!canOpenPaths(defaults)) return ok(request, { opened: false as const, path: directory })
          return await openPath(defaults, request, directory, signal)
        } catch (error: unknown) {
          return err(request, presetError(agentPreset, error))
        }
      },

      async remove(request) {
        const { agentPreset } = request.payload
        const presets = ctx.get('agentPresets')
        if (presets === undefined) return err(request, noRoster(agentPreset))
        try {
          await presets.remove(agentPreset)
          return ok(request, {})
        } catch (error: unknown) {
          return err(request, presetError(agentPreset, error))
        }
      },
    },

    skills: {
      // Skill lookup never creates or resumes an agent: the session address
      // resolves to a canonical cwd from the host-resident session header, and
      // the view scope is the live agent or the preset's standing key.
      async list(request) {
        const { sessionId } = request.payload
        const session = ctx.sessions.get(sessionId)
        if (session === undefined) {
          return err(request, {
            code: 'session-not-found',
            message: `session "${sessionId}" not found (not attached)`,
            details: { sessionId },
          })
        }
        if (session.header.cwd === undefined) {
          // Every served session records its project at create time; a
          // cwd-less header is a pre-project legacy log (not served).
          return err(request, { code: 'internal', message: `session "${sessionId}" has no project cwd`, details: {} })
        }
        const cwd = session.header.cwd
        // The host registry is layered per scope and serves every session. A
        // composition may still realm-mount its own registry instead; that
        // instance is invisible to host contexts, so address it through the
        // live agent (`agents.get` keeps the no-side-effect stance above).
        const live = ctx.agents.get(sessionId)
        const presets = ctx.get('agentPresets')
        const scoped = live === undefined ? undefined : presets?.serviceFor(live, 'skills')
        // Same stance as the commands domain: a missing service means no
        // composition mounts toh-skill, not an empty catalog. `ctx.get` also
        // keeps this handler independent of the gateway plugin's inject list
        // (an undeclared `ctx.skills` property read fails the reflect proxy).
        const skillRegistry = scoped ?? ctx.get('skills')
        if (skillRegistry === undefined) {
          return err(request, { code: 'internal', message: 'skill registry is absent: neither this session\'s agent preset nor the host composition mounts @buckeyestudio/toh-skill', details: {} })
        }
        // The scope presenters resolve in — the live agent, else the recorded
        // preset's standing key, else the global layer — so a cold session's
        // '/' popup lists the catalog its composition actually serves.
        const scope = await presenterScopeFor(ctx, sessionId, session)
        try {
          const skills = (await skillRegistry.list({ cwd, scope })).filter(isUserInvocable)
          return ok(request, {
            skills: skills.map(skill => ({
              name: skill.name,
              description: skill.description,
              ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
              modelInvocable: skill.invocation.modelInvocable,
            })),
          })
        } catch (error: unknown) {
          return err(request, { code: 'internal', message: `skill listing failed: ${String(error)}`, details: {} })
        }
      },
    },

    settings: {
      describe(request) {
        const settings = ctx.get('settings')
        if (settings === undefined) return Promise.resolve(err(request, settingsAbsent()))
        return Promise.resolve(ok(request, {
          writable: settings.writable,
          hasDocument: settings.documentPath !== undefined,
          namespaces: settings.describe({ redactSecrets: true }).map(namespaceView),
        }))
      },
      async openDocument(request, signal) {
        const settings = ctx.get('settings')
        if (settings === undefined) return err(request, settingsAbsent())
        if (isAborted(signal)) {
          return err(request, {
            code: 'cancelled',
            message: 'settings document open was aborted',
            details: {},
          })
        }
        let path: string | undefined
        try {
          path = await settings.prepareDocument()
        } catch (error: unknown) {
          if (isAborted(signal)) {
            return err(request, {
              code: 'cancelled',
              message: 'settings document preparation was aborted',
              details: {},
            })
          }
          return err(request, {
            code: 'internal',
            message: `settings document preparation failed: ${error instanceof Error ? error.message : String(error)}`,
            details: {},
          })
        }
        if (path === undefined) {
          return err(request, {
            code: 'internal',
            message: 'settings provider has no local document to open',
            details: {},
          })
        }
        if (isAborted(signal)) {
          return err(request, {
            code: 'cancelled',
            message: 'settings document open was aborted',
            details: {},
          })
        }
        return openTextFile(defaults, request, path, signal)
      },
      update: request => settingsWrite(request, request.payload.ns, 'update', request.payload.patch, request.payload.expectedRevision),
      replace: request => settingsWrite(request, request.payload.ns, 'replace', request.payload.section, request.payload.expectedRevision),
      mutate: request => settingsWrite(request, request.payload.ns, 'mutate', request.payload.ops, request.payload.expectedRevision),
    },

    credentials: {
      async describe(request) {
        const credentials = ctx.get('credentials')
        if (credentials === undefined) return err(request, credentialsAbsent())
        const entries = await Promise.all(request.payload.refs.map(async (ref) => {
          const info = await credentials.describe(credentialRef(ref))
          const view: CredentialView = {
            configured: info.configured,
            ...info.source === undefined ? {} : { source: info.source },
            writable: info.writable,
          }
          return [ref, view] as const
        }))
        return ok(request, { credentials: Object.fromEntries(entries) })
      },

      async set(request) {
        const credentials = ctx.get('credentials')
        if (credentials === undefined) return err(request, credentialsAbsent())
        const { ref, value } = request.payload
        try {
          await credentials.set(credentialRef(ref), value)
        } catch (error: unknown) {
          return err(request, {
            code: 'credential-rejected',
            message: error instanceof Error ? error.message : String(error),
            details: { ref },
          })
        }
        return ok(request, {})
      },

      async unset(request) {
        const credentials = ctx.get('credentials')
        if (credentials === undefined) return err(request, credentialsAbsent())
        const { ref } = request.payload
        try {
          await credentials.unset(credentialRef(ref))
        } catch (error: unknown) {
          return err(request, {
            code: 'credential-rejected',
            message: error instanceof Error ? error.message : String(error),
            details: { ref },
          })
        }
        return ok(request, {})
      },
    },

    llm: {
      providers(request) {
        const registered = ctx.llm.listProviders()
        const active = new Set(registered.map(provider => provider.id))
        const directory = ctx.llm.listConfigurableProviders()
        const declared = new Set(directory.map(entry => entry.provider))
        const views: ConfigurableProviderView[] = directory.map(entry => ({
          provider: entry.provider,
          displayName: entry.displayName,
          settingsNs: entry.settingsNs,
          settingsPath: [...entry.settingsPath],
          active: active.has(entry.provider),
          ...entry.declared === undefined ? {} : { declared: entry.declared },
          ...entry.baseURL === undefined ? {} : { baseURL: entry.baseURL },
        }))
        // Routes registered without a directory declaration still appear —
        // they exist and serve models — just with no settings address. No
        // adapter claimed them, so nothing can say whether they are shipped.
        for (const provider of registered) {
          if (declared.has(provider.id)) continue
          views.push({
            provider: provider.id,
            displayName: provider.name,
            settingsNs: '',
            settingsPath: [],
            active: true,
          })
        }
        return Promise.resolve(ok(request, { providers: views }))
      },

      async models(request) {
        return ok(request, await buildModelCatalog(ctx))
      },

      async discoverModels(request, signal) {
        const { settingsNs, provider, baseURL, api, apiKey } = request.payload
        try {
          const models = await ctx.llm.discoverModels(settingsNs, {
            ...provider === undefined ? {} : { provider },
            ...baseURL === undefined ? {} : { baseURL },
            ...api === undefined ? {} : { api },
            ...apiKey === undefined ? {} : { apiKey },
            ...signal === undefined ? {} : { signal },
          })
          return ok(request, { models })
        } catch (error: unknown) {
          // Every failure here is the user's next move, not a transport fault:
          // a wrong endpoint, a rejected key, or a protocol with no listing all
          // end at the same place — fill the models in by hand. The details
          // repeat only what the caller already sent, never the credential.
          return err(request, {
            code: 'model-discovery-failed',
            message: error instanceof Error ? error.message : String(error),
            details: { settingsNs, ...baseURL === undefined ? {} : { baseURL } },
          })
        }
      },
    },

    events: {
      mux(_request, signal) {
        const queue = new FrameQueue<RpcRequest<MuxFrame>>()
        muxQueues.add(queue)
        for (const session of ctx.sessions.list()) {
          subscribeSession(queue, session)
        }
        for (const pending of pendingQuestions.values()) {
          queue.push({
            rpcId: pending.rpcId,
            payload: {
              type: 'question/requested', sessionId: pending.sessionId,
              questions: pending.questions,
            },
          })
        }
        // Refresh recovery: still-pending approval questions replay with their
        // stable rpcId so a reconnecting client can still answer them.
        for (const pending of pendingApprovals.values()) queue.push(requestedFrame(pending))
        // Queue snapshot baseline (pendingQuestions precedent): frames replayed
        // in arrival order per session; a reconnecting client rebuilds its
        // queue view from these alone.
        for (const session of ctx.sessions.list()) {
          const agent = ctx.agents.get(session.id)
          if (agent?.session === session && agent.inbox.hasPending) {
            queue.push(frame({ type: 'session/queue', sessionId: session.id, items: queueItems(agent) }))
          }
        }
        // Background-task baseline. `ctx.agents.get` is the non-resuming read:
        // a session with no live Agent owns no tasks, so it correctly sees only
        // the unowned ones, and listing never revives a cold session. An empty
        // set sends nothing — absence is how the client reads "no tasks".
        const jobs = ctx.get('jobs')
        if (jobs !== undefined) {
          for (const session of ctx.sessions.list()) {
            const views = jobViews(jobs.list(ctx.agents.get(session.id)))
            if (views.length > 0) {
              queue.push(frame({ type: 'session/jobs', sessionId: session.id, jobs: views }))
            }
          }
        }
        // Per-session open-call table for result-view pairing. Bounded by the
        // per-turn call count: entries clear on turn/end; a table miss (stream
        // opened mid-turn) backscans the session's in-memory events instead.
        const openCalls = new Map<SessionId, Map<string, { name: string; args: unknown }>>()
        const disposers = [
          ctx.on('session/event', (session: Session, event: SessionEvent) => {
            if (event.type === 'tool/call') {
              const data = event.data as ToolCallData
              try {
                let table = openCalls.get(session.id)
                if (table === undefined) openCalls.set(session.id, table = new Map<string, { name: string; args: unknown }>())
                table.set(data.callId, { name: data.name, args: JSON.parse(data.arguments) })
              } catch {
                // Unparseable model arguments: leave the table unset; the result view soft-falls.
              }
            } else if (event.type === 'turn/end') {
              openCalls.delete(session.id)
            }
            const view = viewFor(
              ctx, event,
              callId => openCalls.get(session.id)?.get(callId) ?? backscanArgs(session.events, callId),
              ctx.agents.get(session.id),
            )
            queue.push(frame({ type: 'session/event', sessionId: session.id, event, ...view === undefined ? {} : { view } }))
          }),
          ctx.on('session/created', (session: Session) => {
            subscribeSession(queue, session)
            // The subscribe frame clears the client's task mirror, and a
            // session born after the stream opened missed the baseline loop.
            // Unowned tasks are visible to it from birth, so without this it
            // would show none until the next registry change.
            const views = jobs === undefined ? [] : jobViews(jobs.list(ctx.agents.get(session.id)))
            if (views.length > 0) {
              queue.push(frame({ type: 'session/jobs', sessionId: session.id, jobs: views }))
            }
          }),
          ctx.on('session/disposed', (session: Session) => {
            openCalls.delete(session.id)
          }),
          ...jobs === undefined ? [] : [jobs.onJobsChanged((owner) => {
            if (owner !== undefined) {
              // The exact owner instance the fence compares against, so the
              // push stays correct even while that Agent's scope is tearing
              // down and a lookup by id would already miss.
              queue.push(frame({ type: 'session/jobs', sessionId: owner.id, jobs: jobViews(jobs.list(owner)) }))
              return
            }
            // An unowned task is visible to every caller, so every subscribed
            // session's set changed with it.
            for (const session of ctx.sessions.list()) {
              queue.push(frame({
                type: 'session/jobs',
                sessionId: session.id,
                jobs: jobViews(jobs.list(ctx.agents.get(session.id))),
              }))
            }
          })],
        ]
        return queue.iterate(signal, () => {
          muxQueues.delete(queue)
          for (const dispose of disposers) dispose()
        })
      },

      host(_request, signal) {
        const queue = new FrameQueue<RpcRequest<HostFrame>>()
        const committedWorkspaces = ctx.workspaceRegistry.list()
        const committedWorkspaceIds = new Set(
          committedWorkspaces.map(workspace => String(workspace.id)),
        )
        let committedWorkspaceOrder = committedWorkspaces.map(workspace => workspace.id)
        // Frame-dedup baseline, same posture as committedWorkspaceIds: the
        // stream opens against the current set; workspace.list re-baselines
        // reconnecting clients, so only later changes need frames.
        let archivedSessionIds = ctx.workspaceRegistry.archivedSessionIds
        const disposers = [
          ctx.on('session/created', (session: Session) => {
            queue.push(frame({
              type: 'host/session-added',
              sessionId: session.id,
              // Derived at frame time like summarize(); a just-created session
              // has run no turn yet, so this is constantly true in practice.
              blank: sessionBlank(session),
              // Including cwd lets the client group the new session without refreshing the list.
              ...sessionListFields(session.header, session.events),
            }))
          }),
          ctx.on('session/disposed', (session: Session) => {
            queue.push(frame({ type: 'host/session-removed', sessionId: session.id }))
          }),
          ctx.on('agent/status', ({ agent, status }: { agent: Agent; status: AgentStatus }) => {
            queue.push(frame({ type: 'host/session-status', sessionId: agent.id, running: status === 'running' }))
          }),
          ctx.on('agent/error', ({ agent, error }: { agent: Agent; error: unknown }) => {
            queue.push(frame({ type: 'host/agent-error', sessionId: agent.id, message: errorChain(error) }))
          }),
          ctx.on('domain/changed', (change) => {
            if (change.domain !== 'workspace') return
            if (change.table === '') {
              if (change.operation !== 'put') return
              const state = workspaceDomainState.parse(change.value)
              const orderChanged = state.workspaceIds.length === committedWorkspaceOrder.length
                && state.workspaceIds.every(workspaceId => committedWorkspaceIds.has(String(workspaceId)))
                && state.workspaceIds.some((workspaceId, index) => workspaceId !== committedWorkspaceOrder[index])
              for (const workspaceId of state.workspaceIds) {
                if (committedWorkspaceIds.has(workspaceId)) continue
                const workspace = ctx.workspaceRegistry.get(workspaceId)
                if (workspace === undefined) {
                  throw new Error(`committed workspace registry references missing workspace "${workspaceId}"`)
                }
                committedWorkspaceIds.add(workspaceId)
                queue.push(frame({ type: 'host/workspace-changed', workspace: workspaceView(workspace) }))
              }
              committedWorkspaceOrder = [...state.workspaceIds]
              if (orderChanged) {
                queue.push(frame({
                  type: 'host/workspace-order-changed',
                  workspaceIds: [...state.workspaceIds],
                }))
              }
              if (state.archivedSessionIds.length !== archivedSessionIds.length
                || state.archivedSessionIds.some((id, index) => id !== archivedSessionIds[index])) {
                archivedSessionIds = state.archivedSessionIds
                queue.push(frame({
                  type: 'host/archived-sessions-changed',
                  archivedSessionIds: [...state.archivedSessionIds],
                }))
              }
              return
            }
            if (change.table !== 'workspaces') return
            if (change.operation === 'deleted') {
              if (!committedWorkspaceIds.delete(change.key)) return
              queue.push(frame({
                type: 'host/workspace-removed',
                workspaceId: change.key as WorkspaceId,
              }))
              return
            }
            if (!committedWorkspaceIds.has(change.key)) return
            // Existing-entity table writes are complete attach/touch commits.
            // A new entity's first put waits for the global registry write above.
            queue.push(frame({
              type: 'host/workspace-changed',
              workspace: changedWorkspaceView(change.key, change.value),
            }))
          }),
          // Allowlisted host events ride one verbatim wrapper frame each. The
          // allowlist is api-remotes', and `ctx.remote.$on` is the consumer
          // face; nothing here projects, redacts, or renames.
          ...API_REMOTE_FORWARDED_EVENTS.map(name => ctx.on(
            name,
            // The allowlist's shape assertion proves each name is a real,
            // non-scoped, void-returning event, so the rest-parameter handler
            // satisfies every member of the union `on` accepts here;
            // assertJsonArgs proves the payload is JSON-safe before it queues.
            ((...args: unknown[]) => {
              queue.push(frame({
                type: 'host/remote-event',
                event: name,
                args: assertJsonArgs(name, args),
              }))
            }),
          )),
        ]
        return queue.iterate(signal, () => { for (const dispose of disposers) dispose() })
      },
    },

    downloads: {
      async sessionLog(request, signal) {
        // Clean error path first: missing services answer 500 and a missing
        // root artifact 404 before any zip byte is produced. The root content
        // read here is reused as the first zip entry, so nothing is read twice.
        const deps = sessionLogExportDeps(ctx)
        if (deps.sessionQuery === undefined || deps.sessionPersistence === undefined || deps.attachments === undefined) {
          return new Response(
            'session log export is unavailable: missing session-query, session-persistence, or attachments service',
            { status: 500 },
          )
        }
        if (!deps.sessionPersistence.supportsRawArtifacts) {
          return new Response(
            'session log export is unavailable: the persistence backend does not expose per-session raw artifacts',
            { status: 501 },
          )
        }
        const ready: SessionLogExportReady = {
          sessionQuery: deps.sessionQuery,
          sessionPersistence: deps.sessionPersistence,
          attachments: deps.attachments,
          sessions: deps.sessions,
        }
        let root: SessionRawArtifact | undefined
        try {
          await flushLiveSessionLog(deps, request.sessionId, signal)
          root = await deps.sessionPersistence.readRaw(request.sessionId, signal)
          signal.throwIfAborted()
        } catch {
          signal.throwIfAborted()
          // Root preparation failure: answer 500 without echoing the error,
          // which may carry absolute host paths into the browser error bar.
          return new Response('session log export failed to prepare the stored artifact', { status: 500 })
        }
        if (root === undefined) {
          return new Response('session not found', { status: 404 })
        }
        return new Response(
          streamSessionLogZip(
            ready,
            root,
            request.sessionId,
            request.includeDescendants === true,
            sessionExportCompressionLevel,
            signal,
          ),
          {
            headers: {
              'content-type': 'application/zip',
              'content-disposition': `attachment; filename="${sessionLogZipFilename(request.sessionId)}"`,
            },
          },
        )
      },
    },

    respond,
  }
}
