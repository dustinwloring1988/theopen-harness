# Agent Note: storage-sqlite composes as an opt-in Web storage overlay

Status: implemented

English | [中文](2026-08-23-storage-sqlite-opt-in-web-overlay.zh.md)

## Problem

`@buckeyestudio/toh-storage-sqlite` was fully implemented and contract-tested yet composed nowhere: no workspace manifest consumed it, the shipped Web composition routed every domain through `toh-storage-json`, and the runtime-closure manifests omitted it. Its own test suite was the only consumer, which hid the gap from knip while violating the packages rule that requires a current owner and need ([domain KV storage design](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) had already named its intended role: the route for high-churn or large domains).

## Decision

The backend composes as an opt-in example overlay instead of a shipped default:

- [`examples/web-storage-sqlite/cordis.yml`](../../../../examples/web-storage-sqlite/cordis.yml) inserts a `storage-sqlite` row (database at `$TOH_HOME/storages/workspace.sqlite3`) and patches `storage-domain` with `routes: { workspace: sqlite }`; run with `toh web --patch`. Only the `workspace` domain changes medium.
- The overlay resolves through `apps/cli`'s dependency surface (`@buckeyestudio/toh-storage-sqlite` joined its dependencies), the same resolution path as `web-schedule`.
- `apps/cli/tests/web-storage-sqlite-overlay.e2e.ts` boots the shipped Web composition plus the overlay keylessly and asserts both backends register side by side and workspace records land as durable rows in the routed database file.
- `apps/cli/tests/web-storage-sqlite-overlay.snapshot.ts` pins keyless assembled-app snapshots through the documented command: the composed profile tree's overlay-provenance rows (`storage-domain` routed to `sqlite`, the inserted `storage-sqlite` row), and a built-bin boot to readiness that materializes the routed database file under `$TOH_HOME/storages`.

The shipped default stays `json` everywhere: no bundle patch changed, so existing deployments boot identically.

## Alternatives considered

- **Parking under `packages/experimental/`** — rejected: the per-domain `routes` configuration made a real composition one config row away with zero code changes, so parking would have traded a working consumer for catalog churn across tsconfig aggregates and generated graphs.
- **Composing into the shipped web-app bundle** — rejected: no current production domain needs row-level point updates at scale, and product rules keep opt-ins out of shipped defaults.
- **A hygiene gate requiring every non-experimental plugin to appear in at least one bundle/example/runtime-closure manifest** — deferred as follow-up work; this PR closes the specific gap without the new gate.

## Consequences

- The backend has a current owner (the documented overlay) and a stated need (high-churn domains route here), satisfying the ownership rule without default-behavior risk.
- Switching an existing deployment to the overlay does not migrate prior JSON records; the pre-release stance rejects cross-medium migration, and the overlay README states this.
- knip still cannot see composition gaps like this one (a package's own tests count as consumers); the deferred hygiene-gate option above is where that class of gap gets caught mechanically.
