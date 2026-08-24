# @buckeyestudio/toh-tool-memory

English | [中文](README.zh.md)

The model-facing cross-session memory tools — `memory_remember`, `memory_recall`, and `memory_forget` — plus the system-prompt guidance describing when memory applies. Facts scope to the calling agent's workspace directory taken from the session header; a call without one fails loud.

Requires `ctx.tools`, `ctx.memory`, and `ctx.systemPrompt` (`inject: ['tools', 'memory', 'systemPrompt']`), plus a registered `ctx.memory` provider such as [`@buckeyestudio/toh-memory-local`](../memory-local).

## Composition (opt-in)

The package ships in no bundle; enabling it is three rows in your profile or overlay patch:

```yaml
- insert:
    - id: memory
      name: '@buckeyestudio/toh-memory'
    - id: memory-local
      name: '@buckeyestudio/toh-memory-local'
    - id: tool-memory
      name: '@buckeyestudio/toh-tool-memory'
```

`memory-local` additionally needs `@buckeyestudio/toh-storage-domain` and one of its backends (e.g. `storage-json`) in the composition.

## Tools

| Tool | Args | Behavior |
|---|---|---|
| `memory_remember` | `fact` (required), `tags?` | Stores one fact and returns its id. Blank text and empty tags fail loud; tags are trimmed and deduplicated. |
| `memory_recall` | `query?`, `tags?`, `limit?` | Keyword-conjunction search over the current workspace's facts; omitting `query` lists newest facts. Results cap at `maxRecallResults` with an explicit truncation flag. |
| `memory_forget` | `id` (required) | Deletes by id; a miss is an explicit `{ forgotten: false }`, never an error. |

Every committed mutation also emits `memory/changed` through `ctx.memory`.

## Config

| Key | Default | Meaning |
|---|---|---|
| `maxRecallResults` | `20` | Maximum facts one `memory_recall` result may list; minimum 1. |

## Model Experience

### Prompt guidance

#### What the model sees

Where the tools are visible, the model receives a fixed `tool:memory` section: record reusable facts (user preferences, project decisions, environment quirks, task outcomes) as short self-contained statements with a few specific tags; recall stored facts before acting on assumptions earlier sessions may have settled; facts survive this conversation and are shared across sessions in this workspace; never store secrets or ephemeral scratch state — the working tree remains the source of truth for code state.

#### Token effect

Fixed per-request cost, present only while all three tools are visible.

#### KV Cache effect

Prefix-stable; only plugin lifecycle changes invalidate the section.

### Tool schema

#### What the model sees

The generated [memory tool schemas](../../../docs/tool-catalog.md#buckeyestudiotoh-tool-memory).

#### Token effect

Three fixed schemas per request.

#### KV Cache effect

Prefix-stable while definitions and visibility are unchanged.

### Tool result

#### What the model sees

`memory_remember` renders one line `Stored memory <id>.`; `memory_recall` renders a `<returned> of <total>` overview plus one `- <id>: <text> [tags]` line per fact (`No stored memories matched.` on zero hits); `memory_forget` renders `Forgot memory <id>.` or `No stored memory with id <id>.`.

#### Token effect

Recall scales with stored volume and is bounded by `maxRecallResults`; the other results are single fixed lines.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix.

### Tool errors

#### What the model sees

Exactly `Error: invalid fact: expected a non-empty string, got …`, `Error: invalid tags: tags must be non-empty strings`, `Error: invalid id: expected a non-empty string, got …`, and, without a session cwd, `Error: memory tools require a calling agent whose session header carries a workspace cwd`.

#### Token effect

Only failing calls add these retained tokens.

#### KV Cache effect

Append-only.

## Known Limitations and Deferred Work

- **Scope is the session-header cwd verbatim** — no realpath normalization; different spellings of one directory count as two workspaces.
- **No user-facing command** — there is no `/remember`; humans ask the model to store facts through ordinary conversation.
- **The recall cap bounds only tool output** — the underlying provider still evaluates the complete match set.
