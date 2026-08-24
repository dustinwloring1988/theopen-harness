/**
 * Vocabulary of the cross-session memory capability seam (`ctx.memory`): one
 * stored fact, its branded id, the provider contract that owns storage and
 * retrieval semantics, and the change-event payload.
 * @module @buckeyestudio/toh-memory/src/types
 */

import type { Branded } from '@buckeyestudio/toh-brand'

/**
 * Opaque durable identifier of one stored fact. Providers mint it at remember
 * time and consumers treat it as opaque; it is the `forget` handle.
 */
export type MemoryFactId = Branded<'MemoryFactId'>

/**
 * Brand a raw id string as a {@link MemoryFactId}.
 * @param id - Raw fact id string.
 * @returns the same string, branded at compile time.
 */
export function MemoryFactId(id: string): MemoryFactId {
  return id as MemoryFactId
}

/** One durably stored fact. */
export interface MemoryFact {
  /** Provider-minted durable identifier. */
  readonly id: MemoryFactId
  /** The stored statement, verbatim. */
  readonly text: string
  /** Caller-supplied routing labels, verbatim and order-preserving; possibly empty. */
  readonly tags: readonly string[]
  /**
   * Storage scope the fact belongs to. The local provider uses the workspace
   * canonical cwd; recall narrows by this value through {@link RecallOptions}.
   */
  readonly scope: string
  /** Creation time as epoch milliseconds. */
  readonly createdAt: number
}

/** Input to `ctx.memory.remember()`. */
export interface RememberInput {
  /** The statement to store; blank text is rejected by the registry. */
  readonly text: string
  /** Routing labels; omission stores an empty tag set. */
  readonly tags?: readonly string[] | undefined
  /** Storage scope, typically the workspace canonical cwd. Required: cross-session facts are workspace-scoped by design. */
  readonly scope: string
}

/** Narrowing options for `ctx.memory.recall()`. Omitted fields match everything. */
export interface RecallOptions {
  /** Restrict matches to facts stored under this scope. */
  readonly scope?: string | undefined
  /** Restrict matches to facts carrying every listed tag. */
  readonly tags?: readonly string[] | undefined
}

/**
 * One backend for the memory seam. A provider owns WHERE facts live and HOW
 * `recall(query)` matches them (keyword intersection today, embeddings later)
 * under the seam's minimum semantics: `remember` persists the full text
 * verbatim and returns a fact minted by the provider; `recall` narrows by
 * scope and tag conjunction before applying its own matching; `forget`
 * removes exactly the addressed fact and reports whether it existed.
 */
export interface MemoryProvider {
  /** Unique provider name in the `ctx.memory` registry. */
  readonly name: string
  /**
   * Persist one fact and return the stored snapshot, including the
   * provider-minted {@link MemoryFactId}.
   * @param input - the text, optional tags, and storage scope to persist.
   * @returns the committed fact.
   */
  readonly remember: (input: RememberInput) => Promise<MemoryFact>
  /**
   * Return matching facts, newest first within the backend's own ordering.
   * @param query - free-form query text interpreted by the provider's matcher.
   * @param options - scope and tag-conjunction narrowing.
   * @returns the matching facts.
   */
  readonly recall: (query: string, options: RecallOptions) => Promise<readonly MemoryFact[]>
  /**
   * Delete one fact.
   * @param id - the fact to delete.
   * @returns whether a stored fact was removed.
   */
  readonly forget: (id: MemoryFactId) => Promise<boolean>
}

/** Payload of one committed memory mutation. */
export interface MemoryChanged {
  /** Which committed mutation happened. */
  readonly operation: 'remember' | 'forget'
  /** Name of the provider that owns the mutated store. */
  readonly provider: string
  /** The created or deleted fact id. */
  readonly factId: MemoryFactId
}
