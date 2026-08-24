/**
 * workspace domain impl: the workspace registry rows (create, rename, delete,
 * reorder, session ordering, archive) over the Host's serialized mutation
 * chain.
 */

import type { Context } from '@buckeyestudio/cordis'
import type { Workspace } from '@buckeyestudio/toh-workspace'
import {
  WorkspaceId as brandWorkspaceId,
  WorkspaceMoveInvalidError, WorkspaceOrderInvalidError, WorkspaceUnknownSessionError,
} from '@buckeyestudio/toh-workspace'
// Value edge resolves the `ctx.workspaceRegistry` merge.
import type {} from '@buckeyestudio/toh-workspace'
import type { ApiProxy } from './index.ts'
import type { RpcRequest, RpcResponse } from './rpc.ts'
import { err, ok, workspaceView } from './proxy-shared.ts'

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
 * Create the workspace domain over a composed host context.
 * @param ctx - a context with the Workspace registry mounted.
 * @returns the `workspace.*` method group.
 */
export function createWorkspaceImpl(ctx: Context): ApiProxy['workspace'] {
  /** Serializes path ownership and explicit title checks with Workspace mutations. */
  let workspaceCreationChain = Promise.resolve()

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

  return {
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
  }
}
