# @buckeyestudio/toh-memory

[English](README.md) | 中文

`ctx.memory` 的 Service Definition：跨会话事实记忆的提供方注册表。提供方拥有事实存放在哪里、查询如何匹配；本服务拥有合并式提供方映射、执行期提供方选择、空白文本拒绝，以及每次已提交变更后的 `memory/changed` 事件。

要求 `@buckeyestudio/toh-invariants`（invariant 伴随插件）。

## 提供方注册

`registerProvider(provider)` 按唯一名称登记一个同进程提供方，返回注销 disposer；fiber 销毁时自动注销。重名直接抛错。提供方实现三个操作：`remember(input)`（持久化并返回含提供方铸造 id 的事实）、`recall(query, options)`（先按 scope 等值与 tag 合取收窄，再按自身语义匹配）、`forget(id)`（精确删除并报告是否存在）。

## 执行期选择

与 `ctx.web` 相同的规则，绝不依赖注册顺序：

- 配置了 `provider` 且已注册 → 该提供方；
- 配置了 `provider` 但未注册 → 直接抛错；
- 未配置且恰好注册了一个 → 自动选中；
- 未配置且注册了零个或多个 → 直接抛错（错误列出候选名）。

## Config

| 键 | 默认 | 含义 |
|---|---|---|
| `provider` | （无） | 显式提供方 id；省略时仅在恰好一个提供方注册时自动选择。 |

## Model Experience

间接：经由 `@buckeyestudio/toh-tool-memory` 渲染存储的事实；本 seam 自身不注册任何提示词、schema 或结果。

#### KV Cache effect

不产生直接影响；可见请求前缀的变化由该消费工具负责。

## Known Limitations and Deferred Work

- **单活动存储** — 选择规则把多个已注册提供方视为配置错误；分区式多存储（按 scope 路由到不同后端）留待有真实消费者时再引入。
- **召回排序是提供方私有契约** — seam 只承诺"最新优先"作为惯例而非硬性保证；需要稳定排名的嵌入提供方应在文档中声明自己的顺序。
