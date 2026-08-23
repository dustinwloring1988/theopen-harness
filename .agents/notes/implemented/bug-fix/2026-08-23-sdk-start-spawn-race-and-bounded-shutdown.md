# Agent Note: Python SDK atomic runtime spawn and bounded shutdown

Status: implemented

English | [中文](2026-08-23-sdk-start-spawn-race-and-bounded-shutdown.zh.md)

## Problem

`HarnessClient.start()` read `self._proc` outside the instance lock, so two concurrent calls could both pass the started guard, each spawn a runtime subprocess, and let the second assignment orphan the first process together with its profile. Separately, `close()` forwarded `shutdown_timeout_seconds=None` verbatim into both the JSON-RPC shutdown request and `Popen.wait()`, where `None` means unbounded: a wedged runtime blocked `close()` forever, including through `__exit__`, so a context-manager body exception could turn into an uninterruptible hang.

## Decision

`start()` performs its whole check-and-spawn under the instance lock and assigns `self._proc` inside that locked region, so one client owns at most one runtime subprocess.

`close()` derives a single monotonic deadline from `shutdown_timeout_seconds` clamped into [0, 30] seconds — `None` selects the ceiling instead of an unbounded wait — spends that budget across the shutdown request and the post-terminate join, then escalates from `terminate()` to `kill()` with a fixed five-second reap join. The 30-second ceiling is a fixed liveness invariant rather than a configurable tunable: `close()` must return even against a runtime that ignores its shutdown handshake and termination signals, and the same bound protects `__exit__`.

## Verification

The pytest suite drives fake runtime peers: eight barrier-synchronized `start()` calls log exactly one spawned process id; `close()` with `shutdown_timeout_seconds=None` returns promptly against a peer that sleeps through shutdown while ignoring SIGTERM, under a patched-down ceiling; and a fake Popen records that escalation reaches `kill()` with clamped, never-`None`, waits for both the unselected and a configured budget.

## Alternatives considered

**Clamping each call site independently (`min(configured or cap, cap)`).** Simpler, but the request and the process join could each consume the full budget, doubling worst-case teardown time; one shared deadline keeps total close time within one budget plus the reap join.

**A caller-configurable ceiling.** Rejected because the guarantee is that `close()` always returns; making the upper bound configurable would reintroduce unbounded blocking through `__exit__`.

**Widening the lock only around the guard read.** Rejected because the race window moves to the assignment; check-and-spawn must be one critical section to serialize duplicate starts.

## Consequences

A wedged runtime now costs at most roughly 35 seconds of teardown instead of hanging the caller, and cooperative shutdown longer than 30 seconds is no longer expressible. Concurrent `start()` callers serialize behind one spawn, paying single process-launch latency instead of leaking a duplicate runtime.
