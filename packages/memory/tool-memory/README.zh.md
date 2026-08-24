# @buckeyestudio/toh-tool-memory

[English](README.md) | 中文

面向模型的跨会话记忆工具：`memory_remember`、`memory_recall`、`memory_forget`，外加一段说明何时使用记忆的 system-prompt 指引。事实按调用 agent 会话头中的 workspace cwd 划分 scope；没有会话 cwd 的调用直接报错。

要求 `ctx.tools`、`ctx.memory`、`ctx.systemPrompt`（`inject: ['tools', 'memory', 'systemPrompt']`），并需要一个已注册的 `ctx.memory` 提供方（如 [`@buckeyestudio/toh-memory-local`](../memory-local)）。

## 组合（opt-in）

本包不在任何随发行束中；在 profile 或 overlay patch 里加入三行即可启用：

```yaml
- insert:
    - id: memory
      name: '@buckeyestudio/toh-memory'
    - id: memory-local
      name: '@buckeyestudio/toh-memory-local'
    - id: tool-memory
      name: '@buckeyestudio/toh-tool-memory'
```

`memory-local` 需要 `@buckeyestudio/toh-storage-domain` 及其某个后端（如 `storage-json`）已在组合中。

## 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `memory_remember` | `fact`（必填）、`tags?` | 存一条事实，返回其 id。空白文本与空标签直接报错；标签去空白、去重。 |
| `memory_recall` | `query?`、`tags?`、`limit?` | 关键词合取搜索当前 workspace 的事实；省略 `query` 即列出最新事实。结果上限为 `maxRecallResults` 并带截断标记。 |
| `memory_forget` | `id`（必填） | 按 id 删除；未命中是显式的 `{ forgotten: false }` 而非错误。 |

每次提交式变更都会经 `ctx.memory` 发出 `memory/changed` 事件。

## Config

| 键 | 默认 | 含义 |
|---|---|---|
| `maxRecallResults` | `20` | 单次 `memory_recall` 结果的事实数上限；最小 1。 |

## Model Experience

### 提示词指引

#### What the model sees

工具可见时，模型收到一段固定的 `tool:memory` 指引：把可复用的事实（用户偏好、项目决定、环境怪癖、任务结论）记成短小自洽的句子；在下判断前先检索既有事实；事实在本 conversation 之后仍然存在并在同 workspace 的会话间共享；不要存密钥或临时状态，代码状态的唯一权威仍是工作树。

#### Token effect

每请求固定成本；仅当三个工具都可见时存在。

#### KV Cache effect

前缀稳定；插件生命周期变化才会使该段失效。

### Tool schema

#### What the model sees

模型看到生成的 [memory 工具 schema](../../../docs/tool-catalog.zh.md#buckeyestudiotoh-tool-memory)。

#### Token effect

三个固定 schema 的每请求成本。

#### KV Cache effect

定义与可见性不变时前缀稳定。

### Tool result

#### What the model sees

`memory_remember` 返回一行 `Stored memory <id>.`；`memory_recall` 返回 `<returned> of <total>` 概览加每条一行的 `- <id>: <text> [tags]` 列表（无命中时为 `No stored memories matched.`）；`memory_forget` 返回 `Forgot memory <id>.` 或 `No stored memory with id <id>.`。

#### Token effect

召回结果与存储量成正比且受 `maxRecallResults` 约束；其余为单行固定输出。

#### KV Cache effect

只追加；新内容位于可复用前缀之后。

### Tool errors

#### What the model sees

`Error: invalid fact: expected a non-empty string, got …`、`Error: invalid tags: tags must be non-empty strings`、`Error: invalid id: expected a non-empty string, got …`，以及无会话 cwd 时的 `Error: memory tools require a calling agent whose session header carries a workspace cwd`。

#### Token effect

只有失败调用产生这些保留 token。

#### KV Cache effect

只追加。

## Known Limitations and Deferred Work

- **scope 取自会话头 cwd 原样字符串** — 不做 realpath 规范化；同一目录的不同拼写会被当成两个 workspace。
- **无用户面命令** — 没有 `/remember` 之类的人工入口；人类通过普通对话让模型记录事实。
- **召回上限只作用于工具输出** — 底层提供方仍会完整求值匹配集合。
