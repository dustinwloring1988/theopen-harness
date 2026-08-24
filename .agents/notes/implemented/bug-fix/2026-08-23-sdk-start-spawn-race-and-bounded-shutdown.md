# Agent Note: Python SDK atomic runtime spawn and bounded shutdown

Status: implemented

English | [中文](2026-08-23-sdk-start-spawn-race-and-bounded-shutdown.zh.md)

## Problem

`HarnessClient.start()` read `self._proc` outside the instance lock, so two concurrent calls could both pass the started guard, each spawn a runtime subprocess, and let the second assignment orphan the first process together with its profile. Separately, `close()` forwarded `shutdown_timeout_seconds=None` verbatim into both the JSON-RPC shutdown request and `Popen.wait()`, where `None` means unbounded: a wedged runtime blocked `close()` forever, including through `__exit__`, so a context-manager body exception could turn into an uninterruptible hang. Reviewing the fix exposed three further liveness gaps: `close()` read process ownership outside any lock shared with `start()`, so it could return while a spawn was still in flight and strand the finished runtime unowned; the shutdown request's stdin write ran outside the shutdown budget, so a write blocked behind another request holding `_write_lock`, or on a full stdin pipe, delayed termination forever; and a NaN configured timeout survived min/max clamping untouched, producing deadlines that never expire.

## Decision

`start()` performs its whole check-and-spawn under the instance lock and assigns `self._proc` inside that locked region, so one client owns at most one runtime subprocess. Lifecycle transitions additionally serialize behind a dedicated lifecycle lock held across spawn in `start()` and across process ownership teardown in `close()`; the instance lock keeps guarding only short shared-state access, so `request()` does not contend on the instance lock but may still contend on `_write_lock`, a concurrent `close()` cannot observe an in-progress spawn as an absent process, and no runtime can be stored after `close()` returned.

`close()` derives a single monotonic deadline from `shutdown_timeout_seconds` clamped into [0, 30] seconds — `None` and NaN select the ceiling instead of an unbounded wait; NaN cannot be recovered by clamping because every comparison against it is false — spends that budget across the shutdown request and the post-terminate join, then escalates from `terminate()` to `kill()` with a fixed five-second reap join. The shutdown request runs on a worker joined against the same deadline, so a write stuck behind another request's `_write_lock` or a full stdin pipe consumes only the remaining budget before termination proceeds. When the reap join times out, `close()` keeps the `Popen` reference so a retried `close()` can finish the reap and `start()` cannot spawn a second runtime while the previous one may still exist. The 30-second ceiling is a fixed liveness invariant rather than a configurable tunable: `close()` must return even against a runtime that ignores its shutdown handshake and termination signals, and the same bound protects `__exit__`.

## Verification

The pytest suite drives fake runtime peers: eight barrier-synchronized `start()` calls log exactly one spawned process id; `close()` with `shutdown_timeout_seconds=None` returns promptly against a peer that sleeps through shutdown while ignoring SIGTERM, under a patched-down ceiling; a fake Popen records that escalation reaches `kill()` with clamped, never-`None`, waits for both the unselected and a configured budget; a fake Popen that stays unreaped confirms `close()` keeps ownership while `start()` refuses to spawn. Further cases cover the review findings: a fake Popen stalled mid-spawn makes concurrent `close()` wait for the spawn to finish before tearing the runtime down; a shutdown send blocked on a held `_write_lock` still returns `close()` within the budget and reaches terminate/kill; a parametrized clamp table maps None, NaN, negative, and above-ceiling values into [0, 30] seconds; and a NaN-configured `close()` against a wedged peer escalates to kill with ceiling-bounded waits.

## Alternatives considered

**Clamping each call site independently (`min(configured or cap, cap)`).** Simpler, but the request and the process join could each consume the full budget, doubling worst-case teardown time; one shared deadline keeps total close time within one budget plus the reap join.

**Sending the shutdown request inline after checking whether the write lock is free.** Rejected: even with `_write_lock` uncontended, a flush on a full stdin pipe blocks past the deadline; only bounding the whole send covers both write contention and backpressure.

**A caller-configurable ceiling.** Rejected because the guarantee is that `close()` always returns; making the upper bound configurable would reintroduce unbounded blocking through `__exit__`.

**Widening the lock only around the guard read.** Rejected because the race window moves to the assignment; check-and-spawn must be one critical section to serialize duplicate starts.

## Consequences

A wedged runtime costs at most roughly 35 seconds of teardown instead of hanging the caller: shutdown waits are capped at 30 seconds plus the five-second reap join, whatever the stdin write or configuration contains. Concurrent `start()` and `close()` callers serialize behind one lifecycle transition, paying single process-launch latency instead of leaking a duplicate runtime or tearing down a half-finished spawn.
