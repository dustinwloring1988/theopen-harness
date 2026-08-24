# Agent Note: A turn-budget policy on the existing stop boundary

Status: implemented

[English](2026-08-23-turn-budget-policy.md) | 中文

## Problem

没有任何东西约束单个 agent 轮次的长度。工具调用与 steering 会让当前轮次无限延续，而 agent loop 把这一点记录为已知非特性：约束失控轮次的策略必须从既有生命周期扩展点执行取消。暴露集中在无头场景——`pnpm toh --profile headless` 一次性任务、ACP server、SDK `run()` 消费方与 tool-ralph 轮次都在无人值守下运行，一个卡住的轮次会烧掉 token，直到外部杀掉进程。该空间里唯一的行为 guard——repeat-tool-reminder——只在*完全相同*的连续调用上升级，并在用户插话时重置；改变循环方式的模型可以完全绕开它。全仓库范围内只有 Claude Code 与 Codex hook 桥接监听 `agent/turn-stopping`，且都不做任何约束。

## Decision

- **新的 opt-in guard 包 `@buckeyestudio/toh-turn-budget-policy` 拥有轮次预算。** 它注册一个串行 `agent/turn-stopping` 监听器加一个纯委派的 `agent/pre-step` 记账监听器，不改动 `packages/core/agent-loop` 的任何代码。发行 base bundle 以禁用状态挂载它（`disabled: true`，跟随 skill-badge 先例）；启用它是带显式上限的显式 overlay 行。
- **两段式升级，如 guard 家族一样建议先行。** 在关闭尝试处越过 `warnAtSteps` 时，策略每轮恰好一次通过 `agent.steer(...)`（携带 `notice` form 的插件来源）送出收尾请求，给模型一次有边界的落地机会。触及硬限——`maxStepsPerTurn` 或 `maxTurnTokens`——时，调用 `agent.cancel({ kind: 'hook', reason }, { keepInbox: true })`，为后续轮次保留排队中的收件箱工作。
- **状态只从权威来源推导。** 步数折叠最近一条 `turn/start` 之后的 `step/start` 日志记录；token 支出对本轮打开期间每条已记录请求在 `assistant/message` 上报的 usage 求和。状态保存在按 turn 号键控的 per-agent `WeakMap` 中，每个新轮次从零开始，释放时无需监听器即被回收。
- **配置在加载时大声失败**：未配置任何上限、出现非正数或小数值、或 `warnAtSteps >= maxStepsPerTurn`，都会在插件加载时抛错。
- **持久日志证明顺序契约。** 包不变式伴随程序在会话事件流上断言：wrap-up 提示在一个打开轮次内至多出现一次、也绝不落在轮次之外。因此「建议先于取消」仅在告警已配置且先被触及时成立：硬限检查先于可选的告警分支执行，低于 `warnAtSteps` 的 token 触发——或未配置任何告警臂的纯 token 配置——会在没有任何建议的情况下取消轮次。

## Alternatives considered

- **在 agent loop 内部加步数计数器** — 同时覆盖从不尝试关闭的轮次，但它为一个 guard 能表达的能力改动了循环状态机；loop README 已把 `agent/turn-stopping` 列为预期归宿，而循环改动还要求架构文档与两套 SDK 投影输出同步。为保持循环不变而拒绝。
- **从 tools/post-execute 监听器取消** — 即使没有关闭尝试也会在运行中途触发，但它把单次调用卫生与轮次生命周期混在一起，无法干净地看到整轮支出，还会与工具 waterfall 的决策语义竞速。拒绝。
- **墙钟预算** — 缓慢的模型不是循环的模型；请求级与工具级超时已经负责延迟。作为本策略不应重复的另一条轴而拒绝。

## Consequences

强制执行只发生在关闭尝试上：每一步都以更多工具调用结束的轮次在运行中途到不了边界，因此一个永远流式输出工具调用、从不尝试关闭的模型在外部失败（提供方或传输层）之前不受约束。这个残余缺口被接受，因为约束它需要改动循环，而真实的失控暴露（hook 强制续跑、躲避收尾的模型）恰恰汇聚在这些关闭尝试上。适配器未上报 usage 的请求对 `maxTurnTokens` 零贡献；完全由这类提供方服务的轮次只有在配置了 `maxStepsPerTurn` 时才仅受步数臂约束，纯 token 配置下则不受任何约束。换来的是：无头部署得到经校验、由组合拥有的上限；当告警已配置且先被触及时，模型保留一次真正的收尾机会，且仅凭会话日志即可证明该提示先于取消；排队工作在硬取消后幸存。

## Testing

包单元测试用脚本化 mock adapter 驱动真实 agent loop 穿过策略：取消顺序、单次 steer 闩锁、按轮重置、按请求 usage 触发 token 上限、以及大声的配置校验；不变式套件通过 `Session.append` 拒绝重复提示与孤儿提示。无密钥 ACP 快照场景 `turn-budget-policy` 把一段五步脚本化转录穿过组装好的 example 组合进行回放，并在转录与日志中钉住建议提示、被强制的步骤与 `aborted`/`hook` 关闭。
