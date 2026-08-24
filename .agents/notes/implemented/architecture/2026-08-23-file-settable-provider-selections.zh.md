# Agent Note: The two provider selections a discovered .env may set

Status: implemented

[English](2026-08-23-file-settable-provider-selections.md) | 中文

## Problem

[配置源所有权决策](2026-08-04-configuration-source-ownership.zh.md)禁止被发现的文件设置整个 `TOH_*` 命名空间，拒绝启动正是该禁令的生效方式。web seam 文档声明 `TOH_WEB_SEARCH_PROVIDER`／`TOH_WEB_FETCH_PROVIDER` 可通过分层启动环境快照解析并支持项目／用户 `.env` 参与（[issue #52](https://github.com/dustinwloring1988/theopen-harness/issues/52)），这把两个已写入文档的名称放进了被禁止的命名空间：按文档路径操作时，启动会以一条指出该变量的诊断中止，而不是选中请求的提供方。

## Decision

`loadLayeredEnv` 接受且仅接受这两个名称来自任一被发现文件（不区分大小写），并在校验、物化与快照之前把任何大小写变体折叠到其规范的 `TOH_*` 拼写上；所有权决策中的其他规则全部保持不变。二者合格的原因是：它们只在挂载组合已注册的 web 提供方之间做选择——检出目录可以选择由哪个已注册的搜索或抓取提供方处理其调用，但仍然无法新增提供方、重指其端点、更改审批策略，或改变进程如何启动、指令从何处加载、网络如何到达与信任。该例外在折叠后仍按确切名称匹配，因此新的 `TOH_*` 开关在被拒绝状态保持不变，直到某次变更为自身论证。

## Alternatives considered

**保留禁令并将这两个名称记录为仅可经 shell 导出。** 否决：它放弃了 issue #52 的解决方案，使 web 包 README 的 `.env` 声明失实，并把一个操作性选择挡在用户存放每项目偏好的位置之外。

**对 `TOH_*` 开关做一般性的白名单审计。** 因所有权备注中的理由再次否决：名单需要在每个新开关出现时重新审计，而遗忘时的失败是静默的。绑定到单一消费方契约的两个确切名称避开了这两种失败模式。

**把 bootstrap-only 名称排在 process 层之下而不拒绝。** [所有权决策](2026-08-04-configuration-source-ownership.zh.md)已经否决：用户认为已生效的值绝不能被静默忽略。

## Consequences

- 选择 `TOH_WEB_SEARCH_PROVIDER`／`TOH_WEB_FETCH_PROVIDER` 的项目或 harness home `.env` 会经冻结快照解析并携带层归属、物化进 `process.env`，且优先级低于显式 `searchProvider`／`fetchProvider` 配置。小写拼写会以规范名称存储，因此在区分大小写的平台上同样能经快照解析。
- 任一文件中的其他任何 `TOH_*`、`XDG_*`、`DYLD_*` 或 `BASH_FUNC_*` 名称仍会在应用任何值之前中止启动；测试同时固定了带层归属的接受路径（包括小写拼写的端到端解析）与无关开关的拒绝路径。
