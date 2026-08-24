/**
 * Host-side ApiProxy implementation. Signature discipline: unary takes the
 * narrow RpcRequest<P> and echoes request.rpcId on the RpcResponse<T>.
 *
 * This module is the gateway assembly: it resolves configuration defaults,
 * owns the two projection units and the live-push wiring, instantiates every
 * per-domain impl module (`src/api/<domain>-impl.ts`), and hands each the
 * `(ctx, defaults)` closures it consumes — `agentFor` from the sessions
 * domain, the interaction channel's pending registries from
 * interactions-impl, and the open mux subscriptions from here.
 */

import { z as zod } from 'zod'
import type { Context } from '@buckeyestudio/cordis'
import type { ModelSelection } from '@buckeyestudio/toh-agent'
import type {} from '@buckeyestudio/toh-agent-presets/types'
import { DEFAULT_SESSION_LOG_COMPRESSION_LEVEL } from './session-export.ts'
import type { SessionLogCompressionLevel } from './session-export.ts'
// Type-only: resolves `ctx.get('sessionProjections')` to the projection registry.
import type {} from '@buckeyestudio/toh-session-projection'
// Value edge: mints pushed frames and types the mux subscription set.
import { applySessionListMetadata, frame, FrameQueue, queueItems } from './api/proxy-shared.ts'
import type { ApiProxy, MuxFrame, SessionListMetadata } from './api/index.ts'
import type { RpcRequest } from './api/rpc.ts'
import { imageLimitsProjectionSchema, sessionListMetadataProjectionSchema } from './api/sessions.schema.ts'
import { createInteractionsImpl } from './api/interactions-impl.ts'
import { createSessionsImpl } from './api/sessions-impl.ts'
import { createSubagentsImpl } from './api/subagents-impl.ts'
import { createWorkspaceImpl } from './api/workspace-impl.ts'
import { createHostImpl } from './api/host-impl.ts'
import { createGoalsImpl } from './api/goals-impl.ts'
import { createAgentPresetsImpl } from './api/agent-presets-impl.ts'
import { createSkillsImpl } from './api/skills-impl.ts'
import { createSettingsImpl } from './api/settings-impl.ts'
import { createCredentialsImpl } from './api/credentials-impl.ts'
import { createLlmImpl } from './api/llm-impl.ts'
import { createEventsImpl } from './api/events-impl.ts'
import { createDownloadsImpl } from './api/downloads-impl.ts'

export { assertJsonArgs } from './api/proxy-shared.ts'

/** Default maximum artifact size eligible for one cold blankness read. */
export const DEFAULT_COLD_BLANK_PROBE_MAX_BYTES = 1024

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
   * falls back to platform detection (canOpenNativePath).
   */
  canOpenPath?: () => boolean
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
  // The sessions domain owns the shared Agent resolver every session-addressed
  // method (goals, agent presets included) resolves identities through.
  const { sessions, agentFor } = createSessionsImpl(ctx, defaults, { coldBlankProbeMaxBytes })
  const muxQueues = new Set<FrameQueue<RpcRequest<MuxFrame>>>()

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

  return {
    sessions,
    subagents: createSubagentsImpl(ctx),
    workspace: createWorkspaceImpl(ctx),
    host: createHostImpl(ctx, defaults),
    goals: createGoalsImpl(ctx, { agentFor }),
    agentPresets: createAgentPresetsImpl(ctx, defaults, { agentFor }),
    skills: createSkillsImpl(ctx),
    settings: createSettingsImpl(ctx, defaults),
    credentials: createCredentialsImpl(ctx),
    llm: createLlmImpl(ctx),
    events: createEventsImpl(ctx, { muxQueues, pendingQuestions, pendingApprovals }),
    downloads: createDownloadsImpl(ctx, { compressionLevel: sessionExportCompressionLevel }),
    respond,
  }
}
