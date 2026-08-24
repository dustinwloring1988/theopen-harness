/**
 * Cross-session fact memory registry (`ctx.memory`): the Service Definition of
 * the memory capability seam. Providers own WHERE facts persist and HOW
 * queries match; this service owns the merge-extensible provider map,
 * execution-time provider selection, blank-input rejection, and the
 * `memory/changed` event emitted after each committed mutation.
 *
 * Selection never depends on registration order: a configured provider id
 * must be registered, and without one exactly a single registered provider is
 * required — the same rules the `ctx.web` seam established.
 *
 * @module @buckeyestudio/toh-memory
 */

import { Context, Service } from '@buckeyestudio/cordis'
import z from '@buckeyestudio/schemastery'
import { MemoryFactId } from './types.ts'
import type { MemoryChanged, MemoryFact, MemoryProvider, RecallOptions, RememberInput } from './types.ts'

export { MemoryFactId } from './types.ts'
export type { MemoryChanged, MemoryFact, MemoryProvider, RecallOptions, RememberInput } from './types.ts'

declare module '@buckeyestudio/cordis' {
  interface Context {
    memory: MemoryRegistry
  }

  interface Events {
    /**
     * A stored fact was created or deleted. Emitted once per committed
     * mutation, strictly after the provider acknowledged durability; a failed
     * or no-op mutation emits nothing.
     * @param change - operation discriminant, owning provider name, and the fact id.
     * @mode emit
     */
    'memory/changed'(change: MemoryChanged): void
  }
}

/** Registry configuration. */
export interface Config {
  /** Explicit provider id. Omitted = auto-select when exactly one provider is registered. */
  readonly provider?: string
}

/**
 * Provider registry for durable cross-session facts. One instance per
 * context; providers register under unique names and dispose with their
 * fiber. Every operation resolves the serving provider at call time with the
 * selection rules on {@link Config}, so composition can add or remove a
 * backend without touching consumers.
 */
export class MemoryRegistry extends Service {
  static Config: z<Config> = z.object({
    provider: z.string(),
  })

  private readonly providers = new Map<string, MemoryProvider>()
  private readonly configuredProviderId: string | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'memory')
    this.configuredProviderId = config.provider
  }

  /**
   * Register a borrowed same-process provider. Duplicate names throw.
   * Fiber disposal unregisters the provider.
   * @param provider - the provider; its `name` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerProvider(provider: MemoryProvider): () => void {
    const providers = this.providers
    if (providers.has(provider.name)) {
      throw new Error(`a memory provider named "${provider.name}" is already registered`)
    }
    const dispose = this.ctx.effect(function* () {
      providers.set(provider.name, provider)
      yield () => {
        providers.delete(provider.name)
      }
    }, 'memory.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Persist one fact through the selected provider and emit `memory/changed`
   * after the commit. Blank or whitespace-only text is rejected here, in the
   * operation that owns fact semantics, so every provider and consumer shares
   * one rule.
   * @param input - the text, optional tags, and storage scope to persist.
   * @returns the committed fact, including the provider-minted id.
   */
  async remember(input: RememberInput): Promise<MemoryFact> {
    if (input.text.trim().length === 0) {
      throw new Error('memory: fact text must not be blank')
    }
    const provider = this.resolveProvider()
    const fact = await provider.remember(input)
    this.emitChanged('remember', provider.name, fact.id)
    return fact
  }

  /**
   * Query stored facts through the selected provider. Matching semantics are
   * the provider's; the options narrow by scope and tag conjunction before
   * the backend matches.
   * @param query - free-form query text.
   * @param options - scope and tag-conjunction narrowing.
   * @returns the matching facts.
   */
  async recall(query: string, options: RecallOptions = {}): Promise<readonly MemoryFact[]> {
    return await this.resolveProvider().recall(query, options)
  }

  /**
   * Delete one fact through the selected provider. An unknown id is a
   * definite `false`; storage faults propagate as themselves.
   * @param id - the fact to delete.
   * @returns whether a stored fact was removed.
   */
  async forget(id: MemoryFactId): Promise<boolean> {
    const provider = this.resolveProvider()
    const removed = await provider.forget(id)
    if (removed) this.emitChanged('forget', provider.name, id)
    return removed
  }

  /**
   * Resolve the serving provider at call time: a configured id must be
   * registered; otherwise exactly one registered provider auto-selects.
   * Zero or several providers without configuration fail loud instead of
   * depending on registration order.
   */
  private resolveProvider(): MemoryProvider {
    if (this.configuredProviderId !== undefined) {
      const configured = this.providers.get(this.configuredProviderId)
      if (configured === undefined) {
        throw new Error(`memory: configured provider "${this.configuredProviderId}" is not registered`)
      }
      return configured
    }
    if (this.providers.size === 1) {
      const sole = [...this.providers.values()][0]
      if (sole !== undefined) return sole
    }
    if (this.providers.size === 0) {
      throw new Error('memory: no memory provider is registered; mount one, e.g. @buckeyestudio/toh-memory-local')
    }
    const names = [...this.providers.keys()].sort().join(', ')
    throw new Error(`memory: several providers are registered (${names}); configure which one serves ctx.memory`)
  }

  /** Emit one committed-mutation event, containing listener failures to the notification path. */
  private emitChanged(operation: MemoryChanged['operation'], provider: string, factId: MemoryFactId): void {
    try {
      this.ctx.emit('memory/changed', { operation, provider, factId })
    } catch (error) {
      // Swallows synchronous observer exceptions only: emit dispatches
      // notification, not a transaction participant — the commit point has
      // passed, so containment (with a log) is the only correct outcome.
      this.ctx.logger.warn(`memory: memory/changed listener failed: ${String(error)}`)
    }
  }
}

export default MemoryRegistry
