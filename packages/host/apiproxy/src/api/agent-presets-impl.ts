/**
 * agentPresets domain impl: the preset roster (list/select) plus the
 * authoring rows (read/copy/openDocument/remove) over `ctx.agentPresets`.
 */

import { dirname } from 'node:path'
import type { Context } from '@buckeyestudio/cordis'
import type { Agent } from '@buckeyestudio/toh-agent'
import type { SessionId } from '@buckeyestudio/toh-session'
import {
  InvalidPresetIdError, PresetExistsError, PresetNotWritableError,
  UnknownPresetError,
} from '@buckeyestudio/toh-agent-presets'
// Value edge resolves the `ctx.get('agentPresets')` service typing.
import type {} from '@buckeyestudio/toh-agent-presets/types'
import type { ApiProxy } from './index.ts'
import type { RpcError, RpcResponse } from './rpc.ts'
import { canOpenPaths, err, ok, openPath, presetFailure, sessionBlank } from './proxy-shared.ts'
import type { ApiProxyDefaults } from '../api-proxy.ts'

/** The shared Agent resolver the sessions domain owns. */
export interface AgentPresetsDeps {
  agentFor: (sessionId: SessionId) => Promise<{ agent: Agent } | { error: RpcError }>
}

/**
 * Run one operation behind its key's queue: each call chains onto the previous
 * call's settlement, so concurrent calls for one key compose in arrival order.
 * The link stored under the key is the settled (never-rejecting) derivative of
 * the caller's turn, and the cleanup compares against THAT object — comparing
 * the raw turn never matches, so the entry and every retained closure would
 * survive each call and grow the map for the host lifetime.
 * @param queues - per-key operation chains, mutated for the duration of the call.
 * @param key - the key whose chain this call joins.
 * @param operation - the operation to run once earlier calls have settled.
 * @returns the operation's own outcome, rejections included.
 */
export async function runQueued<K, T>(
  queues: Map<K, Promise<unknown>>,
  key: K,
  operation: () => Promise<T>,
): Promise<T> {
  const queued = queues.get(key) ?? Promise.resolve()
  const turn = queued.then(operation)
  const settled = turn.catch(() => undefined)
  queues.set(key, settled)
  try {
    return await turn
  } finally {
    if (queues.get(key) === settled) queues.delete(key)
  }
}

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

/**
 * Create the agentPresets domain over a composed host context.
 * @param ctx - a context with the Host spine mounted; the preset roster is optional.
 * @param defaults - host routing defaults (native-open injectables).
 * @param deps - the shared Agent resolver.
 * @returns the `agentPreset.*` method group.
 */
export function createAgentPresetsImpl(ctx: Context, defaults: ApiProxyDefaults, deps: AgentPresetsDeps): ApiProxy['agentPresets'] {
  const { agentFor } = deps
  /**
   * Serializes `agentPreset.select` per session. Two concurrent selects both
   * pass the blank check, and the second `unmountPresetFor` then finds nothing
   * to unmount because the first already removed the record — leaving two
   * compositions registered into one agent layer. The client's `busy` flag is
   * not enforcement: the wire is reachable directly.
   */
  const presetSwitches = new Map<SessionId, Promise<unknown>>()

  return {
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
      return runQueued(presetSwitches, sessionId, swap)
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
  }
}
