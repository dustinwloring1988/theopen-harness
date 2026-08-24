/**
 * skills domain impl: `skill.list` serves the composer's menu — every
 * user-invocable skill with its `modelInvocable` flag, resolved in the view
 * scope the session's composition decides.
 */

import type { Context } from '@buckeyestudio/cordis'
import { isUserInvocable } from '@buckeyestudio/toh-skill'
// Value edge resolves the `ctx.get('skills')` registry typing and the
// `ctx.agents` / `ctx.sessions` merges this domain reads.
import type {} from '@buckeyestudio/toh-skill'
import type { ApiProxy } from './index.ts'
import { err, ok, presenterScopeFor } from './proxy-shared.ts'

/**
 * Create the skills domain over a composed host context.
 * @param ctx - a context with the Host spine mounted; skill lookup never
 * creates or resumes an agent.
 * @returns the `skills.*` method group.
 */
export function createSkillsImpl(ctx: Context): ApiProxy['skills'] {
  return {
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
  }
}
