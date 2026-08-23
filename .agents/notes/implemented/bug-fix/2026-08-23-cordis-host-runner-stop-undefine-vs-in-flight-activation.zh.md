# Agent Note: cordis-host-runner 的 stop／undefine 与进行中的激活串行化

Status: implemented

[English](2026-08-23-cordis-host-runner-stop-undefine-vs-in-flight-activation.md) | 中文

## Problem

在 `cordis-host-runner` 中，`undefine` 与 `stop` 都不会查询进行中的激活映射（`starting`）。当 host 半仍在求值时落下的移除操作，把竞争留给了 `startFresh`——它在多步 await 窗口之后无条件地赋值 `plugin.run`：一个存活 fiber 装载到了已不存在的注册表记录之下。插件的工具仍然对模型可见且可执行，而所有控制面都回答 `plugin-missing`，`cordis/dynamic-retract` 从未发出，唯一的处置路径就是杀掉进程。对称的 stop 变体会在窗口期内回答 `not-running`，然后任由激活照常装载。

## Decision

移除动词现在遵循与新的 run 已有的相同的转换协议（`resolvePlan` 在启动期间拒绝、`activate` 经由 `starting` 去重）：

- 每次 `stop` 与 `undefine` 先递增每插件的停止代数；`stop` 随后在回退存活 run 之前等待进行中的激活承诺。
- `undefine` 在等待之前删除注册表记录，因此并发动词立即观察到移除，且被作废的激活能在失败信息中准确指明是移除。
- `stop` 把进行中的激活视为可停止的对象，而不是回答 `not-running`，并把拆除限定在自己的代数之内：在该代数被赋值之后发布的 run 属于它自己更新的激活，会原样存活，因此停在缓慢 fiber 释放中的 stop 既不能回退、也不能标记为已停止那期间启动的 run。
- `startFresh` 在进入时捕获代数，并在发布前的每一次 await 之后重新校验归属。失去归属时，它丢弃 handler、释放 host 半 fiber，并返回指明原因的失败（“removed/stopped during activation”），而不是发布。

公开方法集合、回执与 wire 形状均未改变。

## Alternatives considered

**把每个变更串成每插件 FIFO 队列。** 否决：代数捕获加等待以更少的机制提供同样的串行化；队列还会让无关动词排在一个缓慢激活的后面。

**移除时直接 reject 进行中的承诺。** 否决：在求值中途中止会泄漏 vm 与 fiber 状态；让 `startHost` 完成结算并丢弃结果，使每次 run 的处置点保持唯一并归 `startFresh` 所有。

**只等待而不重新校验归属。** 否决其作为唯一防线：一次新激活可能滑入并发 retract 窗口的 await 之中，所以发布需要自己的 await 后检查来封闭所有 await 窗口。

## Verification

`tests/runner.spec.ts` 把一个带闸门的 host 半停在 `tools/change` 上（通过包标签 console 观察到就绪），分别与 `undefine` 和 `stop` 竞争。两者都断言被提供的 service 随被丢弃的 fiber 一同回退、inventory 为空、零播报、准确的失败消息，以及——对 stop 而言——随后的正常 run 依然成功。第三个竞争让 `stop` 停在旧 run 的异步 fiber 释放里，同时同一插件的第二个 Package 跑到完成：新 run 保住自己的 service、尝试状态与 handler，且只有旧 run 被回退。三个测试对修复前源码都会失败。`tests/loader-composition.spec.ts` 经由真实的 `cordis.yml` Loader 组合（含工具注册表）引导本包，并端到端演练公开的 run 与移除流程。包套件通过；oxlint 与 `tsc -b` 干净。

## Consequences

与移除竞争的激活永远不可能发布到已移除或已停止的记录上，因此孤儿装载的死路消失，模型看到的是一条可行动的失败而不是幻影运行中的插件。在启动期间停止现在报告成功，而以前声称没有任何东西在运行。代价是为代数映射维护每插件 O(1) 的簿记，undefine 时回收。
