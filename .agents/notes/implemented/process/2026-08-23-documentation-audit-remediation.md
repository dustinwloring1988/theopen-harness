# Agent Note: Documentation audit remediation — inventory gate, canonical glossary, real quickstart

Status: implemented

English | [中文](2026-08-23-documentation-audit-remediation.zh.md)

## Problem

A documentation audit (#67) found four clusters of gaps. Hand-maintained inventories drifted with no gate to catch them: root `AGENTS.md` documented two package groups that no longer exist under their recorded names and omitted sixteen others plus `apps/`, and the [`packages/README.md`](../../../../packages/README.md) table omitted two groups that the generated module graph already listed. The user docs redirected to a quickstart route that resolved only on the website, leaving GitHub readers at a dead end. The glossary was an orphan with three inbound links while three documents redefined its terms inline. The Cordis primer's dispatch-mode table missed the vendored fifth mode (`bail`, `vendor/cordis/src/events.ts`). Snapshot record commands were documented only in POSIX env-prefix form, which fails verbatim in PowerShell, the platform this repository develops on. Testing policy carried the rules but no walkthrough.

## Decision

- **Inventory gate**: [`verify-package-inventory`](../../../../scripts/verify-package-inventory.ts) joins `doc-sync` and diffs both hand-maintained inventories against `packages/*/` on disk, the same freshness discipline the generated catalogs already follow.
- **Entrance path**: `docs/user/guide/index.md` became a real `quickstart.md` holding prerequisites (Node floor), both run paths, key placement, and SDK pointers; the website manifest projects the same source at the same `guide/quickstart` route, so the redirect target now exists in-repo.
- **Canonical terms**: the glossary is the one home for term definitions; `architecture.md`, the generated capability-seams intro (via `gen-doc-graphs.ts`), and the primer link to it instead of restating definitions as authority. The primer gains the missing `bail` mode and a scopes-and-realms bridge for the `isolate` realm requirement.
- **Procedural home**: suite-to-surface routing, scenario tables, filtered local runs, and record/review steps moved into the cookbook recipe `writing-tests-and-snapshots-for-a-seam.md`; `testing.md` keeps policy and now carries dual-shell command forms.

## Alternatives considered

- **Generate both inventories from disk** — rejected: the layout list carries judgment (role descriptions, grouping) a generator cannot produce; a diff gate keeps judgment honest without freezing it into a catalog.
- **Keep the quickstart as a website-only alias** and repoint the redirect — rejected: GitHub is a primary reading surface; only a real file fixes it there.
- **Leave subsystem pages linking seam-design Agent Notes** — kept deliberately: per-seam design notes remain the detail home; only the term-level definition canonicalizes in the glossary.

## Consequences

Inventories regress red instead of silently; new groups must update both inventories and their README in the same change (`runtime-diagnostics/` gained its group README here). Budget ceilings rose for `AGENTS.md` (2200), `packages/README.md` (1080), and `cordis-primer.md` (760) because the added inventory rows and bridging content need the space. Verification: `pnpm run doc-sync` green, including the new gate proven red on a planted stale row and a deleted row before being proven green.
