/**
 * Rank-ordering conformance between the real SQLite backend and the shared
 * fixture-side comparator: one fixed corpus exercises every tiebreak level
 * (match count, document length, time, session id, sequence), including a
 * non-ASCII session-id pair whose UTF-16 code-unit order differs from the
 * UTF-8 byte order both backends must share, and both scopes must produce
 * the exact ordering `compareSessionSearchCandidates` derives from the
 * exported rank-key definitions. Each scope fetches pages smaller than its
 * result set and continues through the returned cursors, proving the decoded
 * offsets preserve the ordering without duplicates or omissions.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@buckeyestudio/cordis'
import { createUserMessage } from '@buckeyestudio/toh-llm'
import SessionStore, {
  SessionId,
  type SessionEvent,
} from '@buckeyestudio/toh-session'
import SqliteSessionQueryEngine from '@buckeyestudio/toh-session-query-sqlite'
import { type SessionSearchCursor } from '@buckeyestudio/toh-session-query'
import {
  compareSessionSearchCandidates,
  SESSION_SEARCH_EVENT_RANK_KEYS,
  SESSION_SEARCH_RANK_KEYS,
  type SessionSearchRankCandidate,
} from '@buckeyestudio/toh-session-query/ranking'

interface CorpusDoc {
  text: string
  time: number
}

/** One seeded live session: each doc becomes one user/message event in seq order. */
const CORPUS: readonly { id: string; docs: readonly CorpusDoc[] }[] = [
  { id: 'conf-top', docs: [{ text: 'needle needle twice', time: 10 }] },
  { id: 'conf-short', docs: [{ text: 'needle x', time: 10 }] },
  {
    id: 'conf-seqs',
    docs: [
      { text: 'needle alpha', time: 70 },
      { text: 'needle gamma', time: 70 },
    ],
  },
  { id: 'conf-new', docs: [{ text: 'needle aaa bbb', time: 300 }] },
  { id: 'conf-old', docs: [{ text: 'needle ccc ddd', time: 100 }] },
  { id: 'conf-a', docs: [{ text: 'needle same tail', time: 50 }] },
  { id: 'conf-b', docs: [{ text: 'needle same tail', time: 50 }] },
  { id: '\u{E000}-tie', docs: [{ text: 'needle tie', time: 42 }] },
  { id: '\u{10000}-tie', docs: [{ text: 'needle tie', time: 42 }] },
  { id: 'conf-long', docs: [{ text: 'needle xxxxxxxxxxxx', time: 10 }] },
]

function docEvent(doc: CorpusDoc, seq: number): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: doc.time,
    data: createUserMessage({
      content: [{ type: 'text', text: doc.text }],
      source: { kind: 'user' },
    }),
    surfaceOp: 'append',
  }
}

async function seededContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:' })
  for (const entry of CORPUS) {
    ctx.sessions.create(SessionId(entry.id), {
      seed: entry.docs.map(docEvent),
      meta: { createdAt: 1 },
    })
  }
  return ctx
}

/** Candidate facts recomputed from the corpus alone, without touching the backend. */
function corpusCandidates(): SessionSearchRankCandidate[] {
  return CORPUS.flatMap(entry => entry.docs.map((doc, seq) => ({
    sessionId: entry.id,
    seq,
    time: doc.time,
    matchCount: doc.text.split(/\s+/u).filter(token => token === 'needle').length,
    documentLength: Array.from(doc.text).length,
  })))
}

describe('SQLite search ordering conforms to the shared rank definition', () => {
  it('returns session pages in the shared comparator order across cursor continuation', async () => {
    const ctx = await seededContext()

    const expectedBestPerSession = CORPUS.map((entry) => {
      const docs = corpusCandidates().filter(candidate => candidate.sessionId === entry.id)
        .sort((a, b) => compareSessionSearchCandidates(a, b, SESSION_SEARCH_EVENT_RANK_KEYS))
      const best = docs[0]
      if (best === undefined) throw new Error(`corpus session "${entry.id}" has no documents`)
      return best
    }).sort((a, b) => compareSessionSearchCandidates(a, b, SESSION_SEARCH_RANK_KEYS))
      .map(best => `${best.sessionId}#${best.seq}`)

    const actual: string[] = []
    let cursor: SessionSearchCursor | undefined
    let pages = 0
    do {
      const page = await ctx.sessionQuery.searchSessions({
        query: 'needle',
        limit: 3,
        ...cursor === undefined ? {} : { cursor },
      })
      actual.push(...page.items.map(hit => `${hit.header.id}#${hit.bestMatch.seq}`))
      cursor = page.nextCursor
      pages += 1
    } while (cursor !== undefined)
    expect(pages).toBeGreaterThan(1)

    expect(actual).toEqual([
      'conf-top#0',
      'conf-short#0',
      '\u{E000}-tie#0',
      '\u{10000}-tie#0',
      'conf-seqs#1',
      'conf-new#0',
      'conf-old#0',
      'conf-a#0',
      'conf-b#0',
      'conf-long#0',
    ])
    expect(actual).toEqual(expectedBestPerSession)
  })

  it('returns event pages across cursor continuation in the shared comparator order', async () => {
    const ctx = await seededContext()
    const actual: number[] = []
    let cursor: SessionSearchCursor | undefined
    let pages = 0
    do {
      const page = await ctx.sessionQuery.searchEvents({
        sessionId: SessionId('conf-seqs'),
        query: 'needle',
        limit: 1,
        ...cursor === undefined ? {} : { cursor },
      })
      actual.push(...page.items.map(hit => hit.seq))
      cursor = page.nextCursor
      pages += 1
    } while (cursor !== undefined)
    expect(pages).toBe(2)
    expect(actual).toEqual([1, 0])

    const expected = corpusCandidates()
      .filter(candidate => candidate.sessionId === 'conf-seqs')
      .sort((a, b) => compareSessionSearchCandidates(a, b, SESSION_SEARCH_EVENT_RANK_KEYS))
      .map(candidate => candidate.seq)
    expect(actual).toEqual(expected)
  })
})
