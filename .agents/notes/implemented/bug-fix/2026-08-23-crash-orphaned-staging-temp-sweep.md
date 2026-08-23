# Agent Note: Sweep crash-orphaned staging temporaries at backend open

Status: implemented

English | [中文](2026-08-23-crash-orphaned-staging-temp-sweep.zh.md)

## Problem

Three persistence surfaces remove their staging temporary only on the happy path or on a caught error: the JSONL session backend writes `session.jsonl[.zstd].<random>.tmp` beside the final log before its link or no-overwrite rename, the local attachment store hard-links a staged object out of `attachments/v1/tmp/<uuid>` and unlinks the staging copy afterward, and the request-image cache renames `<hash>.<uuid>.tmp` over its cache entry. A crash or power loss between the temp write and publication strands the file forever. Nothing in the repository ever swept these names, so residue accumulated until manual deletion; discovery reads only directories and fixed artifact names, so the strays were also invisible.

## Decision

Each backend runs one best-effort sweep when it mounts, from the class plugin's `[Service.init]` lifecycle hook. The JSONL backend deletes every `*.tmp` file inside each session directory below its root. The attachment store sweeps both of its surfaces in one pass: entries of the private `tmp/` staging directory whose mtime predates this process's start, and every `*.tmp` file beside a request-image cache object.

The garbage proof differs by surface, and the sweep follows it. A published log or cached request image always takes a name without `.tmp`, so any `*.tmp` sibling is provable residue regardless of age — deleting one can never affect a published artifact. Staging entries under attachment `tmp/` are UUID-named and indistinguishable from an in-flight write by name, so age is the discriminator there: this process has created nothing yet at mount time, and a concurrent writer's file created after this process started keeps a fresh mtime that protects it. Sweeps touch only plain files and symlink leaves (removed as links, never followed), skip directories, and leave non-matching names alone.

Sweep failures never fail open(): enumeration errors and per-file removal failures surface at debug with swept counts, because residue is harmless — no read path reaches those names — and a locked file must not block session or attachment operations behind an unfixable mount error. Each startup retries whatever survived.

## Alternatives considered

**Delete `tmp/` entries unconditionally.** Rejected: a concurrent process's mid-write staging file would vanish between write and link, failing an otherwise healthy publish. The mtime guard confines collection to files provably older than this process.

**Apply the same mtime guard to sibling `*.tmp` files.** Rejected: age adds nothing where the name already proves garbage, and it would let a pre-startup orphan survive until a mount that starts after the file's mtime cutoff — precisely the accumulation the sweep exists to prevent. (The guard remains for `tmp/`, where the name cannot prove anything.)

**A periodic background sweeper or a shared utility package.** Rejected: residue accrues per storage root, so sweeping once at the owning backend's open bounds the work to one small directory walk per mount without timers, cross-package dependency edges, or coordination between backends.

## Verification

Package tests plant orphaned temporaries beside a real published JSONL log and inside a prepared attachment root, then assert the stale and fresh `.tmp` files disappear while logs, stored objects, cached variants, non-matching files, and out-of-scope locations survive byte-identically. Further tests cover the mtime guard through the public open path (a future-dated staging entry survives), per-entry failure isolation (one locked file does not hide the rest), enumeration-failure propagation to the caller, and mount survival when the sweep rejects. Both packages' existing suites pass unchanged.

## Consequences

Crash-orphaned staging files are collected on the next mount of the owning backend instead of accumulating indefinitely. A concurrent writer whose temp is removed mid-publish (only possible for a `*.tmp` sibling created before this process started) loses one append batch and retries it through the coordinator's retained-buffer path; no committed data is affected. The sweep runs on every mount, including short-lived processes, costing two directory levels of `readdir` plus `lstat` per candidate.
