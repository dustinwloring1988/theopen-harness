# Agent Note: Browser-side Markdown transcript export beside the raw ZIP

Status: implemented

English | [中文](2026-08-23-markdown-transcript-export.zh.md)

## Problem

`/export` produced only a ZIP of raw log artifacts (JSONL/zstd bytes verbatim, subagent logs, media). The archive is faithful but not human-readable: reading a session outside the web UI required tooling. A readable transcript format was needed without changing the raw-ZIP path, adding model-visible behavior, or token cost.

## Decision

The Web `/export` grammar gains an `md` variant, and the Session Header gains a second capsule beside `Session log`; both entry paths share the existing download controller and modal. The Markdown transcript is serialized entirely browser-side from the finalized conversation nodes the client already assembles (`ctx.sessions.binding(id).session.getSnapshot().nodes`, read at gesture time so the render path never subscribes to conversation changes). The document uses speaker sections (`## User`, `## Steering`, `## Assistant (turn N)`), fenced compact tool-call and result summaries with bounded excerpts, elided reasoning, skipped context injections, and notes for command rows, compaction checkpoints, retries, turn failures, and unknown entries. Prose is escaped against structure injection (headings, blockquotes, rules, fences), verbatim fences grow past any line-start backtick run they contain, and excerpts cap at 600 characters with an explicit truncation marker.

Serialization lives in `@buckeyestudio/toh-session-log-export` (`src/client/transcript.ts`) because that package already owns both export entry paths, the controller, and the modal; no new package, route, or host endpoint exists. The raw ZIP path is byte-for-byte unchanged.

## Alternatives considered

- **A bounded Remote verb over `sessionQuery.readSurface()`.** Authoritative full-surface fidelity, including shadowed-history resolution and complete logs beyond the client's window. Rejected for now: it requires a generated `/remote` artifact, host wiring, and a new wire contract for what is today a presentation feature; the assembled client nodes cover the conversation the exporting tab can actually see. Revisit if transcript fidelity beyond the loaded window becomes a real requirement.
- **A self-contained HTML variant.** Richer rendering (collapsible reasoning, styling) in one file. Deferred: larger surface (template safety, escaping policy duplication) with no current consumer demand; Markdown plus the existing safe GFM renderer covers the readable-transcript need.
- **Host-side serialization appended to the ZIP.** One artifact, host-authoritative text. Rejected: couples presentation formatting into the ApiProxy artifact plane, forces a format choice on every ZIP consumer, and still needs the same escaping logic duplicated server-side.

## Consequences

- Long-session transcripts reflect the client's loaded event window; history never paged in is absent, and sub-Sessions are not included. The limitation is documented in the package README rather than hidden.
- Zero model-visible effect and zero token effect: the command lifecycle stays log-only, and serialization reads published UI state.
- Escaping is tested adversarially (heading/quote/rule/fence injection, fence-length escalation, excerpt bounds), so transcript content cannot restructure the document.
- Web UI goldens changed (one extra header button); refreshed through the keyless snapshot harness.
