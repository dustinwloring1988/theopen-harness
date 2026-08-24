# Agent Note: 特权 /api 方法同时锚定 socket 对端，而不只是 Host

Status: implemented

[English](2026-08-23-api-privileged-loopback-socket-pin.md) | 中文

## 问题

Web GUI `/api` 面上的特权方法 pin——settings 读写、`credentials.describe`/`set`/`unset`、`llm.discoverModels`、`agentPreset.read`/`copy`/`openDocument`/`remove`、`host.pickDirectory`/`openPath`，以及每条 `loopback` 权限的 RPC 通道——只凭请求的 `Host` 头判定「本地操作者」：即以空信任列表运行同一道[浏览器信任栅栏](../../../../packages/client/connection/src/api-request-trust.ts)。明文 HTTP 下非浏览器客户端可以把任意 Host 放上线缆上，因此在全接口组合上——CLI 拒绝 `--host 0.0.0.0`，但 bundle 的 `cordis.yml` 可以直接选择该绑定——每个 LAN 调用者都能通过回环 pin：`curl -H 'Host: localhost:<port>' http://<lan-ip>:<port>/api/credentials.set` 曾被放行；同一伪造请求还能触达 `llm.discoverModels`（让宿主向调用者选定的 URL 发起 GET 并回报状态码或响应体，是一个 SSRF 原语），以及 `settings.describe`/`credentials.describe` 这类对暴露配置与密钥存储的侦察。

Host 栅栏对它的对手是正确的：浏览器无法向 Host 报告除它实际连接的 authority 之外的任何值，rebinding 因此可被识破。而 pin 的对手不同——LAN 上的非浏览器调用者，它发出的每一个头都由自己掌控。

## 决策

特权 pin 现在要求两项一致的事实（[isLocalApiRequest](../../../../packages/client/connection/src/api-request-trust.ts)）：既有的空列表栅栏照旧通过，且从已接受的连接读到的服务端 socket 对端地址为回环（`req.socket.remoteAddress`，归一化 `::1` 与 `::ffff:` 映射的 IPv4 形式；传输层报不出对端时一律拒绝）。该地址从每个 node HTTP 请求经 `/api` bridge 送入 fetch 层——两道闸门所在：共享 `/api` fallback 中的特权方法检查与 `loopback` 权限 interceptor 闸门；专用 `loopback` 权限通道则在自己的路由处理器中应用同一检查。其余一切保持 Host 栅栏不变：trusted-host 部署上的非特权方法仍按声明的 authority 服务、不问对端地址，因为模型目录与 preset 名册本就该服务 LAN 客户端，且不含密钥或配置状态。

这构成对 [api browser-trust boundary Agent Note](../architecture/2026-07-28-api-browser-trust-boundary.zh.md) 的部分取代：其理由曾放弃旧的 socket 对端检查，认为头部已覆盖载体栅栏面对的所有对手——这对浏览器成立，对本 pin 所防御的非浏览器调用者不成立。

## 曾考虑的替代方案

**更硬地拒绝全接口绑定（目前只有 CLI 层）。** 否决：bundle 配置直接设定 bind，只在一个启动器里拒绝并不能在做出决定的操作处执行决定，而且带声明 authority 的全接口服务仍是 LAN 模型选择器的受支持部署形态。

**为远程调用者引入认证层。** 本变更中否决：令牌的签发、存储与轮换是真实的产品面；pin 今天就补齐了本地操作者判定缺失的一半，无需预先决定认证设计。

**对所有 `/api` 请求一律要求回环对端。** 否决：会把合法 LAN 客户端挡在非特权面之外却没有安全收益——浏览器对手无论如何都不选择 socket，真正的远程调用者在认证出现前本就在范围之外。

## 后果

在全接口组合上，即使 authority 已声明，LAN 调用者也恰好失去特权集合；从宿主机发起的浏览器不受影响——它们的回环声明此前为真，且 socket 对端检查对每个特权请求都会执行，来自回环的浏览器因服务端观察到的对端就是回环而通过该检查。本地反向代理仍会呈现回环对端：pin 证明的是连接源自宿主机，而非背后是谁，认证仍是记录在案的延期工作。不经传输层到达 fetch 层的进程内调用者报不出对端地址，在特权面上按失败关闭处理。

## 测试

connection 包的 spec 覆盖：伪造回环 Host 加报告的 LAN 对端时，特权方法与 `loopback` 权限通道被拒；`127/8`、`::1`、`::ffff:` 映射等各种回环对端形式在 fake 与真实 HTTP 服务器上都获放行；缺失对端地址被拒；非特权方法继续只服从 Host 栅栏；bridge spec 断言 socket 对端抵达 fetch 处理器。
