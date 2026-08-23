/**
 * subagents domain impl: the catalog/history/prompt/interrupt surface over
 * `ctx.subagents`, with address verification against the complete direct-child
 * catalog before any transcript read.
 */

import type { Context } from '@buckeyestudio/cordis'
// Value edges resolve the `ctx.agents` / `ctx.sessions` / `ctx.subagents` merges.
import type {} from '@buckeyestudio/toh-agent'
import type { SessionEvent, SessionHeader, SessionId } from '@buckeyestudio/toh-session'
import { SubagentError } from '@buckeyestudio/toh-subagent'
import type { SubagentListEntry as CatalogSubagentListEntry } from '@buckeyestudio/toh-subagent'
import { ApiRemoteSessionNotFound as SessionNotFound } from '@buckeyestudio/toh-api-remotes'
import type { ApiProxy, SessionProjectionsBlock, SubagentAddress } from './index.ts'
import type { RpcError, RpcRequest, RpcResponse } from './rpc.ts'
import {
  apiRemoteFences,
  canonicalClientTimeZone,
  detachedProjectionsFor,
  err,
  historyPage,
  ok,
  projectionsFor,
} from './proxy-shared.ts'

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
 * Best-effort projections for one subagent history page, fail-soft like the
 * session.list projection column: a registered unit throwing on a corrupt
 * payload never blocks transcript reading — the page is served without the
 * block.
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

/**
 * Create the subagents domain over a composed host context.
 * @param ctx - a context with the Host spine and the subagent capability mounted.
 * @returns the `subagents.*` method group.
 */
export function createSubagentsImpl(ctx: Context): ApiProxy['subagents'] {
  const { inspectServable } = apiRemoteFences(ctx)

  return {
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
  }
}
