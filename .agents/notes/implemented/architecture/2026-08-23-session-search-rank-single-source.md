# Agent Note: Single-source session-search rank ordering

Status: implemented

English | [中文](2026-08-23-session-search-rank-single-source.zh.md)

## Problem

The session-search rank contract lived in two places synced only by a comment. The SQLite backend spelled the rank keys inside three SQL orderings — the per-session best-event window, the cross-session page order, and the events page order — and the browser development fixture hand-rolled `compareSearchCandidates` with the same five keys. The comment at each site said "update both together", but nothing failed when one side changed: the events orderings had already drifted structurally from the sessions ordering by omitting the session-id tiebreak, and no test compared the two implementations.

## Decision

[`@buckeyestudio/toh-session-query/ranking`](../../../../packages/session-query/session-query/src/ranking.ts) now owns the ordered rank-key definition. `SESSION_SEARCH_RANK_KEYS` states the cross-session order once as data (column name, candidate field, direction); `SESSION_SEARCH_EVENT_RANK_KEYS` is derived from it by dropping the session-id key, which is constant inside the events scope and the per-session window, so any two rows sharing a session id order identically under both lists by construction. `sessionSearchRankOrderSql()` emits the ORDER BY body and `compareSessionSearchCandidates()` compares candidates from the same list.

The SQLite backend interpolates emitted fragments into all three orderings, preserving the previous SQL byte for byte. The fixture sorts its per-session best with the event list and its cross-session results with the session list, replacing the hand-written comparator. Because the module imports nothing and holds no state, the client bundle purity preset admits exactly the `/ranking` subpath as an inline-safe wire layer while the rest of `toh-session-query` stays a rejected leak; `packages/client/connection` declares the package as peer plus dev. Placement follows the capability-seam layout: rank ordering is part of the search contract the Service Definition package owns, so both consumers import it without a new package or a dependency cycle.

## Alternatives considered

- **A new zero-dependency package** (`toh-session-query-ranking`). Lost: a subpath export on the existing Service Definition package provides the same import isolation and single home with none of the package-registration ceremony, and the seam already owns search result ordering.
- **Keep the mirror, pin it with a string test.** A test asserting the emitted ORDER BY text freezes the SQL spelling but leaves the comparator free to misimplement the same keys; two definitions remain.
- **Comment-only sync (status quo).** Rejected by the issue: comments had already failed to keep three SQL orderings and a JS comparator aligned.

## Consequences

- Drift between the SQL ordering and the fixture ordering can no longer happen through either implementation silently: both derive from one list, and changing the list changes both sides together.
- A conformance suite in `session-query-sqlite/tests/ranking-conformance.spec.ts` seeds a corpus exercising every tiebreak level through the real engine and asserts the returned pages equal the comparator-derived ordering; mutation-checking a locally flipped SQL direction made this suite fail before the flip was reverted.
- `packages/client/connection` gains a peer-plus-dev relationship to `@buckeyestudio/toh-session-query`; the generated module graph records the edge, and `scripts/client-bundle-purity.spec.ts` audits that only the ranking submodule may inline.

## Related

SQLite ownership and tokenizer decisions remain owned by the [implemented search note](../feature/2026-07-10-sqlite-session-query-provider.md).
