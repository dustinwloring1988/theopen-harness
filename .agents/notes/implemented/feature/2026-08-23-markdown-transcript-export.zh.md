# Agent Note: 原始 ZIP 之外的浏览器侧 Markdown 转写导出

Status: implemented

[English](2026-08-23-markdown-transcript-export.md) | 中文

## Problem

`/export` 此前只产出原始日志工件的 ZIP（逐字的 JSONL/zstd 字节、子代理日志、媒体）。归档忠实但不可读：在 Web UI 之外阅读会话需要额外工具。需要一种可读的转写格式，同时不改变原始 ZIP 路径、不引入模型可见行为、不产生 token 成本。

## Decision

Web `/export` 语法增加 `md` 变体，Session Header 在 `Session log` 旁新增第二个按钮；两条入口路径共用既有的下载控制器与弹窗。Markdown 转写文稿完全在浏览器侧从客户端已组装的最终会话节点序列化（`ctx.sessions.binding(id).session.getSnapshot().nodes`，在操作时读取，渲染路径不会因此订阅会话变化）。文档采用说话人小节（`## User`、`## Steering`、`## Assistant (turn N)`）、带紧凑围栏摘要与有界摘录的工具调用及结果、省略推理块、跳过上下文注入，并为命令行、压缩检查点、重试、轮次失败和未知条目渲染标注。正文经过转义以防止结构注入（标题、引用块、分隔线、围栏），逐字围栏会增长到超过其内部任何行首反引号串，摘录上限 600 字符并带显式截断标记。

序列化位于 `@buckeyestudio/toh-session-log-export`（`src/client/transcript.ts`），因为该包已拥有两个导出入口、控制器和弹窗；没有新增包、路由或 Host 端点。原始 ZIP 路径逐字节保持不变。

## Alternatives considered

- **基于 `sessionQuery.readSurface()` 的有界 Remote 动词。** 可获得权威的完整表层保真度，包括遮蔽历史的解析与超出客户端窗口的完整日志。暂不采纳：它需要生成 `/remote` 工件、Host 接线，以及为当前仅是展示特性的功能新建 wire 契约；客户端已组装节点覆盖了执行导出的标签页实际可见的对话。当超出已加载窗口的转写保真度成为真实需求时再重新评估。
- **自包含 HTML 变体。** 单文件内更丰富的渲染（可折叠推理、样式）。延后：更大的表面积（模板安全、重复的转义策略）且当前无消费需求；Markdown 加上既有安全 GFM 渲染器已覆盖可读转写需求。
- **Host 侧序列化并入 ZIP。** 单一工件、Host 权威文本。否决：会把展示格式化耦合进 ApiProxy 工件平面，强迫每个 ZIP 消费者接受格式选择，并且仍需在服务端复制同一套转义逻辑。

## Consequences

- 长会话的转写文稿反映客户端已加载的事件窗口；未翻页加载的历史缺席，也不包含子 Session。该限制记录在包 README 中而非被隐藏。
- 模型可见效果与 token 效果均为零：命令生命周期仍仅入日志，序列化只读取已发布的 UI 状态。
- 转义经过对抗性测试（标题/引用/分隔线/围栏注入、围栏长度升级、摘录边界），转写内容无法重构文档结构。
- Web UI 黄金文件发生变化（多出一个 Header 按钮）；通过无密钥快照工具刷新。
