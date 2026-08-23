# @buckeyestudio/toh-session-log-export

English | [中文](README.zh.md)

Web Session-log export control: a raw host-streamed ZIP owned by `toh-host-apiproxy`, plus a human-readable Markdown transcript assembled in the browser. The Host half registers `/export`; the browser half owns two 111×32 actions in the Session Header (`Session log` and `Markdown`), one download controller, and one modal shared by those buttons and the slash command. ZIP generation, raw JSONL/zstd reads, descendants, attachments, backpressure, and HTTP error semantics remain owned by the [ApiProxy download implementation](../../host/apiproxy/README.md).

## Command contract

| Input | Result |
|---|---|
| `/export` | Record a human-command lifecycle; the submitting browser receives the local execution acknowledgment and downloads `GET /api/session.export?sessionId=<id>&includeDescendants=true`. |
| `/export md` | Record the same lifecycle; the submitting browser serializes its assembled conversation window into a Markdown transcript and saves it through a short-lived object URL. |
| `/export <path>` | Return an error. Browser downloads choose their destination through the browser's ordinary download behavior. |

The command is mounted only by the Web bundle. The local `command/executed` acknowledgment triggers the matching download only after a successful `/export` result in the browser that submitted it; other tabs still render the durable command row without repeating the browser side effect. The Header buttons call the same controller directly. Both entry paths share in-flight collapsing (one active download per Session regardless of format), cancellation on plugin disposal, preparation-error handling, browser save behavior, and the same Modal; only the ZIP path issues the `HEAD` preflight.

### Markdown transcript format

The transcript is serialized browser-side from the finalized conversation nodes the client already holds (`ctx.sessions.binding(...).session.getSnapshot().nodes`) at gesture time; the render path never subscribes to conversation changes for it. The document is a `# Session transcript` header with session id, export timestamp, and rendered entry count, followed by speaker sections: `## User`, `## Steering`, and `## Assistant (turn N)`; tool requests appear as `### Tool call: <name>` with fenced compact arguments, flow-level results as `### Tool result: <name>` with a bounded output excerpt and direct subcall names; command rows, compaction checkpoints, retries, turn failures, and unknown entries render as labeled notes or fenced rows. Reasoning blocks are elided and context injections are skipped. Prose is escaped so transcript text cannot inject headings, blockquotes, rules, or code fences; verbatim fences grow past any line-start backtick run they contain; excerpts cap at 600 characters with an explicit truncation marker.

The Host ZIP endpoint is untouched: `/export` keeps streaming raw artifacts exactly as before, and no new binary route exists for transcripts.

The modal reports preparation, download start, or failure, naming the chosen artifact. Closing it does not cancel an in-flight download and does not reopen it when that operation later settles.

## Composition

```yaml
- id: session-log-download
  name: '@buckeyestudio/toh-session-log-export'
```

The Web bundle mounts the package beside `toh-host-apiproxy`, `toh-commands`, `toh-client-ui-commands`, and `toh-client-ui-conversation`. The package contributes its buttons and modal to the right-aligned `conversation.session.header.utilities` list, independently of the title-adjacent mode, Subagent, and Task entries in `conversation.session.header.actions`; Trajectory carries no export control.

## Model Experience

### Human `/export` control

#### What the model sees

Nothing. `/export` stays on the human-command plane, and neither download enters model history.

#### Token effect

Zero. The command creates no model turn.

#### KV Cache effect

None. The log-only command lifecycle and browser downloads do not change the derived request prefix.

## Known Limitations and Deferred Work

- The download endpoint requires a persistence backend with a per-Session raw artifact. The shipped JSONL backend supports plaintext and zstd artifacts; SQLite export is not included in this change.
- This is a browser download, not a Host-path writer. The browser chooses the local destination; no Host path or native folder action is returned.
- The preflight reports failures found before ZIP streaming starts. A descendant or attachment failure after the browser accepts the GET is reported by the browser download manager, not by the modal.
- The Markdown transcript covers this client's loaded event window (the conversation the tab can assemble); older pages never paged in are absent, and sub-Sessions are not included. Full-surface fidelity would need a bounded Remote verb over `sessionQuery.readSurface()`.
