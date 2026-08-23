# Agent Note: SDK JSON-RPC params validate at the wire before dispatch

Status: implemented

English | [中文](2026-08-23-sdk-jsonrpc-wire-param-validation.zh.md)

## Problem

The SDK JSON-RPC server cast raw decoded params straight into its typed handlers, so the stdio peer — an out-of-process client the runtime has no reason to trust — decided what entered a durable session log. `HarnessSdkJsonRpcServer.handleRequest` performed `params as unknown as InitializeParams` and `params as unknown as SessionPromptParams`, and `session/prompt` passed `contentBlocks` verbatim into `createUserMessage`. A hostile or broken client could submit harness-produced block vocabulary — a `tool-result` naming an arbitrary call id, a `reasoning` block, extra fields riding inside a `text` block — and it was persisted into the session log and sent on the next model request as if the harness had produced it. Every other ingress validates first: the web gateway zod-parses each payload and narrows prompt content to prompt-side blocks, and the ACP bridge runs full prompt admission; the SDK server was the gap.

Malformed shapes also failed late and vaguely. `contentBlocks: {}` threw deep inside message freezing and surfaced as a generic `-32603` internal error instead of `-32602` invalid params, because the line transport maps every handler rejection to `-32603`.

## Decision

Every method dispatched by `handleRequest` validates its params against a zod schema in [wire.ts](../../../../packages/sdk/server/src/wire.ts) before the typed handler runs. The schemas mirror the web gateway's request-schema policy field for field where the two surfaces overlap: required fields typed and non-empty, unknown fields stripped rather than rejected, `initialize.maxTokens` a positive safe integer, and `session/prompt.contentBlocks` restricted to prompt-side blocks only — `text`, and core `image` blocks carrying a durable attachment reference with positive integer dimensions. The harness-produced tags (`tool-call`, `tool-result`, `reasoning`) and unknown tags fail validation, so nothing but user-authored content can enter the log through this boundary.

A failure throws `JsonRpcResponseError` with code `-32602`; the message names the method and each failing field, and `data.issues` carries the structured issue list. The line transport now writes a handler-thrown `JsonRpcResponseError` back verbatim — code, message, `data` — when its `code` is numeric; a missing or non-numeric `code` falls back to `-32603` without `data`, and `data` that fails JSON serialization is dropped from the frame so the peer always receives a response. Every other rejection keeps the `-32603` mapping. The protocol class already represented an error frame for clients; servers throwing it is the same representation used in the outbound direction.

## Alternatives considered

**Validating inside each handler.** Rejected: the typed methods are also called directly in-process, where TypeScript already owns the contract and the repo rule forbids runtime re-checking of static guarantees; putting admission there would leave `handleRequest` free to forget it again, and enforcement belongs at the operation that makes it.

**Hand-rolled shape checks instead of zod.** Rejected by the maintained-dependencies policy: the web gateway already owns this exact job with zod, and hand-writing discriminant walks plus issue formatting would add owned code and drift from the gateway's semantics for no gain.

**Rejecting unknown fields (`strict`).** Rejected: the gateway's request schemas strip extras, and matching that behavior keeps forward-compatible clients working identically against both ingresses.

**Text-only prompts.** Considered narrower than the shipped union. Lost: `image` is a prompt-side type in core content, the gateway admits images, and the SDK image block carries only a durable reference the host resolves — refusing it would break legitimate clients without closing any gap the block-type restriction leaves open.

## Consequences

Forged history injection through the SDK socket is closed: a `tool-result` block now answers `-32602` before a session or message exists, so nothing reaches the durable log or a model request. Malformed params answer `-32602` with per-field detail instead of `-32603`.

Clients that never sent non-prompt blocks — both shipped SDKs normalize input to text blocks — see no behavior change beyond better error codes. A client that did send such blocks was relying on the defect this change fixes. The Python SDK mirrors these shapes without importing them, so it needs no code change; its docs describe text prompts.

`toh-sdk-jsonrpc-server` gains a runtime `zod` dependency, as `toh-host-apiproxy` already carries.

## Testing

`packages/sdk/server/tests/server.spec.ts` drives `handleRequest` directly: forged `tool-result` rejection with no queued message and no notification, malformed param tables answering `-32602` rather than `-32603` for `initialize` and `session/prompt`, unknown-field stripping for top-level params and inside `text` blocks, and acceptance of prompt-side `text` plus `image` blocks with exact durable content equality.

`packages/sdk/server/tests/plugin-apply.spec.ts` sends a forged block over the real injected stdio pair and pins the `-32602` error frame plus the absence of any `session.event` or `session.status` notification.

`packages/sdk/protocol/tests/transport.spec.ts` pins that a handler-thrown `JsonRpcResponseError` round-trips its code, message, and `data` while plain handler failures still answer `-32603`. It also pins the `-32603` no-data fallback for a thrown `JsonRpcResponseError` without a numeric code and the dropped-data fallback when `data` cannot serialize (circular reference, `BigInt`).
