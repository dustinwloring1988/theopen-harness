# Agent Note: Scrollback retention appends in O(chunk) instead of O(buffer)

Status: implemented

English | [中文](2026-08-23-scrollback-append-cost.zh.md)

## Problem

The terminal-bash scrollback enforced its byte and line caps with whole-buffer string operations on every PTY data event: each append concatenated the retained value, split it on newlines, materialized one element per code point with `Array.from`, and sliced and rejoined the tail. Output keeps flowing into the scrollback for the session's lifetime whether or not anyone reads it, so once the buffer sat at its 4 MiB default cap, every incoming chunk cost several passes over the whole window plus two large intermediate arrays. A single model-launched flood therefore pinned the event loop in sustained quadratic churn and starved every other session and plugin sharing the process. Memory was capped correctly; only CPU was pathological.

## Decision

`BoundedOutputBuffer` (packages/terminal/terminal-bash/src/scrollback.ts) now retains UTF-8 bytes in one fixed ring of `maxBytes + 3` bytes instead of a JS string. Each append encodes only the incoming chunk, scans it for newlines, and writes it into the ring; when the chunk exceeds free space the oldest bytes are released, which can never lose data the caps would keep. The byte cap releases head bytes up to `size − maxBytes` and then advances the cut to the next UTF-8 lead byte, reproducing exactly the previous longest-whole-code-point-tail rule; the three slack bytes guarantee that cut position is always inside retained data. The optional line cap tracks newline offsets incrementally and releases head data through the newline that opens the last `maxLines` segments; offsets are addressed by stream position so earlier byte cuts cannot change which segment the line cap targets, and the index is compacted when most entries fall behind the window. A chunk longer than the ring replaces the window with the chunk's own capped tail, which provably contains every byte the combined stream could retain. Decoding happens only in `snapshot()` and `consume()`; readiness polling reads new `truncated`/`empty` getters so polls never decode the window.

Output parity holds because the retired algorithm applied per append — keep last `maxLines` segments, then keep the longest whole-code-point tail within `maxBytes` — composes over a stream into the same suffix this implementation maintains: both caps release only head data, their cut positions move monotonically forward, and any prefix the line cap would target that an earlier byte cut already removed sits behind the window start. Chunks arrive as complete decoded text, so the ring always begins at a code-point boundary and UTF-8 decoding reproduces the previous string-domain values.

## Alternatives considered

**Retain a deque of decoded chunks and join on read.** Appends stay O(chunk), but the window lives twice in memory as both chunks and joined read results, and byte-cap cuts still need byte accounting across chunk seams. The single ring deletes the seam handling.

**Cap only by lines or only by bytes.** Both caps are current tool-consumer contract (`read` pagination bounds in lines, `maxReadBytes` in bytes); dropping either changes returned output.

**Rate-limit or coalesce PTY events.** Sampling hides the amplification while retaining its cause, and drops output the current contract delivers.

**Adopt a terminal emulator library for retention.** The package deliberately renders normalized line-oriented text; an emulator brings processing and dependency weight no current consumer uses.

## Consequences

Append cost is proportional to the incoming chunk, including cap enforcement and head release; `snapshot()`, `consume()`, and `read()` remain O(window) because they decode on demand. The ring adds three bytes of slack, and the newline index stays bounded by periodic compaction. Caps, truncation flags, and UTF-8 boundary behavior are unchanged and pinned by randomized oracle tests against the retired implementation, exact multibyte and line-cap cases, and a steady-state guardrail asserting 20,000 appends into a saturated 512 KiB window stay far below quadratic cost.
