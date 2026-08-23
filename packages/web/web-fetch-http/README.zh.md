# @buckeyestudio/toh-web-fetch-http

[English](README.md) | 中文

一个匿名公共 HTTP(S) `WebFetchProvider`，用于 harness [web 能力 seam](../web/README.zh.md)（`ctx.web`）。它获取具体 URL，返回状态码和长度受限的解码内容。

这是一个**实现**包：它向 `ctx.web` 注册提供方，不拥有该键，也不注册面向模型的工具。它是函数／命名空间插件（`inject: ['web']`）。

## 职责拆分

提供方拥有**安全资源获取**：URL 验证、先解析后验证并固定连接、HTTP 传输、重定向策略、资源兜底超时、中止传播、字节上限、charset 解码、内容类型分类与二进制拒绝。`@buckeyestudio/toh-tool-web` 拥有**呈现**（HTML→markdown、截断格式）。非 2xx HTTP 响应是*结果*（状态码 + 解码主体），不是错误；`WebError` 只用于无法安全获取或表示资源的失败。

提供方的 `timeoutMs` 是直接 `ctx.web.fetch()` 调用方和配置有误的部署所用的资源兜底，不是面向模型的工具调用预算。[`toh-tool-call-timeout-policy`](../../guard/timeout-policy/README.zh.md) 拥有 `web_fetch` 工具调用预算，并让 `exec.signal` 在超时时触发，以强制执行该预算。

已交付的 web 工具部署会把提供方兜底设为高于工具预算，因此模型调用通常返回 `TOOL_TIMEOUT`。如果外层截止期限先于提供方的兜底超时触发，提供方会报告 `WEB_ABORTED`，外层策略再将其替换为 `TOOL_TIMEOUT`。因此，`WEB_FETCH_TIMEOUT` 表明直接服务调用方的提供方预算已经耗尽。

## 传输卫生

- 只接受 `http:` 和 `https:` URL；拒绝 URL 中的凭据（`WEB_BLOCKED_URL`）以及过长／格式错误的 URL（`WEB_INVALID_URL`）。
- 在拨号前解析每个目标主机名，并以 `WEB_PRIVATE_NETWORK_BLOCKED` 阻止 loopback、私有、link-local、CGNAT、multicast、ULA、文档等非公开地址；连接只拨向已验证的地址，因此不会有未经检查的第二次解析选择目标。本地网络主机名（`localhost`、`.localhost`、`.local`）按名称拒绝，字面 IP URL 无需任何解析即可分类。
- 强制执行 URL 最大长度、响应字节上限（`WEB_FETCH_TOO_LARGE`）、解码主体字符上限、超时（`WEB_FETCH_TIMEOUT`）和重定向跳数上限。
- 把调用方的中止信号（`WEB_ABORTED`）传播到解析、网络请求与流式读取。
- 只跟随**同源**重定向；跨源重定向以 `WEB_REDIRECT_BLOCKED` 失败，要求发起新的工具调用（沿用 Claude Code 的 WebFetch 模式）。每一跳都会重新进入同一请求路径，因此每一跳的目标都会重新解析并重新验证。
- 发送显式的产品 `User-Agent`，绝不伪装成浏览器。
- 不受支持的内容类型（例如二进制）以 `WEB_UNSUPPORTED_CONTENT_TYPE` 拒绝。

## 私有网络策略

防护位于可组合的策略模块 `createPrivateNetworkPolicy` 中（从本包导出），其形状使其他抓取提供方可以直接复用：它通过可注入的解析器（默认：经 `dns.lookup(..., { all: true })` 的 OS 解析器）解析主机名，对每个解析出的地址分类，并准确返回已验证的地址列表。提供方把该列表交给连接的 `lookup` 函数，因此 Node 只会拨向已检查的地址——不存在第二次未检查解析选择目标的窗口，在 Node 允许自定义解析器的范围内关闭了解析后连接的 TOCTOU。

被阻止的范围：IPv4 loopback（127/8）、未指定（"本网络"，0/8）、RFC 1918 私有（10/8、172.16/12、192.168/16）、link-local（169.254/16，包括云元数据端点）、CGNAT 共享地址空间（100.64/10）、multicast（224/4）、保留加广播（240/4）与 IANA 文档范围；IPv6 loopback（::1）、未指定（::）、unique-local（fc00::/7）、link-local（fe80::/10）、弃用的 site-local（fec0::/10）、multicast（ff00::/8）、文档（2001:db8::/32）；以及内嵌 IPv4 形式——mapped（`::ffff:a.b.c.d`）、compatible（`::a.b.c.d`）与 NAT64 众所周知前缀（`64:ff9b::/96`）——它们按内嵌的 IPv4 目标分类。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `maxUrlLength` | `2048` | 接受的请求 URL 最大长度。 |
| `maxResponseBytes` | `5_000_000` | 响应主体最大字节数。 |
| `maxBodyChars` | `100_000` | 解码主体最大字符数。 |
| `timeoutMs` | `30_000` | Node 定时器范围内的抓取超时：直接 `ctx.web.fetch()` 调用方的资源兜底，而非面向模型的工具调用预算（后者属于 `toh-tool-call-timeout-policy`）。 |
| `maxRedirects` | `5` | 同源重定向最大跳数（`0` 表示完全不跟随）。 |
| `userAgent` | `theopen-harness/…` | `User-Agent` 标头。 |
| `allowPrivateNetworks` | `false` | 允许 loopback、私有及其他非公开目标——供 CI／测试组合与明确受信的部署使用。 |

数值限制会在插件构造时验证：除 `maxRedirects` 外，每个上限都必须是正的有限数；`maxRedirects` 必须是非负整数。`allowPrivateNetworks` 必须是布尔值。无效值会抛出异常，不会静默构造限制荒谬的提供方。

## 模型体验

通过 [`toh-tool-web`](../tool-web/README.zh.md) 间接影响；该工具把此提供方经 `maxBodyChars` 限制的解码文本或由 HTML 转换得到的 markdown 置于抓取结果包装层中，并保留提供方失败；重定向、标头与传输机制保持隐藏。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **有效但未分配的 IPv6 空间会通过分类**——防护只阻止上述具名的非公开范围；范围之外的有效 IPv6 地址（例如 `fe00::/13`）被视为公开。格式错误的解析输出会保守失败（`WEB_PRIVATE_NETWORK_BLOCKED`）。
- **传输是 HTTP/1.1**——固定查找的拨号使用 `node:http`／`node:https`，没有 HTTP/2 连接复用；每次拨号一个请求。
- **只解码文本内容**：包括 html/xhtml 与 `text/*` 加 JSON/XML 家族；缺少 `Content-Type` 或任何二进制类型都会抛出 `WEB_UNSUPPORTED_CONTENT_TYPE`，可提取文本的 PDF 解码属于明确的暂缓工作。
- **charset 只来自 `Content-Type` 标头**（默认为 UTF-8）：HTML `<meta charset>` 声明会被忽略；声明但无法识别的 charset 标签会抛出异常，而非回退。
