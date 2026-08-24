# Agent Note: Bound concurrent unanswered server-to-client requests in toh-lsp-stdio

Status: implemented

English | [中文](2026-08-23-lsp-server-request-reply-bound.zh.md)

## Problem

`toh-lsp-stdio` bounds every inbound direction of the base protocol — the framing decoder caps headers and message bodies, and stderr is a bounded tail — but the outbound reply path had no bound. Each inbound server→client request spawned a handler whose reply frame is written to the child's stdin, and Node buffers `Writable` writes without limit while the pipe is full. A hostile or broken server that emits unanswered requests faster than replies drain therefore grows host memory without bound through undrained reply writes, bypassing every cap the package otherwise enforces against exactly that threat ("a hostile or broken server cannot exhaust memory"). The failure is silent: no error surfaces while buffering continues.

## Decision

`LspConnection` counts server→client requests whose reply write has not settled and refuses new ones past a fixed bound of 32 (`MAX_IN_FLIGHT_SERVER_REQUESTS`). Exceeding the bound fails the connection on the existing fatal path — retained cause `language server exceeded 32 unanswered server-to-client requests`, all pending client requests rejected, process tree terminated — the same treatment as a framing failure. Because the retained cause is the connection's transport-failure identity, the provider's existing ownership-safe recovery applies unchanged: the poisoned instance is disposed and the query transparently retries once on a fresh process.

The bound is a fixed constant, not configuration: it is a security invariant above any legitimate flow (real servers keep single-digit concurrency — progress creates, configuration pulls, capability registration), and per-workspace query serialization keeps ordinary concurrency at one.

## Alternatives considered

**Pause stdout processing while `stdin.writableNeedDrain` is set.** Rejected: drain is transiently set during normal operation whenever any write is in flight (a large `didOpen` document routinely fills the pipe), so read suspension would need its own liveness bound and would interleave with the fatal-error paths for marginal benefit over counting handlers.

**Drop or error-reply frames beyond the bound.** Rejected: dropping replies stalls conforming servers waiting on `workspace/configuration`, and an error reply is still a buffered write — it does not bound anything.

**Make the bound configurable per server entry.** Rejected against the repository rule that protocol constants and security invariants stay fixed; no consumer evidence supports needing more than single-digit concurrent server requests.

## Consequences

- Memory retention from unanswered server→client requests is now capped at the bound (tens of small frames) instead of unbounded.
- A server that legitimately exceeds 32 concurrent unanswered requests is killed rather than served; none observed does, and the diagnosable exit cause names the bound. This is the accepted trade-off for keeping the memory guarantee absolute.
- The counter decrements when a reply write settles either way, so slow (not stalled) drains never trip the bound.
