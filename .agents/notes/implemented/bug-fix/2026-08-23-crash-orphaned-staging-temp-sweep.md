# Agent Note: Sweep crash-orphaned staging temporaries at backend open

Status: implemented

English | [中文](2026-08-23-crash-orphaned-staging-temp-sweep.zh.md)

## Problem

Three persistence surfaces remove their staging temporary only on the happy path or on a caught error: the JSONL session backend writes `session.jsonl[.zstd].<random>.tmp` beside the final log before its link or no-overwrite rename, the local attachment store hard-links a staged object out of `attachments/v1/tmp/<uuid>` and unlinks the staging copy afterward, and the request-image cache renames `<hash>.<uuid>.tmp` over its cache entry. A crash or power loss between the temp write and publication strands the file forever. Nothing in the repository ever swept these names, so residue accumulated until manual deletion; discovery reads only directories and fixed artifact names, so the strays were also invisible.

## Decision

Each backend runs one best-effort sweep when it mounts, from the class plugin's `[Service.init]` lifecycle hook. The JSONL backend deletes every `*.tmp` file inside each session directory below its root whose mtime predates this process's start. The attachment store sweeps both of its surfaces in one pass under the same rule: entries of the private `tmp/` staging directory, and every `*.tmp` file beside a request-image cache object.

One discriminator governs all three surfaces. No published artifact ever takes a staged or `.tmp` name, so deletion can never reach one, but the name alone cannot prove its writer is dead: another live process sharing the root may hold a mid-publication temporary of any age. Each backend has created nothing yet at its own mount time, so its sweep collects the candidates whose modification time predates this process's start (`performance.timeOrigin`), a criterion that cannot prove their writers have exited; an orphan stranded after that cutoff waits for a later mount even when its writer is already gone. Sweeps touch only plain files and symlink leaves (removed as links, never followed), skip directories, and leave non-matching names alone.

Sweep failures never fail open(): a successful sweep that removed something logs its count at debug through the lifecycle hook, an enumeration failure surfaces there as a debug error without a swept count, and per-file removal failures are skipped silently so one locked entry cannot hide the rest. Whatever survives retries on the next startup.

## Alternatives considered

**Delete candidates unconditionally by name.** Rejected: a concurrent process's mid-write staging file would vanish between write and link, failing an otherwise healthy publish. The mtime guard confines collection to files provably older than this process.

**Trust the name alone for sibling `*.tmp` files and guard only attachment `tmp/`.** Rejected: the suffix proves a candidate never reaches a published artifact, not that its writing process is dead, so guarding one surface while sweeping siblings unconditionally left JSONL materialization and request-image publication exposed to the same live-peer race the `tmp/` guard already prevents. A uniform age guard keeps every surface at the same safety level.

**A cross-process lock protocol shared by sweepers and publishers.** Deferred: locks add their own failure mode (a crashed writer strands its stale lock), require touching every durability-critical publish path, and exceed this cleanup's best-effort contract; the age guard plus each surface's self-healing loss path bounds the residual window to a peer stalled across this process's boot.

**A periodic background sweeper or a shared utility package.** Rejected: residue accrues per storage root, so sweeping once at the owning backend's open bounds the work to one small directory walk per mount without timers, cross-package dependency edges, or coordination between backends.

## Verification

Package tests plant orphaned temporaries beside a real published JSONL log and inside a prepared attachment root, then assert stale candidates disappear while fresh ones (simulating another writer's in-flight temporary), logs, stored objects, cached variants, non-matching files, and out-of-scope locations survive byte-identically. Further tests cover per-entry failure isolation (one locked file does not hide the rest), enumeration-failure propagation to the caller, mount survival when the sweep rejects, and the documented logging split: a successful sweep logs its count at debug, a rejected sweep logs its error without a count. Both packages' existing suites pass unchanged.

## Consequences

Crash-orphaned staging files are collected on the first mount made by a process that started after the file was written, instead of accumulating indefinitely. Residue written during this process's boot window waits for the next mount rather than racing a concurrent writer. If a live peer's temporary is still removed mid-publish — possible only when the file predates this process's start — a lost JSONL materialization re-retains its batch and retries on the next flush, request-image generation simply rewrites the cache entry, and an attachment save fails once with a storage error; committed data is unaffected. The sweep runs on every mount, including short-lived processes, costing two directory levels of `readdir` plus `lstat` per candidate.
