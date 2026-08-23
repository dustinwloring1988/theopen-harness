# 为能力 Seam 编写测试与快照

[English](writing-tests-and-snapshots-for-a-seam.md) | 中文

本指南演示如何证明一个新的或变更的[能力 seam](../glossary.zh.md#capability-seam) 按交付预期工作：选定覆盖层级、启动真实组合、添加无密钥快照场景、在本地运行该车道并评审差异。策略见 [testing.md](../testing.zh.md)；本文是操作演练。`packages/shell`（Service Definition `toh-shell`、提供方 `toh-bash-local`/`toh-bash-sandbox`、Consumer `toh-tool-bash`）是参考模板。

## 1. 在实现之前确定层级

每一项非平凡的模型可见、协议可见或人类可见变更都要提前规划覆盖；一个 seam 通常需要全部三个层级：

| 层级 | 证明什么 | 典型对象 |
|---|---|---|
| 单元测试 | 约定逻辑、边界情况、事件顺序 | Service Definition 词汇、提供方行为 |
| 真实组合 | 插件经由真实 Loader 启动并通过其服务应答 | 仅测试用的 `cordis.yml` + app/process |
| 快照 | 组装后的 transcript、协议输出或持久化日志保持预期 | 经由所属套件运行的可运行示例 |

注册表贡献还需要 HMR 安全性证明：对贡献内容的 fiber 执行 dispose，并观察移除。

## 2. 在代码旁编写单元层

测试放在所属包的 `tests/` 目录下。覆盖错误路径、取消、并发竞态和边界值；只 mock 开销高或不确定的边界（模型、网络、时钟），下游一切保持真实。守卫或策略插件只有在回归真的能让它失败时才算数：引入回归、观察变红、回退。

## 3. 启动真实组合

对于产品可见的插件，手动构建的 `ctx.plugin(...)` 套件是不够的。通过 Loader 在 app 或进程中挂载仅测试用的 `cordis.yml`，只 mock 外部服务，断言模型可见的请求／日志内容、持久状态或用户可见输出。复用共享 testkit 而不是重新造轮子：[`toh-acp-snapshot`](../../packages/test-support/acp-snapshot/README.zh.md)（场景工厂）、[`toh-loader-smoke`](../../packages/test-support/loader-smoke/README.zh.md)（真实 Loader 冒烟）和 [`toh-agent-loop-testkit`](../../packages/test-support/agent-loop-testkit/README.zh.md)（循环前置依赖）。

## 4. 添加无密钥快照场景

把场景路由到拥有对应表面的套件：

| 表面 | 拥有者快照 |
|---|---|
| ACP 自动化场景 | `examples/<name>/tests/snapshots/`，基于 [`toh-acp-snapshot`](../../packages/test-support/acp-snapshot/README.zh.md) 工厂（`examples/acp-agent` 为主套件） |
| Headless 规范事件 transcript | `examples/headless-agent`（JSONL driver + 回放 fixture） |
| 已完成的交互式终端旅程 | `apps/cli/tests/snapshots/`（JSONL 驱动场景） |
| 浏览器渲染的 Web GUI 旅程 | `apps/web/tests/snapshots/` |
| TypeScript SDK 循环投影 | `examples/jsonrpc-agent/tests/snapshots/` |
| Python SDK 循环投影 | `scripts/snapshots/python-sdk-single-exe/`（在必需的 `python-runtime` CI 作业中运行） |

一个 ACP 场景（`text-turn`）固定完整的系统提示词／工具 schema 内容；其他 fixture 将其 token 化，因此一次修改只会扰动一行。瞬态呈现使用包内语义矩阵；每当输入处理、Loader 选择或终端清理发生变化时，添加 PTY 用例。两个 SDK 各自独立投影循环，因此循环、会话生命周期和 `SessionEventMap` 的变更要在同一 PR 中更新两个套件。

## 5. 本地过滤运行车道

快照是无密钥的——不需要 API 密钥。迭代时按场景过滤：

```sh
pnpm exec vitest run --config vitest.snapshot.config.ts -t <scenario-name>
pnpm run test:snapshot            # full lane before push
```

PowerShell 没有 env-prefix 形式；直接调用 vitest 时请显式设置变量：

```powershell
$env:TOH_SNAPSHOT = 'record'
pnpm exec vitest run --config vitest.snapshot.config.ts -t <scenario-name>
Remove-Item Env:TOH_SNAPSHOT
```

需要真实 `pwsh` 的场景（如 `pwsh-tool-turn`）在没有 pwsh 的主机上自动跳过；CI 会强制执行。

## 6. 录制与评审

当模型 transcript 有意变化时使用 `pnpm run test:snapshot:record`；当回放输入仍然有效但预期输出移动时使用 `pnpm run test:snapshot:refresh`。逐行评审每处 JSONL 与预期输出差异——快照就是产品约定。fixture 必须能在 macOS/Linux 上回放：修 fixture，而不是 normalizer。

## 验证清单

1. 单元测试覆盖约定边界与 HMR disposer。
2. 一个真实组合测试通过 Loader 启动该 seam。
3. 无密钥场景存在于所属表面的套件中，并在本地过滤与全量运行下均回放为绿。
4. 录制的差异已逐行评审，包括重新持久化的日志。
