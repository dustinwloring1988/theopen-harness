# Agent Note: web fetch 在私有网络防护之后交付

Status: implemented

[English](2026-08-23-web-fetch-private-network-guard.md) | 中文

## Problem

`toh-web-fetch-http` 是一个完整的抓取后端，却对模型自选请求目标毫无防御：不阻止私有、loopback、link-local 及其他非公开目标，也没有先解析后验证的步骤。因此每个已交付的组合都保持 `web_fetch` 关闭（`tool-web` 配置 `fetch: false`，提供方不挂载），因为启用它等于交给模型一个参数形状的 SSRF 原语——无需 shell 即可触及 harness 自己跑在环回上的网关、内网段和云元数据端点。

[能力 seam 笔记](../architecture/2026-06-24-web-capability-seam.zh.md)记录了正确阻止所需的内容：DNS 解析后连接到已验证地址（击败检查与拨号之间的 rebinding／TOCTOU）、跨重定向的逐跳重新验证、包括 mapped 地址在内的 IPv6 边缘处理，以及一个让受信组合可以显式放行的配置开关。调研过的两个参考实现都没有做 IP 级阻止，因此该设计没有可照搬的先例。

## Decision

防护是提供方包内的可组合策略模块（`createPrivateNetworkPolicy`，从 `@buckeyestudio/toh-web-fetch-http` 导出），不是抓取路径中的内联逻辑，未来的抓取提供方无需改动即可组合它：它通过可注入的解析器解析主机名（默认：经 `dns.lookup(..., { all: true })` 的 OS 解析器），对每个解析出的地址分类，对无法识别的记录保守失败，并准确返回已验证的地址列表。

连接固定在 Node 允许自定义解析的范围内关闭了 TOCTOU：传输层从全局 `fetch()` 迁移到 `node:http`/`node:https` 请求，其 `lookup` 选项只接收已验证的地址列表，因此套接字不会落在其他任何地方。TLS 保留原始主机名用于 SNI 与证书校验。字面 IP URL 无需解析器参与即完成分类，本地网络主机名（`localhost`、`.localhost`、`.local`）在 DNS 给出不同答案之前就按名称拒绝。

被阻止的范围：IPv4 loopback（127/8）、未指定（0/8）、RFC 1918（10/8、172.16/12、192.168/16）、link-local（169.254/16，覆盖云元数据）、CGNAT 共享空间（100.64/10）、multicast（224/4）、保留加广播（240/4）、IANA 文档范围；IPv6 loopback（::1）、未指定（::）、unique-local（fc00::/7）、link-local（fe80::/10）、弃用的 site-local（fec0::/10）、multicast（ff00::/8）、文档（2001:db8::/32）；以及内嵌 IPv4 形式——mapped `::ffff:a.b.c.d`、compatible `::a.b.c.d`、NAT64 众所周知前缀 `64:ff9b::/96`——按其内嵌的 IPv4 目标分类。有效但未分配的 IPv6 空间会通过分类，作为已记录的限制保留；格式错误的输出保守失败。

每一次同源重定向跳都会重新进入请求路径，因此每一跳都重新解析并重新验证；跨源重定向本就被拒绝（`WEB_REDIRECT_BLOCKED`）。被阻止的目标会抛出新的提供方自有代码 `WEB_PRIVATE_NETWORK_BLOCKED`。

**配置开关：** `allowPrivateNetworks` 默认为 false，并像其他每个配置字段一样在构造时验证。有意以 loopback fixture 为目标的 CI／测试组合将其设为 true——acp-agent 的 web-fetch snapshot 场景正是如此。

**组合翻转：** `packages/bundle/base/cordis.patch.yml` 挂载 `web-fetch-http` 并设置 `tool-web.fetch: true`，三个已交付 agent 预设的 `tool-web` 行同样如此；base bundle 声明了该提供方依赖，使裸插件解析成立。

## Testing

分类测试覆盖每个具名范围家族加上紧贴各前缀外侧的边界地址、公开对照、格式错误输入（包括带前导零的八位组，它们保守失败）、mapped／compatible／NAT64 内嵌以及本地名称识别。策略测试证明：多条地址结果中任一记录非公开即阻止；本地名称不经解析器即拒绝；字面 IP 永不触及解析器；每次调用都会重新解析——这正是重定向跳所依赖的性质。

提供方测试针对真实 loopback 服务器运行，不对 OS 解析器做任何网络 mock：已交付默认值阻止 `127.0.0.1`，端到端阻止经真实解析的 `localhost` URL 且服务器零接触，显式选择加入后同一 URL 成功。固定行为通过拨打一个 OS DNS 中完全不存在的主机名来证明——请求能抵达 fixture 服务器的唯一原因是拨号使用了已验证的记录。插件级测试通过真实 Loader 挂载固化默认阻止 loopback 的姿态。

## Alternatives considered

**验证一次后正常调用 `fetch()`。** 不予采纳：全局 `fetch()` 会独立重新解析，重新打开刚被验证关闭的 rebinding 窗口；关键就在于被检查的地址就是被拨打的地址。

**把 URL 重写为已验证 IP 并手动设置 Host 标头。** 不予采纳：`fetch` 禁止设置 `Host`，且 HTTPS 下证书校验会绑定到 IP 而非主机名，破坏验证——`lookup` 路线保住 SNI 与证书语义。

**使用 `ipaddr.js` 之类的依赖。** 不予采纳：分类只是数百行针对众所周知前缀的纯算术运算，配有穷尽的表格覆盖；未达到"维护依赖优于手写"的标准（删除自有代码与测试）。

**连有效但未分配的 IPv6 空间也一并阻止。** 作为已记录限制暂缓：本议题的范围点名了标准非公开家族；把全部未分配空间视为敌意是本次变更不宣称的更严姿态。

## Consequences

`web_fetch` 与 `web_search` 一起在每个模式下默认启用：模型无需绕道 shell 即可获取具体 URL，而只存在于主机内部或内部网络中的目标会在执行时响亮失败。必须约束出站流量的部署仍需网络级控制——该防护阻止的是私有*目标*，不是针对被入侵进程的出站过滤。

离开 undici dispatcher 带来的仅 HTTP/1.1 取舍已被接受并记录在包 README 中；除新增的阻止代码外，调用方视角的上限、超时分类、中止传播与错误代码均未改变。
