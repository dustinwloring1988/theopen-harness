# Agent Note: AclSandbox piped-capture byte budget

Status: implemented

English | [中文](2026-08-23-acl-piped-capture-byte-budget.zh.md)

## Problem

`AclSandbox.spawn({ stdio: 'pipe' })` drained the confined child's stdout and stderr into unbounded in-memory buffers: `drainPipe` concatenated every polled chunk with no size limit anywhere. `AclSandbox` is the package's public API, so any direct consumer inherited an unbounded host-memory commitment — a chatty or runaway child grew the host process until OOM. The shipped composition masked the defect because `LocalSandboxProvider.confine()` returns argv and executors collect through the bounded subprocess seam, while the runner itself spawns with `stdio: 'inherit'`; every other spawner in the repository enforces a byte budget (the subprocess seam's `OutputCollector`, the E2B output reader).

## Decision

`drainPipe` takes a required retained-bytes cap and keeps a bounded tail: once more than `maxBytes` has arrived, whole head chunks (or the head of a single over-cap chunk) are dropped until exactly the most recent `maxBytes` remain — the subprocess seam's `OutputCollector` tail-keep shape, adopted for its recorded rationale that errors and final results cluster at the end of command output. Retention never exceeds the cap regardless of how the child chunks or volumes its output, and the pipe handle still closes on every path.

`AclSandboxSpawnOptions` gains `maxOutputBytes`: the per-stream budget, applied independently to stdout and stderr to match the subprocess seam's per-stream collectors. Its default is 64_000 (`DEFAULT_MAX_OUTPUT_BYTES`), the repository's standard per-stream output budget (the `toh-bash-local`/`toh-pwsh-local` `maxOutputBytes` config). The piped path resolves the default as an explicit step and rejects any value that is not a positive integer before spawning — a NaN or Infinity budget would silently disable the trim, and a fractional one would desync its chunk accounting (subarray truncation against fractional bookkeeping), so the retained window could exceed the cap; misconfiguration fails loud at the boundary. `stdio: 'inherit'` ignores the option outright — no capture means no validation either — so an inherited spawn never rejects on it.

## Verification

`tests/drain-bound.spec.ts` pins the drain-level tail-keep (sub-cap output intact across polls, both head-drop paths yielding a byte-exact last-`maxBytes` window, a single over-cap chunk trimmed to its tail) and drives REAL confined children on win32 hosts: one over-producing child under a small explicit cap, one under the default budget, and the pre-spawn rejection of a fractional budget. The stub harness in `tests/index-failure-paths.spec.ts` pins the spawn-side resolution: an explicit cap applied to both streams, the default applied when the option is omitted, the fail-loud rejection of invalid piped values before any spawn, and inherited stdio accepting an invalid budget untouched.

## Alternatives considered

**Route the pipe path through the subprocess seam's `OutputCollector`.** Rejected: the collector also owns spill files and incremental whole-stream reads that this package does not consume, and importing `toh-subprocess-local` into a koffi-backed sandbox backend adds a workspace dependency to buy one trimmed-concatenate loop. Mirroring the tail semantics without the spill machinery delivers the same bound.

**Stop draining or terminate the child at the cap.** Rejected: the exit code must stay authoritative and capture must run to EOF, so the collector keeps the diagnostic tail instead of abandoning it mid-stream.

**Keep full retention behind a documented caveat.** Rejected: the reported defect is the unbounded buffer itself; documenting it leaves the OOM path intact.

## Consequences

Direct `AclSandbox` consumers get memory-bounded piped capture by default; a caller needing more history raises `maxOutputBytes` explicitly and accepts the corresponding bound. Output past the budget is lost from the returned Buffer (head-dropped), matching the subprocess seam's no-spill diagnostics-tail behavior; this package deliberately ships no spill-file mode, so the dropped head is unrecoverable through this API.
