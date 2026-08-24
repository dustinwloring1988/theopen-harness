# Memory

English | [中文](memory.zh.md)

The cross-session fact memory seam — a [capability seam](../../docs/glossary.md#capability-seam) that splits "record a fact, find it again later (possibly in another session)" across three roles: Service Definition ([toh-memory](../../packages/memory/memory), `ctx.memory`, the provider registry and selection), Service Provider ([toh-memory-local](../../packages/memory/memory-local), workspace-scoped rows in the `memory` domain opened over `ctx.storageDomain`), and Consumer ([toh-tool-memory](../../packages/memory/tool-memory), the model-facing `memory_remember` / `memory_recall` / `memory_forget` tools with their prompt guidance). Memory is an **optional capability**, not part of the agent-loop spine; no shipped bundle mounts it by default. Full-text search of conversation transcripts belongs to [session-query](../../packages/session-query/session-query), which searches transcripts, not curated facts.

Source: [`packages/memory/memory/src/types.ts`](../../packages/memory/memory/src/types.ts)

## Facts

```ts type-equiv
/** One durably stored fact. */
interface MemoryFact {
  /** Provider-minted durable identifier. */
  readonly id: MemoryFactId
  /** The stored statement, verbatim. */
  readonly text: string
  /** Caller-supplied routing labels, verbatim and order-preserving; possibly empty. */
  readonly tags: readonly string[]
  /**
   * Storage scope the fact belongs to. The local provider uses the workspace
   * canonical cwd; recall narrows by this value through {@link RecallOptions}.
   */
  readonly scope: string
  /** Creation time as epoch milliseconds. */
  readonly createdAt: number
}
```

`MemoryFactId` is a [branded](core.md#branded-ids) opaque string: providers mint it at remember time, and consumers treat it as the `forget` handle without parsing its content.

## Write, read, delete

`ctx.memory.remember(input)` persists the full text verbatim and returns the committed fact; blank text is rejected by the registry. Each commit emits exactly one `memory/changed` (operation, provider name, fact id) after durability; failed writes and missed deletions emit nothing. `recall(query, options)` requires the caller's workspace scope at the registry, then narrows by `scope` equality plus an optional `tags` conjunction before the provider's matcher runs; `forget({ id, scope })` removes exactly the addressed row inside that scope — an unknown id or an id stored under another workspace is a definite `false` — and reports whether it removed anything.

## Providers

A provider owns the medium and the matching semantics. `memory-local` stores rows in the `facts` table of the `memory` domain keyed by UUIDs and recalls through case-insensitive keyword-subset conjunction ordered newest-first. An embeddings provider can implement the same three-operation contract without changing the seam.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmemory--memoryregistry"></a>

### `ctx.memory` — `MemoryRegistry`

Provider registry for durable cross-session facts. One instance per context; providers register under unique names and dispose with their fiber. Every operation resolves the serving provider at call time with the selection rules on Config, so composition can add or remove a backend without touching consumers.

```ts cordis-catalog
/**
 * Register a borrowed same-process provider. Duplicate names throw.
 * Fiber disposal unregisters the provider.
 * @param provider - the provider; its `name` is the registry key.
 * @returns the disposer that unregisters the provider.
 */
registerProvider(provider: MemoryProvider): () => void

/**
 * Persist one fact through the selected provider and emit `memory/changed`
 * after the commit. Blank or whitespace-only text is rejected here, in the
 * operation that owns fact semantics, so every provider and consumer shares
 * one rule.
 * @param input - the text, optional tags, and storage scope to persist.
 * @returns the committed fact, including the provider-minted id.
 */
async remember(input: RememberInput): Promise<MemoryFact>

/**
 * Query stored facts through the selected provider. The caller's scope is
 * required here, in the operation that owns fact visibility, so no
 * consumer can read across workspaces regardless of what its provider
 * would tolerate; matching semantics beyond the scope are the provider's,
 * with tag-conjunction narrowing applied before the backend matches.
 * @param query - free-form query text.
 * @param options - the required scope plus optional tag conjunction.
 * @returns the matching facts.
 */
async recall(query: string, options: RecallOptions): Promise<readonly MemoryFact[]>

/**
 * Delete one fact through the selected provider inside the caller's scope.
 * An unknown id — or an id stored under another scope — is a definite
 * `false`; storage faults propagate as themselves.
 * @param input - the fact to delete and the caller's workspace scope.
 * @returns whether a stored fact was removed.
 */
async forget(input: ForgetInput): Promise<boolean>
```

Source: [`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts)

<a id="memory-events"></a>

### `memory/*` events

<a id="memorychanged--emit"></a>

#### `memory/changed` — emit

A stored fact was created or deleted. Emitted once per committed mutation, strictly after the provider acknowledged durability; a failed or no-op mutation emits nothing.

```ts cordis-catalog
/**
 * A stored fact was created or deleted. Emitted once per committed
 * mutation, strictly after the provider acknowledged durability; a failed
 * or no-op mutation emits nothing.
 * @param change - operation discriminant, owning provider name, and the fact id.
 * @mode emit
 */
'memory/changed'(change: MemoryChanged): void
```

Source: [`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts)
<!-- END GENERATED cordis-surface -->
