/**
 * `LocalMemoryProvider`: the storage-domain-backed implementation of the
 * `@buckeyestudio/toh-memory` seam. Persists facts as rows of the `memory`
 * domain over whatever backend the deployment routed to `ctx.storageDomain`
 * (JSON files with the shipped `storage-json` backend), and recalls through a
 * keyword-subset conjunction narrowed by scope and tags.
 *
 * @module @buckeyestudio/toh-memory-local
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@buckeyestudio/cordis'
import z from '@buckeyestudio/schemastery'
import { MemoryFactId } from '@buckeyestudio/toh-memory'
import type { MemoryFact, MemoryProvider, RecallOptions, RememberInput } from '@buckeyestudio/toh-memory'
import { matchesRow, queryTokens } from './match.ts'
import { memoryDomainSpec, rowToFact } from './spec.ts'
import type { MemoryRow } from './spec.ts'

export { memoryDomainSpec, rowToFact } from './spec.ts'
export type { MemoryRow } from './spec.ts'
export { matchesRow, queryTokens } from './match.ts'

/** Provider name in the `ctx.memory` registry. */
export const MEMORY_LOCAL_PROVIDER = 'local'

/** Cordis plugin name. */
export const name = 'memory-local'
/** The registry seam and the storage hub's domain form must exist first. */
export const inject = ['memory', 'storageDomain']

/** Plugin config (none today; domain routing belongs to `ctx.storageDomain`). */
export interface Config {}

/** Config schema. */
export const Config: z<Config> = z.object({})

/**
 * Mount the local memory provider. Opening the domain waits for the routed
 * storage backend; the provider registers into `ctx.memory`, and fiber
 * disposal unregisters it and closes the domain.
 * @param ctx - Cordis context carrying `memory` and `storageDomain`.
 * @param _config - Validated plugin config (empty).
 */
export async function apply(ctx: Context, _config: Config = {}): Promise<void> {
  const domain = await ctx.storageDomain.open(memoryDomainSpec)
  ctx.effect(() => () => domain.close(), 'memory-local.domainClose')
  const table = domain.table('facts')

  const provider: MemoryProvider = {
    name: MEMORY_LOCAL_PROVIDER,
    async remember(input: RememberInput): Promise<MemoryFact> {
      const fact: MemoryFact = {
        id: MemoryFactId(randomUUID()),
        text: input.text,
        tags: [...input.tags ?? []],
        scope: input.scope,
        createdAt: Date.now(),
      }
      await table.put(fact.id, factToRow(fact))
      return fact
    },
    recall(query: string, options: RecallOptions = {}): Promise<readonly MemoryFact[]> {
      const tokens = queryTokens(query)
      const matches: MemoryFact[] = []
      for (const [id, row] of table.entries()) {
        if (!matchesRow(row, tokens, options)) continue
        matches.push(rowToFact(id, row))
      }
      return Promise.resolve(matches.sort(compareNewestFirst))
    },
    async forget(id: MemoryFactId): Promise<boolean> {
      return await table.delete(id)
    },
  }
  ctx.memory.registerProvider(provider)
}

/** Copy one fact into its durable row shape. */
function factToRow(fact: MemoryFact): MemoryRow {
  return {
    scope: fact.scope,
    text: fact.text,
    tags: [...fact.tags],
    createdAt: fact.createdAt,
  }
}

/** Newest first, then id, so recall order is total and stable. */
function compareNewestFirst(left: MemoryFact, right: MemoryFact): number {
  return right.createdAt - left.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
}
