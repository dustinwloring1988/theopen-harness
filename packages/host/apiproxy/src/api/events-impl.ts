/**
 * events domain impl: the live-push streams — `events.mux` (per-session event
 * frames, projection/queue/job pushes, and pending question/approval replays)
 * and `events.host` (workspace registry increments plus allowlisted forwarded
 * host events).
 */

import type { Context } from '@buckeyestudio/cordis'
import type { Agent, AgentStatus } from '@buckeyestudio/toh-agent'
import { errorChain } from '@buckeyestudio/toh-llm'
import type { Session, SessionEvent, SessionId } from '@buckeyestudio/toh-session'
// Type-only: resolves `ctx.get('tasks')` to the background job registry.
import type {} from '@buckeyestudio/toh-jobs'
import type { JobSnapshot } from '@buckeyestudio/toh-jobs'
// Type-only: the dynamic-package runner's forwarded-event declarations. Its
// client-safe `./types` subpath deliberately, not the package root — the root
// merges `ctx.dynamicCordisRunner`, and a dependency on that package would
// rebuild the api-remotes cycle this direction exists to avoid.
import type {} from '@buckeyestudio/toh-cordis-host-runner/types'
// Type-only edges: resolve the forwarded-event declarations onto the cordis
// Events map for every allowlisted emitter (commands/change, preset selection,
// settings/credentials documents).
import type {} from '@buckeyestudio/toh-commands'
import type {} from '@buckeyestudio/toh-agent-presets/types'
import type {} from '@buckeyestudio/toh-settings'
import type {} from '@buckeyestudio/toh-credentials'
import { workspaceDomainState, WorkspaceId } from '@buckeyestudio/toh-workspace'
import { API_REMOTE_FORWARDED_EVENTS } from '@buckeyestudio/toh-api-remotes'
import type {
  ApiProxy, HostFrame, JobView, MuxFrame,
} from './index.ts'
import type { RpcId, RpcRequest } from './rpc.ts'
import {
  assertJsonArgs,
  backscanArgs,
  changedWorkspaceView,
  frame,
  FrameQueue,
  queueItems,
  sessionBlank,
  sessionListFields,
  subscribeSession,
  viewFor,
  workspaceView,
} from './proxy-shared.ts'
import type { ToolCallData } from './proxy-shared.ts'
import type {
  PendingApproval, PendingQuestion,
} from './interactions-impl.ts'
import { requestedFrame } from './interactions-impl.ts'

/** Closure state the streams read from the gateway assembly. */
export interface EventsDeps {
  /** Every open mux subscription; transient frames push here directly. */
  muxQueues: Set<FrameQueue<RpcRequest<MuxFrame>>>
  /** Host-owned question waits, replayed as the mux-open baseline. */
  pendingQuestions: Map<RpcId, PendingQuestion>
  /** Outstanding approval asks, replayed as the mux-open baseline. */
  pendingApprovals: Map<RpcId, PendingApproval>
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

/**
 * Create the events domain over a composed host context.
 * @param ctx - a context with the Host spine mounted; a composition without
 * the jobs registry serves histories without job surfaces.
 * @param deps - shared gateway push state (mux subscriptions, pending registries).
 * @returns the `events.*` method group.
 */
export function createEventsImpl(ctx: Context, deps: EventsDeps): ApiProxy['events'] {
  const { muxQueues, pendingQuestions, pendingApprovals } = deps

  return {
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
  }
}
