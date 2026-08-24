# Agent Note: Handler-crash 500 responses stay error-free

Status: implemented

[English](2026-08-23-handler-crash-500-responses-stay-error-free.md) | 中文

## 问题

`/api` 载体的两条兜底崩溃路径都以 500 状态回答 `handler failure: ${String(error)}`：`toh-host-apiproxy` 的 fetch handler（`src/fetch/handler.ts`）和 `toh-client-connection` 的通用 RPC host（`src/rpc-host.ts`）。因此每一次未处理的 handler 异常都会把原始内部错误文本回显给 API 客户端，而 `String(error)` 常常携带宿主机绝对文件系统路径和适配器内部细节。代码库其余部分刻意压制这一点——`api-proxy.ts` 对 session-export 的 500 用固定句子回答，正是因为错误可能携带绝对主机路径——所以这两条兜底路径在受信任浏览器页面可触发的每次崩溃上都重新引入了泄露。

## 决策

两条崩溃路径都通过 `console.error` 在服务端记录完整错误，带上各自包的诊断前缀（`[apiproxy]`、`[client-connection]`）和一个新的 `randomUUID()` 关联 id，并以 500 状态回答 `handler failure (id <uuid>)`。响应体只有固定文本加该 id；id 同时出现在日志行和响应体中，用户上报的崩溃无需暴露内部细节即可与服务器日志条目匹配。两处使用相同的消息形态，保持两个载体一致。没有新增依赖：`node:crypto` 的 `randomUUID` 本就是这两个包的既有约定。

## 考虑过的替代方案

- **只回显错误类别或名称**（如 `handler failure: Error`）。类型名仍然描述内部结构，且无法给支持人员在日志中提供可匹配的内容；关联 id 直接服务于上报场景。
- **结构化日志服务。** 两个包今天都没有；它们已经通过带前缀的 `console.error` 报告诊断。引入日志接缝属于一个专门的决策，不属于本次修复。
- **复用请求的 rpcId 作为关联 id。** 崩溃可能与单次调用无关，客户端可以自己铸造 rpcId，而调用方可选的 id 会削弱日志匹配保证；服务器铸造的 UUID 对每次事件保持无碰撞。

## 后果

崩溃细节留在宿主侧；浏览器错误界面显示稳定句子加 id。调试一次上报的崩溃现在需要访问宿主日志，这与该部署的单用户本地服务姿态一致。SSE 流中途失败帧按设计仍携带原始错误文本——那是独立的界面，由自己的契约拥有，此处不动。

## 测试

原先钉住泄露行为的两个 spec 现在断言安全形态：`packages/client/connection/tests/node-half.host.spec.ts` 和 `packages/host/apiproxy/tests/fetch-carrier.spec.ts` 各自期望响应体匹配 `handler failure (id <uuid>)`，断言原始错误文本不在响应体中，并验证同一关联 id（以及完整错误）出现在捕获的 `console.error` 行里。
