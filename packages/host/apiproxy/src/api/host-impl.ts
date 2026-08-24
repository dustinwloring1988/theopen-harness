/**
 * host domain impl: the host.describe capability report plus the
 * directory-picker rows and native path opening over the composed backend.
 */

import { homedir } from 'node:os'
import type { Context } from '@buckeyestudio/cordis'
// Value edge resolves the `ctx.directoryPicker` merge.
import type {} from '@buckeyestudio/toh-host-directory-picker'
import { DirectoryPickerError } from '@buckeyestudio/toh-host-directory-picker'
import type { ApiProxy } from './index.ts'
import type { RpcError } from './rpc.ts'
import { canOpenPaths, err, ok, openPath } from './proxy-shared.ts'
import type { ApiProxyDefaults } from '../api-proxy.ts'

/** Map a browse-primitive failure onto the wire error vocabulary (unknown throws stay internal). */
function directoryError(error: unknown): RpcError {
  if (error instanceof DirectoryPickerError) {
    return { code: error.code, message: error.message, details: { path: error.path } }
  }
  return { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} }
}

/**
 * Create the host domain over a composed host context.
 * @param ctx - a context with the Host spine and directory picker mounted.
 * @param defaults - host routing and project-directory defaults.
 * @returns the `host.*` method group.
 */
export function createHostImpl(ctx: Context, defaults: ApiProxyDefaults): ApiProxy['host'] {
  return {
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
  }
}
