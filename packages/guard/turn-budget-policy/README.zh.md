# @buckeyestudio/toh-turn-budget-policy

[English](README.md) | 中文

一个防失控轮次的预算策略，而非循环本身的改动：它完全落在文档化的 `agent/turn-stopping` 扩展点上，只增加两种行为——在配置的建议步数处，它会通过 steering 送出一条收尾请求，让模型获得恰好一次有边界的落地本轮的机会；超过硬性步数或 token 限制时，它会以 `hook` 原因取消当前轮次。无头自动化（`pnpm toh --profile headless`、ACP server、SDK `run()` 消费方、tool-ralph 轮次）否则会让工具调用与 steering 无限延长单轮；本策略把「上限」变成经过校验的组合选项，而不是外部强杀开关。agent-loop 自身的非特性说明（[agent-loop README](../../core/agent-loop/README.zh.md)）正是把该扩展点列为这类策略的预期归宿。

## Config

```yaml
- id: turn-budget-policy
  name: '@buckeyestudio/toh-turn-budget-policy'
  config:
    warnAtSteps: 20        # advisory: steer one wrap-up request at this step count
    maxStepsPerTurn: 24    # hard: cancel the turn at this step count
    maxTurnTokens: 200000  # hard: cancel when per-turn token spend reaches this
```

配置在插件加载时大声失败：空配置抛错，每个出现的值必须是 >= 1 的整数，两者同时设置时 `warnAtSteps` 必须严格小于 `maxStepsPerTurn`（建议必须先于取消），且 `maxTurnTokens` 要求已挂载 token-meter 服务（`@buckeyestudio/toh-token-meter`）。没有默认值：每项上限都是部署选择，这也是发行 bundle 行默认禁用的原因。按 agent 的覆盖通过在该 agent 的作用域上下文上挂载本插件并给出不同限制实现——每份注册只拥有自己的监听器，从不观察其他 agent。

## Enforcement point

`agent/turn-stopping` 在轮次*原本即将完成*地关闭之前运行：模型没有存活的工具调用，也没有新的 steering 待处理。如果一轮的每个步骤都以更多工具调用结束，它从不尝试关闭，因此运行中途永远不会到达该边界；强制执行落在每一次关闭尝试上——而这正是失控轮次真正的归宿：要么模型最终试图停止，要么 Stop-hook 桥接在同一边界不断强制续跑。约束住关闭尝试就约束住了轮次；残余缺口（模型永远流式输出工具调用而从不尝试关闭）是已知限制。

- **步数从会话日志折叠。** 在每次关闭尝试时，监听器统计自最近一条 `turn/start` 以来的 `step/start` 记录数，因此计数如实反映持久日志中本轮的开销——包括更早 steering 强制出来的步骤。
- **Token 支出读取 `ctx.tokenMeter`。** 一轮的第一个 `agent/pre-step` 会在该轮花费任何内容之前对 `measure(session).totalTokens` 做基线快照；每次关闭尝试将当前总量与基线相减。meter 以完整启发式锚点为提供方 usage 定价，因此差值在两个方向上都偏保守。
- **硬限 → 取消。** `agent.cancel({ kind: 'hook', reason }, { keepInbox: true })` 中止活动轮次，同时保留排队与 steering 收件箱；持久的 `turn/end` 记录 `aborted`/`hook` 原因，原因字符串携带观测数值。
- **建议线 → 每轮一次 steer。** 越过 `warnAtSteps` 后，策略每轮调用恰好一次 `agent.steer(...)`；机器重读收件箱并再跑一步。按 turn id 键控的闩锁保证第二次关闭尝试不会再被引导——若模型把机会花在了又一次工具调用上，下一次关闭尝试就会撞上硬限。
- **按轮重置。** 状态按存活 agent 对象与 turn 号键控：后续轮次从零步数、全新 token 基线和清空的 steer 闩锁开始。被取消的一轮不会污染下一轮。

## Reminder delivery

收尾提示以普通 steering 传递：一条注入的 `user/message`，来源为 `{kind: 'plugin', plugin: 'turn-budget-policy', form: 'notice'}`，渲染为普通的合成用户消息——对模型可见、带来源归属、无需新增会话事件即可从会话日志重建。取消本身不是面向模型的上下文：轮次只是以 `aborted` 关闭。

## Model Experience

### Wrap-up advisory context message

#### What the model sees

在第一次达到或越过 `warnAtSteps` 的关闭尝试时，该 agent 会收到下面的 steering 消息，其中标注本轮的实际步数。不添加任何工具 schema 或正常请求文本。

##### Wrap-up notice

```markdown
Turn budget advisory: this turn has already run <steps> steps. Wrap the turn up now: give your best available answer instead of starting more tool calls. If the task genuinely cannot progress without more work, say what is blocking it and stop.
```

#### Token effect

建议触发前为零 token。该提示是该 agent 的保留历史，`<steps>` 只是一个小整数，天然有上界；取消不追加任何内容。

#### KV Cache effect

Append-only；新可见内容跟随可复用的请求前缀，不会使既有 KV-cache 条目失效。

## Known Limitations and Deferred Work

- **只在关闭尝试时生效** — 从不停下流式输出工具调用的轮次永远到不了 `agent/turn-stopping`，两条臂在模型尝试关闭前都无法触发；约束这类运行中的轮次需要改动循环本身，而本策略刻意不做。
- **Token 支出依赖启发式锚点** — 没有提供方 usage 报告的会话经由 meter 的估计器定价，因此 `maxTurnTokens` 差值可能与精确计费双向偏离。
- **没有墙钟限制** — 缓慢（而非循环）的模型不在范围内；超时属于请求／工具层。
- **建议可被忽略** — 收尾 steer 是请求而非否决；模型可以忽略一次，这正是硬限随后要执行的。
