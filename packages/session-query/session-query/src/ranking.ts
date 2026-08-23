/**
 * Single-source ordering for session full-text search results.
 *
 * The ordered key lists here define the search rank contract: the SQLite
 * backend emits its ORDER BY fragments from them and browser-fixture
 * consumers derive their comparator from them, so the two implementations
 * cannot drift. The module imports nothing and keeps no state, which is what
 * lets both a Node backend and a bundled browser fixture inline it safely.
 *
 * @module @buckeyestudio/toh-session-query/ranking
 */

/** Sort direction of one rank key. */
export type SessionSearchRankDirection = 'ASC' | 'DESC'

/**
 * The ranked fields every search candidate exposes. All values are total:
 * backends materialize each field as a non-null number or string before
 * ranking.
 */
export interface SessionSearchRankCandidate {
  /** Matched phrase occurrences inside one document. */
  matchCount: number
  /** Document length in Unicode code points. */
  documentLength: number
  /** Event time as a comparable number. */
  time: number
  /** Owning session id. */
  sessionId: string
  /** Sequence of the event inside its session log. */
  seq: number
}

/** One ordered rank key: a candidate field, its SQL column, and its direction. */
export interface SessionSearchRankKey {
  /** Column name in the SQLite search projection. */
  readonly column: string
  /** The {@link SessionSearchRankCandidate} field carrying the same value. */
  readonly field: keyof SessionSearchRankCandidate
  /** Sort direction applied to this key. */
  readonly direction: SessionSearchRankDirection
}

/**
 * Cross-session result order: strongest match first, then shorter document,
 * newer event, ascending session id, and descending sequence as final
 * tiebreaks.
 */
export const SESSION_SEARCH_RANK_KEYS: readonly SessionSearchRankKey[] = [
  { column: 'match_count', field: 'matchCount', direction: 'DESC' },
  { column: 'document_length', field: 'documentLength', direction: 'ASC' },
  { column: 'time', field: 'time', direction: 'DESC' },
  { column: 'session_id', field: 'sessionId', direction: 'ASC' },
  { column: 'seq', field: 'seq', direction: 'DESC' },
]

/**
 * Within-one-session order, derived by dropping the constant session-id key
 * from {@link SESSION_SEARCH_RANK_KEYS}. The events search scope and the
 * per-session best-event window use this list; any two rows sharing a session
 * id must order identically under both lists, which this derivation
 * guarantees structurally.
 */
export const SESSION_SEARCH_EVENT_RANK_KEYS: readonly SessionSearchRankKey[] =
  SESSION_SEARCH_RANK_KEYS.filter(key => key.field !== 'sessionId')

/**
 * Render ordered rank keys as the body of a SQL ORDER BY clause.
 * @param keys - ordered rank keys; emission preserves the list order.
 * @returns SQL text such as `match_count DESC, seq DESC`, without the ORDER BY keywords.
 */
export function sessionSearchRankOrderSql(keys: readonly SessionSearchRankKey[]): string {
  return keys.map(key => `${key.column} ${key.direction}`).join(', ')
}

/**
 * Compare two candidates by the ordered rank keys, returning the first
 * differing key's directed comparison. Strings compare in JavaScript
 * relational (UTF-16 code unit) order, the same order SQLite BINARY
 * collation gives the ASCII ids backends mint.
 * @param a - left candidate.
 * @param b - right candidate.
 * @param keys - ordered rank keys to apply.
 * @returns a negative number when `a` ranks before `b`, a positive number when after, and zero when every key ties.
 */
export function compareSessionSearchCandidates(
  a: SessionSearchRankCandidate,
  b: SessionSearchRankCandidate,
  keys: readonly SessionSearchRankKey[],
): number {
  for (const key of keys) {
    const left = a[key.field]
    const right = b[key.field]
    if (left === right) continue
    const ordered = left < right ? -1 : 1
    return key.direction === 'ASC' ? ordered : -ordered
  }
  return 0
}
