# Agent Note: SDK initialize replaces its adapter and refuses shutdown overlaps

Status: implemented

English | [中文](2026-08-23-sdk-initialize-adapter-lifecycle.zh.md)

## Problem

The JSON-RPC `initialize` method mounted the DeepSeek fallback adapter on every call whose provider had no owner and overwrote the single stored fiber reference, so a second handshake left the first mount running with no way to reach it: `shutdown` disposed only the newest fiber. An initialize that overlapped `performShutdown` could also mount a fresh fiber after the teardown sweep captured its list, leaving live subscriptions and services behind after shutdown reported completion. Automation hosts that reconnect by re-initializing accumulated leaked adapters across cycles.

## Decision

Repeated initialization is supported and leaves at most one live server-mounted adapter. Concurrent `initialize` calls queue on one settled tail in arrival order, so two calls never interleave their field writes or mounts. Each queued run checks the shutting-down flag before doing work and rejects with the same error as post-shutdown prompts. The stored fiber records which provider it serves: a run whose provider has no registered adapter disposes the stored fiber before mounting the replacement, and a run that selects a different registered provider disposes the stored fallback even though no replacement mounts. Disposal runs through one helper that registers the attempt before awaiting it: success releases ownership, failure keeps the fiber stored so `shutdown` retries and reports it while the rejection still reaches the initialize caller. A run re-reads the flag through a helper after the mount await, because a shutdown that starts mid-mount has not stored the fresh fiber, and the fresh mount then disposes itself before the rejection propagates. `performShutdown` awaits the initialization tail captured at entry plus any tracked disposal attempt before taking its teardown snapshot, so resolution follows every accepted handshake instead of racing one.

## Alternatives considered

**Reject every second initialize.** Enforcing the old unsupported-reinitialization stance breaks automation hosts whose only reconnect path is a new handshake, and the wire offers no per-session close to replace it with.

**Collect every mounted fiber and sweep them at shutdown.** Keeping superseded mounts alive until shutdown preserves the leak window inside long-lived processes and still needs a shutdown-side retry loop for fibers mounted during teardown; replacement with a pre-mount dispose gives one owner and one live fiber instead.

**Keep shutdown completion independent of initialization.** Relying only on the entry check plus post-mount self-dispose lets shutdown resolve while a mount or a superseded disposal is still settling, leaving a live adapter after the client observes a successful shutdown; awaiting the captured tail keeps quiescence inside the operation callers already wait on.

## Verification

Package tests pin the lifecycle: two sequential initializes dispose the first mount and leave exactly one fiber for shutdown; overlapping initializes serialize behind the first mount; an initialize that overlaps shutdown rejects and disposes its own mount; shutdown stays pending while an accepted initialize's mount or superseded disposal is still settling; a failed superseded disposal keeps ownership so shutdown retries and reports it; switching to another registered provider disposes the obsolete fallback without a replacement mount; a post-shutdown initialize rejects without mounting; and a real-harness run shows the DeepSeek provider absent from the context after repeated initialize plus shutdown.

## Consequences

Reconnect-by-reinitialize no longer accumulates adapters, and, when every disposal succeeds, shutdown completion implies zero live server-mounted fibers even against concurrent handshakes; a disposal that fails keeps the fiber stored for `shutdown` to retry, and if that retry fails as well, the fiber can remain live while `shutdown` reports the error. A slow initialize now delays later ones and shutdown completion instead of interleaving with them, and a handshake that loses to shutdown surfaces as a rejected promise on that request only; the surrounding transport maps it to an ordinary JSON-RPC error response.
