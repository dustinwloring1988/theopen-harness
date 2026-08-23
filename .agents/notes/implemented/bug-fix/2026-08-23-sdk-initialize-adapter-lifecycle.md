# Agent Note: SDK initialize replaces its adapter and refuses shutdown overlaps

Status: implemented

English | [中文](2026-08-23-sdk-initialize-adapter-lifecycle.zh.md)

## Problem

The JSON-RPC `initialize` method mounted the DeepSeek fallback adapter on every call whose provider had no owner and overwrote the single stored fiber reference, so a second handshake left the first mount running with no way to reach it: `shutdown` disposed only the newest fiber. An initialize that overlapped `performShutdown` could also mount a fresh fiber after the teardown sweep captured its list, leaving live subscriptions and services behind after shutdown reported completion. Automation hosts that reconnect by re-initializing accumulated leaked adapters across cycles.

## Decision

Repeated initialization is supported and leaves exactly one live server-mounted adapter. Concurrent `initialize` calls queue on one settled tail in arrival order, so two calls never interleave their field writes or mounts. Each queued run checks the shutting-down flag before doing work and rejects with the same error as post-shutdown prompts; it re-reads the flag through a helper after the mount await, because a shutdown that starts mid-mount sweeps without the not-yet-stored fiber, and the fresh mount then disposes itself before the rejection propagates. When the requested provider has no registered adapter, the run disposes the previously server-mounted fiber and clears the reference before mounting the replacement, keeping a failed mount from double-disposing at shutdown.

## Alternatives considered

**Reject every second initialize.** Enforcing the old unsupported-reinitialization stance breaks automation hosts whose only reconnect path is a new handshake, and the wire offers no per-session close to replace it with.

**Collect every mounted fiber and sweep them at shutdown.** Keeping superseded mounts alive until shutdown preserves the leak window inside long-lived processes and still needs a shutdown-side retry loop for fibers mounted during teardown; replacement with a pre-mount dispose gives one owner and one live fiber instead.

**Make performShutdown wait for in-flight initializes.** A cross-lifecycle lock couples both state machines while the entry check plus post-mount re-read already ends every interleave at quiescence, and callers must still handle the shutdown rejection.

## Verification

Package tests pin the lifecycle: two sequential initializes dispose the first mount and leave exactly one fiber for shutdown; overlapping initializes serialize behind the first mount; an initialize that overlaps shutdown rejects and disposes its own mount; a post-shutdown initialize rejects without mounting; and a real-harness run shows the DeepSeek provider absent from the context after repeated initialize plus shutdown.

## Consequences

Reconnect-by-reinitialize no longer accumulates adapters, and shutdown completion implies zero live server-mounted fibers even against concurrent handshakes. A slow initialize now delays later ones instead of interleaving with them, and a handshake that loses to shutdown surfaces as a rejected promise on that request only; the surrounding transport maps it to an ordinary JSON-RPC error response.
