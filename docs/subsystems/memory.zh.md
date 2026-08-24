# Memory

[English](memory.md) | 中文

跨会话事实记忆 seam —— 一个[能力 seam](../glossary.zh.md#capability-seam)，把"记录一条事实、稍后（可能在另一个会话里）找回来"拆分为三个角色：Service Definition（[toh-memory](../../packages/memory/memory)，`ctx.memory`，提供方注册表与选择）、Service Provider（[toh-memory-local](../../packages/memory/memory-local)，经 `ctx.storageDomain` 打开的 `memory` 域中的 workspace 划分行），以及 Consumer（[toh-tool-memory](../../packages/memory/tool-memory)，面向模型的 `memory_remember` / `memory_recall` / `memory_forget` 与提示词指引）。记忆是**可选能力**，不属于 agent-loop 主干；任何随发行束默认都不挂载它。会话日志的全文检索属于 [session-query](../../packages/session-query/session-query)，它检索的是转录而非人工策展的事实。

Source: [`packages/memory/memory/src/types.ts`](../../packages/memory/memory/src/types.ts)

## 事实

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

`MemoryFactId` 是一个[品牌化](core.zh.md#branded-ids)的不透明字符串：提供方在 remember 时铸造，消费者把它当作 `forget` 的句柄而不解析其内容。

## 写入、读取、删除

`ctx.memory.remember(input)` 持久化完整文本并返回已提交的事实；空白文本由注册表直接拒绝。每次提交成功后发出一次 `memory/changed`（携带操作、提供方名与事实 id）；失败或未命中的删除不产生事件。`recall(query, options)` 在注册表处要求调用方的工作区 scope，随后按 `scope` 等值和可选的 `tags` 合取收窄，再交给提供方匹配；`forget({ id, scope })` 只删除该 scope 内被寻址的那一行——未知 id 或属于其他工作区的 id 一律得到明确的 `false`——并报告是否真的删除了内容。

## 提供方

提供方拥有介质与召回语义。`memory-local` 把行存进 `memory` 域的 `facts` 表，以 UUID 为键；召回按空白切分小写关键词做子集合取，结果最新优先。嵌入向量提供方可以实现同一个三操作契约而无需改动 seam。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
