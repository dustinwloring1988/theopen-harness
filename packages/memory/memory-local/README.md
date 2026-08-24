# @buckeyestudio/toh-memory-local

English | [中文](README.zh.md)

The **storage-domain** implementation of the [`@buckeyestudio/toh-memory`](../memory) seam. Registers as `local` on `ctx.memory` and persists facts as rows of the `facts` table in the `memory` domain opened through `ctx.storageDomain.open(memoryDomainSpec)`; recall is a case-insensitive keyword-subset conjunction narrowed by scope and tags.

Requires `ctx.memory` and `ctx.storageDomain` (`inject: ['memory', 'storageDomain']`).

## Storage layout

One row per fact: `{ scope, text, tags, createdAt }`, keyed by a provider-minted UUID (`MemoryFactId`). The zod schema validates every stored row when the domain opens, so corrupted rows fail the open loud (`invalid-record`). Facts partition by `scope` — the calling session's canonical cwd for local deployments — so one backend safely serves several workspaces.

## Recall semantics

- The query splits on whitespace into lowercase keywords; every candidate's text must contain all of them.
- `options.scope` (required by the registry) requires exact equality; `options.tags` requires the candidate to carry every listed tag.
- Results order newest-first by `createdAt`, tie-broken by id for a total stable order.
- `forget` deletes only when the stored row's scope equals the caller's; any other id is reported as absent and the row survives.

## Config

None. Which backend serves the `memory` domain is decided by `@buckeyestudio/toh-storage-domain` routing; compositions shipping the JSON backend declare its storage root there.

## Model Experience

Indirectly, through `@buckeyestudio/toh-tool-memory`, which renders recalled facts and ids.

#### KV Cache effect

No direct effect; request-prefix changes belong to the consuming tool.

## Known Limitations and Deferred Work

- **Keyword matching only** — no tokenization, stemming, or ranking; an embeddings-based provider is the intended second implementation and needs no seam change.
- **No retention or cleanup policy** — facts persist indefinitely; deletion happens only through `memory_forget` or externally clearing the domain.
- **Unbounded row count** — many facts make list-style recall expensive and subject to the tool-side result cap.
