/**
 * credentials domain impl: value-free describe views plus set/unset, with a
 * shadowed-reference refusal mapped onto `credential-rejected`.
 */

import type { Context } from '@buckeyestudio/cordis'
import { credentialRef } from '@buckeyestudio/toh-credentials'
import type { CredentialView } from './index.ts'
import type { ApiProxy } from './index.ts'
import type { RpcError } from './rpc.ts'
import { err, ok } from './proxy-shared.ts'

/**
 * Create the credentials domain over a composed host context.
 * @param ctx - a context with the Host spine mounted; a composition without a
 * credential provider still serves every other domain.
 * @returns the `credentials.*` method group.
 */
export function createCredentialsImpl(ctx: Context): ApiProxy['credentials'] {
  /** Missing-service report shared by the credentials domain. */
  function credentialsAbsent(): RpcError {
    return { code: 'internal', message: 'credentials service is absent: this deployment does not mount a credential provider (e.g. @buckeyestudio/toh-credentials-local) in its composition', details: {} }
  }

  return {
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
  }
}
