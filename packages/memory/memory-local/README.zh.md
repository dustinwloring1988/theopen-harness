# @buckeyestudio/toh-memory-local

[English](README.md) | 中文

[`@buckeyestudio/toh-memory`](../memory) seam 的**存储域**实现。以 `local` 之名注册到 `ctx.memory`，通过 `ctx.storageDomain.open(memoryDomainSpec)` 把事实持久化为 `memory` 域 `facts` 表中的行；召回是关键词子集合取（大小写不敏感），可按 scope 与 tag 收窄。

要求 `ctx.memory` 与 `ctx.storageDomain`（`inject: ['memory', 'storageDomain']`）。

## 存储布局

一行一个事实：`{ scope, text, tags, createdAt }`，以提供方铸造的 UUID（`MemoryFactId`）为键。zod schema 在域打开时校验每一行，损坏的行让打开直接失败（`invalid-record`）。事实按 scope 分区——本地部署用调用会话的规范 cwd，因此同一后端可以安全服务多个 workspace。

## 召回语义

- 查询按空白切分为小写关键词；每条候选文本必须包含全部关键词。
- `options.scope`（注册表要求必填）要求精确等值；`options.tags` 要求候选携带全部列出的标签。
- 结果按 `createdAt` 最新优先，id 决胜保证全序稳定。
- `forget` 仅在存储行的 scope 与调用方 scope 等值时删除；其余 id 一律报告为不存在，行保持原样。

## Config

无。哪个后端服务 `memory` 域由 `@buckeyestudio/toh-storage-domain` 的路由配置决定；发行 JSON 后端时在组合里声明其存储根目录。

## Model Experience

间接：经由 `@buckeyestudio/toh-tool-memory` 渲染召回的事实与 id。

#### KV Cache effect

不产生直接影响；可见请求前缀的变化由该消费工具负责。

## Known Limitations and Deferred Work

- **仅关键词匹配** — 无分词、词干化或排名；嵌入向量召回是计划中的第二个提供方，无需改动 seam 契约。
- **无保留/清理策略** — 事实无限期存留；删除只能经 `memory_forget` 或外部清空该域。
- **行数无上限** — 大量事实会让"列出全部"式召回变得昂贵且受工具端结果上限约束。
