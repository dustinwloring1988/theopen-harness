# Agent Note: storage-json serializes overlapping publishes on one per-unit chain

Status: implemented

English | [中文](2026-08-23-storage-json-publish-chain.zh.md)

## Problem

Each write primitive in the JSON storage unit mutated memory synchronously and immediately staged its own whole-file snapshot through an independent temp-write + rename sequence (`packages/storage/storage-json/src/unit.ts`). Two overlapping un-awaited calls therefore raced two renames against one target path, and whichever rename landed last won — possibly the stale snapshot. A record whose write had already resolved could silently vanish from disk after reload; `close()` drained the stragglers without repairing the divergence. Reachability through `storage-domain` was narrow because its per-domain chain serializes writes ([domain KV storage design](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md)), but direct `backend.kv.open()` consumers are sanctioned by the KV contract and would hit it.

## Decision

The unit chains every publish onto one internal promise tail and snapshots state when the slot runs, so the final rename always carries the newest acknowledged state. Rollback of a failed publish runs inside its failing slot, so the next slot never snapshots a rejected mutation. `close()` drains the chain tail instead of tracking individual in-flight writes. The public `KvUnit` API is unchanged, and the shared contract text now permits a unit to serialize overlapping publications while ordering across separately awaited calls stays the caller's concern.

## Alternatives considered

**Version/generation check before each rename.** Rejected: it needs an atomic compare-and-swap publish primitive, which Windows' `MoveFileExW` replacement rename does not offer, and retry loops reintroduce the interleaving they guard against.

**Leaving serialization entirely to callers.** Rejected: the unit previously delegated ordering to the caller, but the failure mode is silent data loss for sanctioned direct consumers, and the fix costs one promise chain with no API change.

**Snapshotting at enqueue time instead of slot time.** Rejected: correct under the chain but wasteful — each overlap republishes an already-stale snapshot; slot-time snapshotting makes every queued write carry current state.

## Consequences

- Concurrent writers to one unit proceed one publication at a time; throughput matches the whole-file model's single-writer stance rather than racing independent temp files.
- A failed publish can no longer leak its rolled-back mutation into the next successful publish.
- Regression coverage drives overlapping un-awaited `putRecord` calls and asserts the medium ends with the newest payload and both sibling records, alongside sequential-order coverage.

## Testing

`pnpm run test --filter @buckeyestudio/toh-storage-json` covers the overlapping-publish regressions and the shared KV backend contract suite.
