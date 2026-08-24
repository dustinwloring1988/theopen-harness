# Agent Note：跨会话事实记忆 seam（memory/memory-local/tool-memory）

Status: implemented

[English](2026-08-23-cross-session-memory-seam.md) | 中文

## 问题

Harness 缺少让 agent 在同一 workspace 内跨会话记录并召回事实的途径。所有跨运行通道要么非结构化（工作树中的文件——`tool-ralph` 把这一替代品硬编码进了模型指令），要么局限于单个会话（会话日志；`session-query-sqlite` 检索的是转录而非人工策展的事实）。Issue #64 要求按 Service Definition / Provider / Consumer 模式新增 `ctx.memory` 能力组：先做关键词召回，经既有域存储设施持久化，零 loop 改动。

## 决策

在新的 `packages/memory/` 组下设三个包：

- **`toh-memory`** 拥有 seam：合并式提供方映射加执行期选择，规则复制自 `ctx.web`（配置的 id 必须已注册；否则恰好一个注册提供方时自动选中；零个或多个直接报错），而不是 `ctx.skills` 那套 scope 分层机制——因为事实是分区数据而非合并视图，两个存储就是脑裂，多提供方歧义属于配置错误而非优先级问题。注册表亲自拒绝空白文本，并在 recall 与 forget 上要求调用方工作区 scope，任何直接或替代调用方都无法跨工作区读取、也无法删除自身 scope 之外的事实而不论提供方的容忍度（所有提供方与消费者共享同一条规则），并在每次已提交变更后发出一条 `memory/changed`。
- **`toh-memory-local`** 是首个提供方：经 `ctx.storageDomain.open(memoryDomainSpec)` 打开 `memory` 域，把行写入其 `facts` 表（workspace/message-feedback 已验证的模式），以品牌化 UUID 为键、以调用方规范 workspace cwd 为 scope；召回是大小写不敏感的关键词子集合取，先按 scope 与 tag 收窄，最新优先。寻址到其他 scope 的 forget 视同未知 id。嵌入向量提供方可以替换匹配语义而无需改动 seam。
- **`toh-tool-memory`** 在 `ctx.tools` 上注册 `memory_remember` / `memory_recall` / `memory_forget`，外加固定的 `tool:memory` 提示词段（order 113）。事实按调用 agent 会话头 cwd 划分 scope；没有 cwd 的调用直接报错而非静默取默认。渲染意图（`execute`/`search`/`delete`）与结果模板一次定死；配置经显式的 resolve 步骤一次性解析为规约（`maxRecallResults`，默认 20），注册与执行读取同一份结果，让模型可见的界限保持可部署调谐而不触碰提供方。

组合保持 opt-in：任何随发行束都不挂载这三行。目标的三行插入（在已有 storage-domain + 后端之上挂 memory → memory-local → tool-memory）写在包 README 与 PR 描述里。

## 影响

- Agent 获得一条持久、按 workspace 划分、模型可控的记忆通道，跨会话存续且不必把文件写进工作树。
- capability-seams 文档新增 `ctx.memory` 行；cordis 目录在 `docs/subsystems/memory.md` 上生成新区域；工具目录启动 `tool-memory`；module-graph 经 peerDependencies 自动收录该组。
- `toh-storage-sqlite`（#41）获得一个正当的未来消费者：把 `memory` 域路由到 SQLite 只需改 storage-domain 路由，本处代码不动。
- 对既有部署而言什么都没变；只有 overlay 挂载了这些行的组合才会在转录里看到这些工具。

## 备选方案

- **skills 式分层注册表** —— 否决：层与 rank 解决的是目录重名遮蔽，而记忆需要每个 workspace 一个权威存储；这里的契约是选择语义，不是遮蔽。
- **把事实记成 session 事件** —— 否决：跨会话事实必须独立于单个会话在日志轮转/压缩后存续，且必须能在不重写历史的前提下删除；域存储形态正是为这类非会话持久状态而生。
- **把三件套挂进 `packages/bundle/base`** —— 暂缓：新的模型可见工具会改变所有随发行转录与快照夹具；先以 opt-in 发布让本 PR 保持纯增量，之后再翻转 base 行也只是每行一处的改动。
