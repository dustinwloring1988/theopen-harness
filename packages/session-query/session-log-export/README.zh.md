# @buckeyestudio/toh-session-log-export

[English](README.md) | 中文

Web Session 日志导出控制：包括 `toh-host-apiproxy` 拥有的 Host 流式原始 ZIP，以及在浏览器中组装的人类可读 Markdown 转写文稿。Host 半包注册 `/export`；浏览器半包在 Session Header 中提供两个 111×32 操作（`Session log` 与 `Markdown`）、一个下载控制器，以及一个供这些按钮与斜杠命令共用的弹窗。ZIP 生成、原始 JSONL/zstd 读取、子 Session、附件、背压和 HTTP 错误语义仍由 [ApiProxy 下载实现](../../host/apiproxy/README.zh.md)负责。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/export` | 记录一组用户命令生命周期；提交命令的浏览器收到本地执行确认后，下载 `GET /api/session.export?sessionId=<id>&includeDescendants=true`。 |
| `/export md` | 记录同样的生命周期；提交命令的浏览器把已组装的会话窗口序列化为 Markdown 转写文稿，并通过短命 object URL 保存。 |
| `/export <path>` | 返回错误。浏览器下载通过浏览器的普通下载行为选择目标位置。 |

该命令只由 Web bundle 挂载。只有 `/export` 返回成功时，本地 `command/executed` 确认才会在提交命令的浏览器中触发对应的下载；其他标签页仍会渲染持久命令行，但不会重复执行浏览器副作用。Header 按钮直接调用同一个控制器。两种入口共用并发折叠（每个 Session 同时只允许一项下载，与格式无关）、插件释放时取消、准备阶段错误处理、浏览器保存行为和同一个 Modal；只有 ZIP 路径会发出 `HEAD` 预检。

### Markdown 转写文稿格式

转写文稿在浏览器侧从客户端已持有的最终会话节点（`ctx.sessions.binding(...).session.getSnapshot().nodes`）在操作时序列化；渲染路径不会为它订阅会话变化。文档以 `# Session transcript` 开头，附会话 id、导出时间戳和渲染条目数，随后是说话人小节：`## User`、`## Steering`、`## Assistant (turn N)`；工具请求以 `### Tool call: <name>` 呈现并附带紧凑参数围栏，流级工具结果以 `### Tool result: <name>` 呈现并附带有界输出摘录与直接子调用名；命令行、压缩检查点、重试、轮次失败和未知条目以标注行或围栏行渲染。推理块被省略，上下文注入被跳过。正文经过转义，转写文本无法注入原始 HTML、标题、引用块、分隔线或代码围栏；逐字围栏会增长到超过其内部任何行首反引号串；摘录上限 600 字符并带显式截断标记。

Host ZIP 端点保持不变：`/export` 仍按原样流式输出原始工件，也没有为转写文稿新增二进制路由。

弹窗报告准备中、开始下载或失败，并指明所选工件。关闭弹窗不会取消正在进行的下载；该操作随后完成时也不会重新打开弹窗。

## 组合

```yaml
- id: session-log-download
  name: '@buckeyestudio/toh-session-log-export'
```

Web bundle 将本包与 `toh-host-apiproxy`、`toh-commands`、`toh-client-ui-commands` 和 `toh-client-ui-conversation` 一起挂载。本包把按钮和弹窗贡献到最右侧的 `conversation.session.header.utilities` 列表，与标题旁 `conversation.session.header.actions` 中的模式、Subagent 和 Task 配置项相互独立；Trajectory 不包含导出入口。

## 模型体验

### 用户 `/export` 控制

#### 模型看到什么

无。`/export` 留在用户命令平面，两种下载都不会进入模型历史。

#### Token 影响

为零。该命令不创建模型轮次。

#### KV Cache 影响

无。仅日志命令生命周期和浏览器下载不会改变派生请求前缀。

## 已知限制与暂缓事项

- 下载端点要求持久化后端具有逐 Session 原始工件。随附 JSONL 后端支持明文和 zstd 工件；本次改动不包含 SQLite 导出。
- 这是浏览器下载，不是 Host 路径写入。目标位置由浏览器选择，不会返回 Host 路径或原生文件夹操作。
- 预检只报告 ZIP 开始流式传输前发现的失败。浏览器接受 GET 后发生的子 Session 或附件读取失败由浏览器下载管理器报告，不通过弹窗报告。
- Markdown 转写文稿只覆盖该客户端已加载的事件窗口（本标签页能组装的对话）；未翻页加载的更早历史不会出现，也不包含子 Session。完整表层保真度需要基于 `sessionQuery.readSurface()` 的有界 Remote 动词。
