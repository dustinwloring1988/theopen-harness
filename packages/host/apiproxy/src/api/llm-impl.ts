/**
 * llm domain impl: the provider directory, the host-scoped model catalog, and
 * ad-hoc discovery against a user-supplied endpoint.
 */

import type { Context } from '@buckeyestudio/cordis'
// Value edge resolves the `ctx.llm` merge.
import type {} from '@buckeyestudio/toh-llm'
import type { ApiProxy, ConfigurableProviderView } from './index.ts'
import { buildModelCatalog, err, ok } from './proxy-shared.ts'

/**
 * Create the llm domain over a composed host context.
 * @param ctx - a context with the Host spine and an LLM registry mounted.
 * @returns the `llm.*` method group.
 */
export function createLlmImpl(ctx: Context): ApiProxy['llm'] {
  return {
    providers(request) {
      const registered = ctx.llm.listProviders()
      const active = new Set(registered.map(provider => provider.id))
      const directory = ctx.llm.listConfigurableProviders()
      const declared = new Set(directory.map(entry => entry.provider))
      const views: ConfigurableProviderView[] = directory.map(entry => ({
        provider: entry.provider,
        displayName: entry.displayName,
        settingsNs: entry.settingsNs,
        settingsPath: [...entry.settingsPath],
        active: active.has(entry.provider),
        ...entry.declared === undefined ? {} : { declared: entry.declared },
        ...entry.baseURL === undefined ? {} : { baseURL: entry.baseURL },
      }))
      // Routes registered without a directory declaration still appear —
      // they exist and serve models — just with no settings address. No
      // adapter claimed them, so nothing can say whether they are shipped.
      for (const provider of registered) {
        if (declared.has(provider.id)) continue
        views.push({
          provider: provider.id,
          displayName: provider.name,
          settingsNs: '',
          settingsPath: [],
          active: true,
        })
      }
      return Promise.resolve(ok(request, { providers: views }))
    },

    async models(request) {
      return ok(request, await buildModelCatalog(ctx))
    },

    async discoverModels(request, signal) {
      const { settingsNs, provider, baseURL, api, apiKey } = request.payload
      try {
        const models = await ctx.llm.discoverModels(settingsNs, {
          ...provider === undefined ? {} : { provider },
          ...baseURL === undefined ? {} : { baseURL },
          ...api === undefined ? {} : { api },
          ...apiKey === undefined ? {} : { apiKey },
          ...signal === undefined ? {} : { signal },
        })
        return ok(request, { models })
      } catch (error: unknown) {
        // Every failure here is the user's next move, not a transport fault:
        // a wrong endpoint, a rejected key, or a protocol with no listing all
        // end at the same place — fill the models in by hand. The details
        // repeat only what the caller already sent, never the credential.
        return err(request, {
          code: 'model-discovery-failed',
          message: error instanceof Error ? error.message : String(error),
          details: { settingsNs, ...baseURL === undefined ? {} : { baseURL } },
        })
      }
    },
  }
}
