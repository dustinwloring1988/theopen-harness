# @buckeyestudio/toh-memory

English | [中文](README.zh.md)

The Service Definition of `ctx.memory`: the provider registry for cross-session fact memory. Providers own where facts live and how queries match; this service owns the merge-extensible provider map, execution-time selection, blank-text rejection, and the `memory/changed` event emitted after each committed mutation.

Requires `@buckeyestudio/toh-invariants` (the invariant companion).

## Provider registration

`registerProvider(provider)` files one borrowed same-process provider under a unique name and returns the disposer; fiber disposal unregisters it. Duplicate names throw. A provider implements three operations: `remember(input)` (persists and returns a fact with a provider-minted id), `recall(query, options)` (the registry passes the caller's workspace scope plus an optional tag conjunction; the provider narrows by scope equality before its own matching runs), and `forget(input)` (removes exactly that fact inside the addressed scope — an id stored under another scope counts as unknown — and reports whether it existed).

## Execution-time selection

The same rules as `ctx.web`; registration order never decides:

- A configured `provider` that is registered → that provider.
- A configured `provider` that is not registered → fail loud.
- No configuration with exactly one registered provider → auto-select it.
- No configuration with zero or several registered providers → fail loud (the error lists the candidates).

## Config

| Key | Default | Meaning |
|---|---|---|
| `provider` | — | Explicit provider id; omitted, selection requires exactly one registered provider. |

## Model Experience

Indirectly, through `@buckeyestudio/toh-tool-memory`, which renders stored facts; the seam registers no prompt, schema, or result of its own.

#### KV Cache effect

No direct effect; request-prefix changes belong to the consuming tool.

## Known Limitations and Deferred Work

- **One active store** — selection treats several registered providers as misconfiguration; partitioned multi-store routing (per scope) waits for a real consumer.
- **Recall ordering is a provider contract** — the seam documents newest-first as convention, not guarantee; an embeddings provider must declare its own ordering in its README.
