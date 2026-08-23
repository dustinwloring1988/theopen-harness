# Agent Note: storage-json serializes overlapping publishes on an in-unit chain

Status: implemented

English | [中文](2026-08-23-storage-json-publish-chain.zh.md)

## Problem

Every JSON KV write primitive mutated the authoritative in-memory map synchronously and then republished the whole file. Each publish serialized the current state into its own fresh temp file and renamed it over the target independently, so two overlapping un-awaited writes produced two independent snapshots racing for one rename destination: whichever rename landed last won, and that could be the stale snapshot. A record whose `putRecord` had already resolved could silently vanish from disk and stay gone after a restart — completion-order-wins, while `atomic.ts` asserted last-write-wins.

The domain layer's per-unit write chain ([domain KV storage](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md)) keeps domain operations sequential, so the race was narrow through that path, but direct `backend.kv.open(...)` consumers are sanctioned by the storage contract and hit it. `close()` drained in-flight writes without a fix-up publish, so divergence survived teardown.

## Decision

Each unit owns a publish chain: a settled promise tail that every publish appends to, where each link reads the full in-memory state when its slot runs rather than when the write is issued. Whole-file replacements land one at a time in call order, the last rename always carries the newest state, and once a write resolves, the medium holds every acknowledged write issued before it. A rejected link is swallowed on the tail only — the rejecting caller still observes its own error exactly once, memory rolls back as before, and the next queued slot serializes only after that rollback has run. `close()` awaits the same tail, so teardown drains held and queued publishes alike; after the drain the medium matches memory, because the last landed slot wrote the full state and any failed publish rolled back before its successor ran. The shared `KvUnit` contract now states this durability-overlap guarantee instead of denying in-unit serialization; logical ordering of what each call writes remains the caller's responsibility (clause 4 of the proposal's backend contract narrows accordingly — durability ordering moved in-unit, caller-owned logical ordering stayed).

## Testing

The JSON backend suite mocks the package's own atomic-write module with a pass-through seam that arms a one-shot hold on the next replacement. Two tests park the first publish mid-hold, issue a second overlapping un-awaited `putRecord`, and pin the chain: the file must still be absent after the second call is issued — under the old independent-snapshot publishes the second rename had already landed at that point — and after release both the final file and a re-opened medium must hold both records; the second test closes the unit while both writes are queued and asserts the drain leaves both on disk. The suite reproduces the loss deterministically when `publish()` reverts to independent per-call replacements.

## Alternatives considered

**Version-guard the rename.** Stamp each snapshot with a monotonic version and let a loser detect that it overwrote a newer file and republish. Rejected: it keeps concurrent whole-file replacements racing and adds a repair path whose interleavings are harder to pin than simply ordering the renames; serialization deletes the race instead of adjudicating it.

**Keep caller-owned ordering as the whole story.** Rejected: nothing structural prevents overlapping calls from sanctioned direct-KV consumers, so this left a silent data-loss window behind a documentation caveat — the reported bug itself.

## Consequences

Overlapping direct-KV writes can no longer discard an acknowledged record. Publishes now run strictly one replacement at a time, giving up concurrent temp-file preparation across overlapping calls — immaterial in practice, because the domain layer's per-unit chain already serialized them. Rollback-on-failed-publish semantics are unchanged for each caller. Cross-process writers stay unsynchronized (whole-file last-writer-wins); the README's known-limitation entry still says so.
