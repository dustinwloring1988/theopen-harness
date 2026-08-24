/**
 * goals domain impl: mutations over the session's goal service — every verb
 * resolves the session's agent and acknowledges with the new CAS ref; the
 * committed `goal/change` event carries the whole value to clients through the
 * projection frames.
 */

import type { Context } from '@buckeyestudio/cordis'
import type { Agent } from '@buckeyestudio/toh-agent'
import type { SessionId } from '@buckeyestudio/toh-session'
import { ApiRemoteAgentResult } from '@buckeyestudio/toh-api-remotes'
// GoalError narrows domain rejections to their stable codes at the wire boundary.
import { GoalError } from '@buckeyestudio/toh-goal'
import type { GoalRef as CoreGoalRef } from '@buckeyestudio/toh-goal'
import type { ApiProxy, GoalRef } from './index.ts'
import type { RpcError, RpcRequest, RpcResponse } from './rpc.ts'
import { err, ok } from './proxy-shared.ts'

/** The shared Agent resolver the sessions domain owns. */
export interface GoalsDeps {
  agentFor: (sessionId: SessionId) => Promise<ApiRemoteAgentResult>
}

/**
 * Create the goals domain over a composed host context.
 * @param ctx - a context with the Host spine mounted; the goal service is per
 * session (agent preset scopes), so it is resolved per call.
 * @param deps - the shared Agent resolver.
 * @returns the `goals.*` method group.
 */
export function createGoalsImpl(ctx: Context, deps: GoalsDeps): ApiProxy['goals'] {
  const { agentFor } = deps

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

  return {
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
  }
}
