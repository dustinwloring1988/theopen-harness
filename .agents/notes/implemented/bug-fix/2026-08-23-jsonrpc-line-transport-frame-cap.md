# Agent Note: The JSON-RPC line transport caps an unterminated frame and fails the peer past it

Status: implemented

English | [中文](2026-08-23-jsonrpc-line-transport-frame-cap.zh.md)

## Problem

`JsonRpcLineTransport` retained every incoming byte in one string buffer until a `\n` arrived, with no limit on how long that wait could last or how large the accumulation could grow. A peer that streams bytes without a newline — a buggy client, a corrupted stream, a hostile process — therefore grew the transport's buffer without bound on both wire ends (SDK client ↔ runtime subprocess over stdio) until the runtime process ran out of memory. The failure mode was silent: requests stayed pending, no error surfaced, and memory climbed.

## Decision

The transport now takes an optional `maxFrameBytes` (`JsonRpcLineTransportOptions`) defaulting to `DEFAULT_MAX_FRAME_BYTES` = 16 MiB, validated at construction as a positive safe integer. The cap is measured in UTF-8 bytes across chunk boundaries: the transport tracks the byte length of undrained input alongside its decoded string, so multibyte characters split across `Buffer` chunks cannot hide size from the meter.

When input exceeds the cap with no newline pending, the transport drops the buffered frame, destroys the caller's input stream with a `JsonRpcResponseError` carrying code `-32700` (parse error), and lets the stream error reject every pending request through the existing `onInputError` path. Destroying the input stops further delivery at the stream layer; the connection cannot resume mid-frame, so teardown — not resynchronization — is the correct response. Later chunks are never retained. The cap bounds one partial frame only: complete lines awaiting dispatch may legitimately exceed it in total, and draining them first keeps batching valid.

16 MiB sits far above any legitimate SDK frame today (session events, prompts, tool payloads), and decoded retention stays within the configured value because UTF-8 bytes never outnumber their UTF-16 code units by more than one to one.

## Alternatives considered

**Fixed internal constant, no option.** Rejected because the two production consumers sit at different trust boundaries — the server reads local stdio, the client reads a subprocess it spawned, and `subagent-codex` wires another peer — so a deployment that knows its frames stay small should be able to tighten the bound without forking the class. The repo convention reserves fixed protocol constants for external specs; this ceiling is a resource policy, not a wire rule.

**Resynchronize by discarding bytes up to the next newline instead of destroying the stream.** Rejected because scanning unbounded hostile input for the next `\n` reintroduces the growth being prevented, and any bytes already consumed into the discarded frame make the peer's request/response id stream ambiguous. A connection that delivered an oversized frame is faulty; failing it loudly beats silently skipping an unknowable amount of traffic.

**Fail pendings but leave the stream attached and drop subsequent oversized chunks.** Rejected because a detached-but-live input keeps delivering data into a transport that has declared the connection unusable, leaving both ends in disagreement about whether the wire works.

## Consequences

- A peer can no longer grow the runtime process's memory through newline-free streaming; retention per direction is bounded by construction.
- An SDK session hit by the cap sees its outstanding `request()` promises reject with `JsonRpcResponseError` code `-32700` and the child's stdout destroyed — the same closure surface as any other stream death, so clients recover through their existing exit handling rather than a new path.
- A legitimate single frame larger than 16 MiB now fails instead of succeeding slowly; a consumer that needs larger frames raises `maxFrameBytes` at construction, and no current consumer needs to.
- The byte meter adds one number of state and one subtraction per drained line; chunked multibyte accounting stays exact without re-scanning buffers.

## Testing

`packages/sdk/protocol/tests/transport.spec.ts` pins the default value, rejects invalid options at construction, proves an oversized newline-free stream rejects pendings with `-32700` and retains no later input, proves complete lines above the cap still dispatch, exercises the exact-cap boundary (buffering allowed at the cap, overflow strictly past it), and pins byte-based measurement with a multibyte frame under a 5-byte cap.
