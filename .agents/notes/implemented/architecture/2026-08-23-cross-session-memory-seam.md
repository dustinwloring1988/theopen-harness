# Agent Note: cross-session fact memory seam (memory/memory-local/tool-memory)

Status: implemented

English | [中文](2026-08-23-cross-session-memory-seam.zh.md)

## Problem

The harness had no way for an agent to record and recall facts across sessions within a workspace. Every cross-run channel was either unstructured (files in the working tree — the substitute `tool-ralph` hardcodes into its model instructions) or scoped to one conversation (the session log; `session-query-sqlite` searches transcripts, not curated facts). Issue #64 asked for a `ctx.memory` capability group following the Service Definition / Provider / Consumer pattern, keyword-scoped recall first, persisted through the existing domain storage hub, with zero loop changes.

## Decision

Three packages under a new `packages/memory/` group:

- **`toh-memory`** owns the seam: a merge-extensible provider map plus execution-time selection copied from `ctx.web` (configured id must be registered; otherwise exactly one registered provider auto-selects; zero or several fail loud) rather than the scope-layered machinery of `ctx.skills`, because facts are partitioned data, not merged views — two stores would be a split brain, so multi-provider ambiguity is misconfiguration, not precedence. The registry rejects blank text itself and requires the caller's workspace scope on recall and forget, so no direct or alternate caller can read across workspaces or delete outside its own regardless of provider tolerance (one rule shared by every provider and consumer), and emits one `memory/changed` per committed mutation.
- **`toh-memory-local`** is the first provider: rows in the `memory` domain's `facts` table opened through `ctx.storageDomain.open(memoryDomainSpec)` (the proven workspace/message-feedback pattern), keyed by branded UUIDs, scoped by the caller's canonical workspace cwd, recalled through case-insensitive keyword-subset conjunction narrowed by scope and tags, newest-first. A forget addressed under another scope is indistinguishable from an unknown id. An embeddings provider can replace the matching semantics without changing the seam.
- **`toh-tool-memory`** registers `memory_remember` / `memory_recall` / `memory_forget` on `ctx.tools` plus a fixed `tool:memory` prompt section (order 113). Facts scope to the calling agent's session-header cwd; calls without one fail loud instead of defaulting silently. Render intents (`execute`/`search`/`delete`) and result templates were decided up front; configuration resolves once into an explicit spec (`maxRecallResults`, default 20) that both registration and execution read, so model-visible bounds stay deployment-tunable without touching providers.

Composition stays opt-in: no shipped bundle mounts any row. The intended three-row insert (memory → memory-local → tool-memory over an existing storage-domain + backend) lives in the package README and PR body.

## Consequences

- Agents gain a durable, workspace-scoped, model-controllable memory channel that survives sessions without writing files into the working tree.
- The capability-seams doc gains a `ctx.memory` row; the cordis catalog gains a generated region on `docs/subsystems/memory.md`; the tool catalog boots `tool-memory`; module-graph picks the group up automatically through peerDependencies.
- `toh-storage-sqlite` (#41) gains a legitimate future consumer: routing the `memory` domain to SQLite needs only a storage-domain route change, no code here.
- Nothing composed changes for existing deployments; the tools appear in transcripts only where an overlay mounts them.

## Alternatives considered

- **Skills-style layered registry** — rejected: layers/ranks decide duplicate NAMES for catalogs, while memory needs one authoritative store per workspace; selection semantics, not shadowing, are the contract.
- **Facts as session events** — rejected: cross-session facts must survive log rotation/compaction independent of one conversation and must be forgettable without rewriting history; durable non-session storage is exactly what the domain form exists for.
- **Mounting the trio in `packages/bundle/base`** — deferred: new model-visible tools alter every shipped transcript and snapshot fixture; shipping opt-in first keeps this PR purely additive, and flipping the base rows later is a one-line-per-row change.
