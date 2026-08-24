/**
 * settings domain impl: the configuration-page wire — describe, document
 * open, and the three write modes, with every seam refusal folded onto
 * `settings-rejected` / `settings-conflict`.
 */

import type { Context } from '@buckeyestudio/cordis'
import { SettingsConflictError, settingsNamespace } from '@buckeyestudio/toh-settings'
import type { SettingsDescriptor, SettingsNamespace, SettingsPathOp } from '@buckeyestudio/toh-settings'
import type { ApiProxy, SettingsNamespaceView } from './index.ts'
import type { RpcError, RpcRequest, RpcResponse } from './rpc.ts'
import { err, isAborted, ok, openTextFile } from './proxy-shared.ts'
import type { ApiProxyDefaults } from '../api-proxy.ts'

/**
 * Create the settings domain over a composed host context.
 * @param ctx - a context with the Host spine mounted; a composition without a
 * settings provider still serves every other domain.
 * @param defaults - host routing defaults (native text-editor injectable).
 * @returns the `settings.*` method group.
 */
export function createSettingsImpl(ctx: Context, defaults: ApiProxyDefaults): ApiProxy['settings'] {
  /** Missing-service report shared by the settings domain (skills-domain stance). */
  function settingsAbsent(): RpcError {
    return { code: 'internal', message: 'settings service is absent: this deployment does not mount a settings provider (e.g. @buckeyestudio/toh-settings-file) in its composition', details: {} }
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
  }
}
