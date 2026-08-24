/**
 * Durable storage-domain declaration for the local memory provider: one
 * workspace-scoped fact table keyed by the branded fact id.
 * @module @buckeyestudio/toh-memory-local/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@buckeyestudio/toh-storage-domain'
import type { MemoryFact, MemoryFactId } from '@buckeyestudio/toh-memory'

/**
 * Durable shape of one stored fact. `text` is the verbatim statement;
 * `tags` is the caller-supplied label set (order-preserving, duplicate-free
 * by remember-time normalization); `scope` is the storage scope, the
 * canonical workspace cwd for the local provider; `createdAt` is epoch
 * milliseconds.
 */
export const memoryRowSchema = z.object({
  scope: z.string().min(1),
  text: z.string().refine(text => text.trim().length > 0, {
    message: 'stored memory text must contain a non-whitespace character',
  }),
  tags: z.array(z.string().min(1)),
  createdAt: z.number().int().nonnegative(),
})

/** Durable fact row inferred from {@link memoryRowSchema}. */
export type MemoryRow = z.infer<typeof memoryRowSchema>

/**
 * Project a durable row plus its key into the seam's {@link MemoryFact} view.
 * @param id - the durable row key.
 * @param row - the durable row.
 * @returns the fact as the seam publishes it.
 */
export function rowToFact(id: MemoryFactId, row: MemoryRow): MemoryFact {
  return {
    id,
    text: row.text,
    tags: [...row.tags],
    scope: row.scope,
    createdAt: row.createdAt,
  }
}

/**
 * The memory domain spec: one `facts` table keyed by the branded
 * {@link MemoryFactId}. The provider opens this through
 * `ctx.storageDomain.open`; the spec object is the single source of the
 * domain's identity, version, and schemas. No global singleton: the store has
 * no registry-wide state yet, and adding one later is a versioned migration.
 */
export const memoryDomainSpec = defineDomain({
  name: 'memory',
  version: 1,
  tables: {
    facts: domainTable<MemoryFactId, MemoryRow>(memoryRowSchema),
  },
})
