# memory/ — 跨会话事实记忆能力系列

[English](README.md) | 中文

本系列让 agent 在同一 workspace 内跨会话持久地记录并召回事实：提供方注册表 seam、基于存储域的本地提供方，以及面向模型的 memory 工具。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`memory/`](memory/README.zh.md) | 定义事实记忆注册表与提供方契约 | `ctx.memory` |
| [`memory-local/`](memory-local/README.zh.md) | 通过域存储设施把事实存为按 workspace 划分的行 | 注册到 `ctx.memory` |
| [`tool-memory/`](tool-memory/README.zh.md) | 向模型暴露 `memory_remember` / `memory_recall` / `memory_forget` | 消费 `ctx.tools`、`ctx.systemPrompt`、`ctx.memory` |

记忆是**可选能力**：任何随发行束默认都不挂载它。请从 profile 或 overlay patch 组合全部三个包（或把 `memory-local` 换成其他提供方）；目标组合行见各包 README。

本 seam 的类型参考见 [docs/subsystems/memory.zh.md](../../docs/subsystems/memory.zh.md)。
