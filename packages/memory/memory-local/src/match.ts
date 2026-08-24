/**
 * Keyword matching for the local memory provider: whitespace-separated,
 * case-insensitive substring conjunction over the stored text, narrowed by
 * scope equality and a tag conjunction. Pure and provider-independent so the
 * recall semantics are unit-testable without storage.
 * @module @buckeyestudio/toh-memory-local/src/match
 */

import type { RecallOptions } from '@buckeyestudio/toh-memory'
import type { MemoryRow } from './spec.ts'

/**
 * Tokenize one query into lowercase keywords. An empty query matches every
 * (optionally narrowed) fact.
 * @param query - free-form query text.
 * @returns the lowercase keywords, in first-seen order.
 */
export function queryTokens(query: string): string[] {
  const tokens: string[] = []
  for (const token of query.toLowerCase().split(/\s+/)) {
    if (token.length > 0 && !tokens.includes(token)) tokens.push(token)
  }
  return tokens
}

/**
 * Whether one row satisfies the query and narrowing options.
 * @param row - durable row to test.
 * @param tokens - lowercase keywords from {@link queryTokens}; every token must be a substring.
 * @param options - scope and tag-conjunction narrowing.
 * @returns whether the row is a match.
 */
export function matchesRow(row: MemoryRow, tokens: readonly string[], options: RecallOptions): boolean {
  if (row.scope !== options.scope) return false
  for (const tag of options.tags ?? []) {
    if (!row.tags.includes(tag)) return false
  }
  const text = row.text.toLowerCase()
  return tokens.every(token => text.includes(token))
}
