import { describe, expect, it } from 'vitest'
import {
  compareSessionSearchCandidates,
  SESSION_SEARCH_EVENT_RANK_KEYS,
  SESSION_SEARCH_RANK_KEYS,
  sessionSearchRankOrderSql,
  type SessionSearchRankCandidate,
} from '../src/ranking.ts'

function candidate(overrides: Partial<SessionSearchRankCandidate>): SessionSearchRankCandidate {
  return {
    matchCount: 1,
    documentLength: 10,
    time: 100,
    sessionId: 'session-a',
    seq: 0,
    ...overrides,
  }
}

describe('session-search rank keys', () => {
  it('emits the contract ORDER BY body for both scopes', () => {
    expect(sessionSearchRankOrderSql(SESSION_SEARCH_RANK_KEYS))
      .toBe('match_count DESC, document_length ASC, time DESC, session_id ASC, seq DESC')
    expect(sessionSearchRankOrderSql(SESSION_SEARCH_EVENT_RANK_KEYS))
      .toBe('match_count DESC, document_length ASC, time DESC, seq DESC')
  })

  it('derives the event keys by dropping only the constant session id', () => {
    expect(SESSION_SEARCH_EVENT_RANK_KEYS)
      .toEqual(SESSION_SEARCH_RANK_KEYS.filter(key => key.field !== 'sessionId'))
    expect(SESSION_SEARCH_EVENT_RANK_KEYS.at(-1)?.field).toBe('seq')
  })
})

describe('compareSessionSearchCandidates', () => {
  it('ranks stronger matches first regardless of later keys', () => {
    const strong = candidate({ matchCount: 3 })
    const weak = candidate({ matchCount: 2, documentLength: 0, time: 0, sessionId: 'zzz' })
    expect(compareSessionSearchCandidates(strong, weak, SESSION_SEARCH_RANK_KEYS)).toBeLessThan(0)
    expect(compareSessionSearchCandidates(weak, strong, SESSION_SEARCH_RANK_KEYS)).toBeGreaterThan(0)
  })

  it('prefers shorter documents among equal match counts', () => {
    const short = candidate({ documentLength: 4 })
    const long = candidate({ documentLength: 5, time: 999, sessionId: 'aaa' })
    expect(compareSessionSearchCandidates(short, long, SESSION_SEARCH_RANK_KEYS)).toBeLessThan(0)
    expect(compareSessionSearchCandidates(long, short, SESSION_SEARCH_RANK_KEYS)).toBeGreaterThan(0)
  })

  it('prefers newer events among equal counts and lengths', () => {
    const newer = candidate({ time: 201 })
    const older = candidate({ time: 200, sessionId: 'aaa' })
    expect(compareSessionSearchCandidates(newer, older, SESSION_SEARCH_RANK_KEYS)).toBeLessThan(0)
    expect(compareSessionSearchCandidates(older, newer, SESSION_SEARCH_RANK_KEYS)).toBeGreaterThan(0)
  })

  it('breaks full ties by ascending session id', () => {
    const first = candidate({ sessionId: 'session-a' })
    const second = candidate({ sessionId: 'session-b', seq: 99 })
    expect(compareSessionSearchCandidates(first, second, SESSION_SEARCH_RANK_KEYS)).toBeLessThan(0)
    expect(compareSessionSearchCandidates(second, first, SESSION_SEARCH_RANK_KEYS)).toBeGreaterThan(0)
  })

  it('orders tied string keys by UTF-8 bytes, matching SQLite BINARY collation', () => {
    // UTF-16 code-unit order would rank the U+10000 surrogate pair (0xD800...)
    // before U+E000; UTF-8 byte order ranks U+E000 (0xEE...) first.
    const privateUse = candidate({ sessionId: '\u{E000}-tie' })
    const astral = candidate({ sessionId: '\u{10000}-tie' })
    expect(compareSessionSearchCandidates(privateUse, astral, SESSION_SEARCH_RANK_KEYS)).toBeLessThan(0)
    expect(compareSessionSearchCandidates(astral, privateUse, SESSION_SEARCH_RANK_KEYS)).toBeGreaterThan(0)
    expect(compareSessionSearchCandidates(privateUse, candidate({ sessionId: '\u{E000}-tie' }), SESSION_SEARCH_RANK_KEYS)).toBe(0)
  })

  it('breaks same-session ties by descending sequence', () => {
    const later = candidate({ seq: 8 })
    const earlier = candidate({ seq: 7 })
    expect(compareSessionSearchCandidates(later, earlier, SESSION_SEARCH_RANK_KEYS)).toBeLessThan(0)
    expect(compareSessionSearchCandidates(earlier, later, SESSION_SEARCH_RANK_KEYS)).toBeGreaterThan(0)
  })

  it('reports zero when every key ties and orders identically under both lists within one session', () => {
    const a = candidate({})
    const b = candidate({})
    expect(compareSessionSearchCandidates(a, b, SESSION_SEARCH_RANK_KEYS)).toBe(0)
    expect(compareSessionSearchCandidates(a, b, SESSION_SEARCH_EVENT_RANK_KEYS)).toBe(0)
    const shuffled = [candidate({ seq: 2 }), candidate({ seq: 0 }), candidate({ seq: 1 })]
    expect([...shuffled].sort((x, y) => compareSessionSearchCandidates(x, y, SESSION_SEARCH_RANK_KEYS)))
      .toEqual([...shuffled].sort((x, y) => compareSessionSearchCandidates(x, y, SESSION_SEARCH_EVENT_RANK_KEYS)))
  })
})
