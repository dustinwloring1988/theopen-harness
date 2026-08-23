# Agent Note: SDK JSON-RPC params validate at the wire before dispatch

Status: implemented

[English](2026-08-23-sdk-jsonrpc-wire-param-validation.md) | 中文

## Problem

SDK JSON-RPC 服务器把原始解码参数直接转型为类型化处理程序的入参，因此 stdio 对端——一个运行时没有理由信任的进程外客户端——决定了什么会进入持久会话日志。`HarnessSdkJsonRpcServer.handleRequest` 执行 `params as unknown as InitializeParams` 与 `params as unknown as SessionPromptParams`，而 `session/prompt` 将 `contentBlocks` 原样传入 `createUserMessage`。恶意或出错的客户端可以提交 harness 产生的内容块词汇——命名任意调用 id 的 `tool-result`、`reasoning` 块、藏在 `text` 块内的多余字段——它们会被持久化进会话日志，并在下一次模型请求中发出，就像 harness 自己产生的一样。其他每个入口都先校验：Web 网关对每个载荷做 zod 解析并把提示词内容收窄到提示词侧块，ACP 桥接运行完整的提示词准入；SDK 服务器是唯一的缺口。

畸形结构也会失败得又晚又模糊。`contentBlocks: {}` 在消息冻结深处抛错，并以笼统的 `-32603` 内部错误呈现，而不是 `-32602` 无效参数，因为行传输把所有处理程序拒绝都映射为 `-32603`。

## Decision

`handleRequest` 分发的每个方法都会在类型化处理程序运行前，根据 [wire.ts](../../../../packages/sdk/server/src/wire.ts) 中的 zod schema 校验其参数。这些 schema 在两个表面重叠之处逐字段镜像 Web 网关的请求 schema 策略：必填字段有类型且非空、未知字段被剥离而非拒绝、`initialize.maxTokens` 为正的安全整数，并且 `session/prompt.contentBlocks` 只接受提示词侧的内容块——`text`，以及携带持久化附件引用（正整数尺寸）的核心 `image` 块。harness 产生的标签（`tool-call`、`tool-result`、`reasoning`）与未知标签都无法通过校验，因此除用户创作的内容外，任何东西都不能经由这一边界进入日志。

校验失败抛出代码为 `-32602` 的 `JsonRpcResponseError`；消息指明方法名与每个未通过的字段，`data.issues` 携带结构化问题列表。行传输现在会把处理程序抛出的 `JsonRpcResponseError` 原样写回——code、message 与 `data`——而其余拒绝仍保持 `-32603` 映射。该协议类本就为客户端表示错误帧；服务器抛出它是同一表示在出站方向上的使用。

## Alternatives considered

**在每个处理程序内部校验。** 否决：类型化方法也会在进程内被直接调用，那里 TypeScript 已拥有该契约且仓库规则禁止对静态保证做运行时复检；把准入放在那里会让 `handleRequest` 再次轻易遗忘它，而强制应当由做出该操作的那一步执行。

**用手工形状检查代替 zod。** 被维护依赖策略否决：Web 网关已经用 zod 承担了完全相同的工作，手写判别式遍历加问题格式化只会新增自维护代码，并与网关语义漂移，毫无收益。

**拒绝未知字段（`strict`）。** 否决：网关的请求 schema 会剥离多余字段，匹配该行为可让前向兼容的客户端在两个入口上表现一致。

**仅文本提示词。** 曾考虑比已发布联合更窄的方案。落败：`image` 是核心内容中的提示词侧类型，网关接受图像，且 SDK 图像块只携带由主机解析的持久化引用——拒绝它会破坏合法客户端，却堵不住块类型限制之外的任何缺口。

## Consequences

经由 SDK 套接字的伪造历史注入已被封死：`tool-result` 块如今会在会话或消息存在之前得到 `-32602` 应答，没有任何东西到达持久日志或模型请求。畸形参数以逐字段细节应答 `-32602`，而非 `-32603`。

从未发送过非提示词块的客户端——两个已发布的 SDK 都会把输入规范化为文本块——除了更好的错误码外看不到任何行为变化。曾发送过这类块的客户端依赖的是本次修复的缺陷。Python SDK 复现这些结构但不导入它们，因此无需代码变更；其文档描述的是文本提示词。

`toh-sdk-jsonrpc-server` 新增运行时 `zod` 依赖，正如 `toh-host-apiproxy` 已有的那样。

## Testing

`packages/sdk/server/tests/server.spec.ts` 直接驱动 `handleRequest`：伪造 `tool-result` 的拒绝（无排队消息、无通知），`initialize` 与 `session/prompt` 的畸形参数表以 `-32602` 而非 `-32603` 应答，顶层参数与 `text` 块内部的未知字段剥离，以及接受带精确持久内容相等断言的提示词侧 `text` 与 `image` 块。

`packages/sdk/server/tests/plugin-apply.spec.ts` 经真实的注入 stdio 对发送伪造块，并固定 `-32602` 错误帧以及不存在任何 `session.event` 或 `session.status` 通知。

`packages/sdk/protocol/tests/transport.spec.ts` 固定处理程序抛出的 `JsonRpcResponseError` 会往返其 code、message 与 `data`，而普通处理程序失败仍应答 `-32603`。
