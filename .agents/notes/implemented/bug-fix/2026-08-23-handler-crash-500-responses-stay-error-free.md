# Agent Note: Handler-crash 500 responses stay error-free

Status: implemented

English | [中文](2026-08-23-handler-crash-500-responses-stay-error-free.zh.md)

## Problem

The two catch-all crash paths of the `/api` carrier answered `handler failure: ${String(error)}` with status 500: the fetch handler in `toh-host-apiproxy` (`src/fetch/handler.ts`) and the generic RPC host in `toh-client-connection` (`src/rpc-host.ts`). Every unhandled handler exception therefore echoed the raw internal error text to the API client, and `String(error)` routinely carries absolute host filesystem paths and adapter internals. The rest of the codebase deliberately suppresses this — `api-proxy.ts` answers its session-export 500 with a fixed sentence precisely because the error may carry absolute host paths — so the catch-all paths reintroduced the leak on every crash a trusted-host browser page could trigger.

## Decision

Both crash paths log the full error server-side through `console.error` under their package's diagnostic prefix (`[apiproxy]`, `[client-connection]`) together with a fresh `randomUUID()` correlation id, and answer `handler failure (id <uuid>)` with status 500. The response body is fixed text plus that id only; the id appears in both the log line and the body, so a user-reported crash matches its server-side log entry without exposing internals. Both sites use the same message shape, keeping the two carriers consistent. No new dependency: `node:crypto`'s `randomUUID` was already the package convention.

## Alternatives considered

- **Echo only the error class or name** (e.g. `handler failure: Error`). Type names still describe internals and give support nothing matchable in logs; the correlation id serves the report-back use case directly.
- **A structured logger service.** Neither package has one today; both already report diagnostics through prefixed `console.error`. Introducing a logging seam belongs to a dedicated decision, not this fix.
- **Reuse the request's rpcId as the correlation id.** The crash may be unrelated to one call, clients can mint rpcIds themselves, and a caller-chosen id weakens the log-match guarantee; a server-minted UUID stays collision-free per incident.

## Consequences

Crash details stay on the host; browser error surfaces show a stable sentence plus an id. Debugging a reported crash now requires host log access, which matches the single-user local-service posture of the deployment. The SSE mid-stream failure frame still carries the raw error text by design — it is a separate surface owned by its own contract and remains untouched here.

## Testing

The two specs that pinned the leaking behavior now assert the safe shape: `packages/client/connection/tests/node-half.host.spec.ts` and `packages/host/apiproxy/tests/fetch-carrier.spec.ts` each expect a body matching `handler failure (id <uuid>)`, assert the raw error text is absent from the body, and verify the same correlation id (and the full error) appear in the captured `console.error` line.
