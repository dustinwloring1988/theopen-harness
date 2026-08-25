# Agent Note: e2e 网关槽位坍缩与过期通道修复

Status: implemented

[English](2026-08-25-e2e-gateway-collapse-fixes.md) | 中文

## Problem

把所有真实 API 套件路由到同一个网关模型（CI 的规范形态：三个 `DEEPSEEK_E2E_MODEL_*` 槽位解析为同一 id）后，2026-08-22 提供方记录遗留的四条通道失效。随附示例组合按槽位各输出一行目录，槽位完全坍缩时 DeepSeek 适配器收到三行同 id 目录，其 fail-loud 重复检查拒绝整个插件树——所有启动 `examples/acp-agent` 或 `examples/headless-agent` 的带密钥冒烟在加载即死。pi-ai 孪生套件只覆盖 `baseURL` 未声明 models，而未知 id 在该适配器上不可路由，其全部网关场景以 `UNKNOWN_MODEL` 告终。Codex 桥拒绝为官方端点之外的任何上游翻译，其 Responses 通道在网关密钥下 502。另有五处 portal 组件依赖 `createPortal` 的推断返回类型，Wine 盘符布局分裂 React 类型身份时声明产出无法可移植地命名（`TS2883`），阻塞的 Windows 任务变红；Web 组合新增 `web_fetch` 后未重新生成组合图谱与 preset e2e 的期望工具表；acp-demo built-bin 冒烟解析 `@agentclientprotocol/sdk/package.json`，而 SDK exports 并不暴露该子路径。

## Decision

槽位坍缩在读槽位处归一，而非适配器内：两个示例组合通过 `!!js` 表达式构建目录行，按 id 去重并对图片能力取并集，坍缩部署得到一行，而无环境启动解析出的列表与之前逐字节一致。pi-ai e2e harness 在网关模式下把槽位声明为手写模型（裸 id 即可获得可用默认值；公开端点继续由安装目录提供服务，effort 场景断言的正是其推理元数据）。其推理控制场景——包括显式 `off`，在非推理槽位上无可关闭且在提供方 I/O 之前被拒——移入仅公开端点的 describe。Codex 桥转发到 `DEEPSEEK_BASE_URL` 所指端点并使用解析后的 flash 槽位，Responses 通道由此跑在任何 completions 网关上；Claude Code 通道在非官方端点仍自跳过：Claude CLI 以 Anthropic Messages 讲到 DeepSeek 的 `/anthropic` 面，没有网关承载它。

五个 portal 组件（`Modal`、`Toast`、`OnboardingSurface`、`DropOverlay`、`ImageLightbox`）携带显式返回注解，其声明不再依赖跨 React 类型身份的推断。built-bin 消费方改为解析每个包入口再向上走到所属 `package.json` 来链接依赖。compaction harness 的小测试目录改为按解析后的 flash 槽位而非字面 id 取键；重生成的组合图谱与 preset e2e 的工具表现在包含 `web_fetch`。

## Alternatives considered

把适配器的重复 id 检查放松为静默合并被否决：两行静态配置同名不同能力是歧义配置，加载时 fail-loud 仍是仓库契约；坍缩是环境的属性，读取环境的组合负责归一。让 Claude CLI 走网关被否决：需要当前没有网关提供的 Anthropic-Messages 门面。让服务层接受非推理槽位上的 `off` 被否决：该拒绝是 `toh-llm` 规格断言过的 `UNSUPPORTED_REASONING_EFFORT` 行为，且省略 effort 产生逐字节相同的线上请求。

## Consequences

整条带密钥通道如今可在单一网关模型下完成启动与应答，而 CI 正是这样运行它的。网关范围依旧由构造保持诚实：纯文本生成端到端证明被路由模型，推理控制则钉在它们探测的扩展所在的端点。Windows 阻塞任务在 Wine 路径身份下恢复编译。2026-08-22 提供方记录中的 codex subagent 结论被部分取代——其桥现跟随共享槽位，而 Claude Code 仍需自己的提供方。
