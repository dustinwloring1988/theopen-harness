/**
 * Tests for the memory Service Definition: provider registration and
 * disposal, execution-time selection, blank-input rejection, and the
 * `memory/changed` emissions around committed mutations. Storage behavior is
 * the implementation's concern (`@buckeyestudio/toh-memory-local`).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@buckeyestudio/cordis'
import MemoryRegistry, { MemoryFactId } from '@buckeyestudio/toh-memory'
import type { MemoryChanged, MemoryFact, MemoryProvider } from '@buckeyestudio/toh-memory'

/** Deterministic fact minted by the stub providers. */
function fact(id: string): MemoryFact {
  return { id: MemoryFactId(id), text: `fact ${id}`, tags: [], scope: 'scope', createdAt: 1 }
}

/** Provider that records which calls it received and answers from its name. */
function stubProvider(name: string, calls: string[]): MemoryProvider {
  return {
    name,
    async remember(input) {
      calls.push(`${name}:remember`)
      return fact(`${name}-${input.text}`)
    },
    async recall(query) {
      calls.push(`${name}:recall`)
      return [fact(`${name}-${query}`)]
    },
    async forget(input) {
      calls.push(`${name}:forget`)
      return input.scope === 'scope' && !input.id.includes('missing')
    },
  }
}

/** Host plugin whose only job is registering one provider, so disposal is observable. */
function providerHost(name: string, calls: string[]): { name: string; inject: string[]; apply(ctx: Context): void } {
  return {
    name: `host-${name}`,
    inject: ['memory'],
    apply(hostCtx: Context): void {
      hostCtx.memory.registerProvider(stubProvider(name, calls))
    },
  }
}

async function listen(ctx: Context): Promise<MemoryChanged[]> {
  const events: MemoryChanged[] = []
  ctx.on('memory/changed', (change) => { events.push(change) })
  return events
}

describe('memory registry', () => {
  it('routes operations to the sole registered provider', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryRegistry)
    const calls: string[] = []
    ctx.memory.registerProvider(stubProvider('only', calls))
    await expect(ctx.memory.remember({ text: 'hello', scope: 'scope' })).resolves.toMatchObject({ id: 'only-hello' })
    await expect(ctx.memory.recall('hello', { scope: 'scope' })).resolves.toHaveLength(1)
    await expect(ctx.memory.forget({ id: MemoryFactId('x'), scope: 'scope' })).resolves.toBe(true)
    expect(calls).toEqual(['only:remember', 'only:recall', 'only:forget'])
  })

  it('rejects a blank workspace scope before any provider runs', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryRegistry)
    const calls: string[] = []
    ctx.memory.registerProvider(stubProvider('store', calls))
    await expect(ctx.memory.recall('hello', { scope: '   ' })).rejects.toThrow(/recall requires a non-empty workspace scope/)
    await expect(ctx.memory.forget({ id: MemoryFactId('x'), scope: '' })).rejects.toThrow(/forget requires a non-empty workspace scope/)
    expect(calls).toEqual([])
  })

  it('reports a forget addressed under another workspace scope as absent without deleting', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryRegistry)
    const calls: string[] = []
    const provider = stubProvider('store', calls)
    // The stub only deletes inside `scope`; prove the seam forwards the caller's scope verbatim.
    ctx.memory.registerProvider(provider)
    const stored = await ctx.memory.remember({ text: 'hello', scope: 'scope' })
    await expect(ctx.memory.forget({ id: stored.id, scope: '/other-workspace' })).resolves.toBe(false)
    await expect(ctx.memory.forget({ id: stored.id, scope: 'scope' })).resolves.toBe(true)
    expect(calls).toEqual(['store:remember', 'store:forget', 'store:forget'])
  })

  it('rejects duplicate provider names', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryRegistry)
    ctx.memory.registerProvider(stubProvider('dup', []))
    expect(() => ctx.memory.registerProvider(stubProvider('dup', []))).toThrow(/already registered/)
  })

  it('unregisters the provider when the registering fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryRegistry)
    const fiber = await ctx.plugin(providerHost('ephemeral', []))
    await expect(ctx.memory.recall('anything', { scope: 'scope' })).resolves.toHaveLength(1)
    await fiber.dispose()
    await expect(ctx.memory.recall('anything', { scope: 'scope' })).rejects.toThrow(/no memory provider is registered/)
  })

  it('fails loud with no provider registered', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryRegistry)
    await expect(ctx.memory.recall('anything', { scope: 'scope' })).rejects.toThrow(/no memory provider is registered/)
  })

  it('auto-selects exactly one registered provider and fails loud on several without configuration', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryRegistry)
    const calls: string[] = []
    ctx.memory.registerProvider(stubProvider('first', calls))
    await expect(ctx.memory.recall('query', { scope: 'scope' })).resolves.toEqual([expect.objectContaining({ id: 'first-query' })])
    ctx.memory.registerProvider(stubProvider('second', calls))
    await expect(ctx.memory.recall('query', { scope: 'scope' })).rejects.toThrow(/several providers are registered \(first, second\)/)
  })

  it('routes to the configured provider when one is pinned', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryRegistry, { provider: 'second' })
    const calls: string[] = []
    ctx.memory.registerProvider(stubProvider('first', calls))
    ctx.memory.registerProvider(stubProvider('second', calls))
    await expect(ctx.memory.recall('query', { scope: 'scope' })).resolves.toEqual([expect.objectContaining({ id: 'second-query' })])
    expect(calls).toEqual(['second:recall'])
  })

  it('rejects a configured provider that is not registered', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryRegistry, { provider: 'ghost' })
    ctx.memory.registerProvider(stubProvider('real', []))
    await expect(ctx.memory.remember({ text: 'hello', scope: 'scope' })).rejects.toThrow(/configured provider "ghost" is not registered/)
  })

  it('rejects blank fact text before any provider runs', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryRegistry)
    const calls: string[] = []
    ctx.memory.registerProvider(stubProvider('store', calls))
    await expect(ctx.memory.remember({ text: '   ', scope: 'scope' })).rejects.toThrow(/must not be blank/)
    expect(calls).toEqual([])
  })

  it('emits memory/changed after a committed remember and a real forget, and never for a miss', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryRegistry)
    ctx.memory.registerProvider(stubProvider('store', []))
    const events = await listen(ctx)

    const stored = await ctx.memory.remember({ text: 'hello', tags: ['a'], scope: 'scope' })
    expect(events).toEqual([{ operation: 'remember', provider: 'store', factId: stored.id }])

    await expect(ctx.memory.forget({ id: MemoryFactId('the-missing'), scope: 'scope' })).resolves.toBe(false)
    expect(events).toHaveLength(1)

    await expect(ctx.memory.forget({ id: stored.id, scope: 'scope' })).resolves.toBe(true)
    expect(events).toEqual([
      { operation: 'remember', provider: 'store', factId: stored.id },
      { operation: 'forget', provider: 'store', factId: stored.id },
    ])
  })

  it('contains a throwing memory/changed listener and keeps the mutation result', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryRegistry)
    ctx.on('memory/changed', () => { throw new Error('observer boom') })
    ctx.memory.registerProvider(stubProvider('store', []))
    await expect(ctx.memory.remember({ text: 'hello', scope: 'scope' })).resolves.toMatchObject({ id: 'store-hello' })
    await expect(ctx.memory.forget({ id: MemoryFactId('store-hello'), scope: 'scope' })).resolves.toBe(true)
  })
})
