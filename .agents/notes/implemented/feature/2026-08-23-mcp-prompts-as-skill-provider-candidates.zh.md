# Agent Note: MCP prompts as opt-in skill-provider candidates

Status: implemented

[English](2026-08-23-mcp-prompts-as-skill-provider-candidates.md) | 中文

## 问题

[MCP 客户端](2026-07-07-mcp-client-plugin.zh.md)此前只桥接了 MCP 三种原语中的一种：工具成为原生 harness 工具，而已连接服务器的 Prompts 与 Resources 没有任何消费者——README 的已知限制一节原样写明了这一点。MCP Prompts 是可复用的、由服务器作者维护的指令模板，而 harness 已经拥有一个恰好为此形状准备的消费者：`ctx.skills` provider registry，其 `registerProvider` 接缝接受带模型/用户调用策略与懒加载技能体的分层候选。两者之间没有桥接，发布 prompt 的服务器浪费了这一能力面。

## 决定

`packages/mcp/mcp-client/src/prompts.ts` 在包内新增 prompts 桥接，而不是新建一个兄弟 provider 包：桥接必须跟随连接 supervisor 的世代（`connection.ts`），独立包要么为每个消费 prompt 的部署再 spawn 一个服务器进程，要么从 mcp-client 导出新的跨包世代共享服务，机制成本高于功能本身。issue 明确允许包内扩展。设置 `prompts.enabled`（默认**关闭**）时，`apply()` 要求已挂载的 skill registry——缺失时在加载期响亮失败——并为插件生命周期注册一个标签为 `mcp:<serverName>` 的 skill provider。

**候选。** 每个已列出的 prompt 成为一个候选，其面向模型的名称是原始名称的 kebab-case slug；描述原样沿用，服务器省略描述时使用生成的回退文案。已声明的参数作为发现期元数据捕获进不透明 locator。候选拥有来源类别 `mcp`，rank 低于所有本地根目录，因此 project、user 和 bundled 技能会遮蔽同名 slug；跨服务器的重名按注册顺序确定性地裁决，同时 registry 为落选者输出日志。同一服务器内的 slug 冲突使本次抓取失效（被包含、warn 记录、先前的候选继续服务），与工具桥接对无效列表的处理一致。

**技能体懒加载**，通过 `prompts/get` 使用线上的原始名称。加载内容在开头附加由 locator 元数据导出的参数指南，并以角色标签渲染每条消息；不受支持的内容块成为有界诊断文本。加载失败按 `undefined` 上报——即 registry 约定中的「不再可加载」——因为中断期的失败是预期状态而非缺陷。候选只会通过生成其目录的那次列表解析，且仅当该列表仍是最新一次：重连或 `prompts/list_changed` 重新同步进行期间，查找按不可加载上报，而不是把一个目录的原始名称与元数据发送给另一个服务器状态。

**监督复用。** prompt 同步搭乘 supervisor 序列化同步队列，排在每次工具交换之后，受同一个 `isCurrent` 栅栏保护，因此重连世代在每个队列轮次内原子地重新同步两种原语；`notifications/prompts/list_changed` 处理器在存活世代上触发重新同步；重连预算耗尽时通过 `giveUp()` 清空目录并一并注销工具；dispose 在队列静止后注销 provider。抓取失败会将观察标记为不完整，因此消费者绝不会缓存可能缺少可用候选的目录。分页仅在 `nextCursor` 缺失时结束；服务器重复返回同一个游标——包括每页都回显空字符串——会使该次抓取在包含它的同步内失败。

**配置。** 两种传输都接受 `prompts { enabled, modelInvocable }`；`resolvePromptsPolicy()` 在加载期拒绝未知键，做法与 `resolveReconnectPolicy()` 一致。`modelInvocable`（默认 true）作用于该服务器的全部候选；用户调用始终允许。

## 替代方案考虑

**独立的 `packages/mcp/mcp-prompts-skill` 包。** 否决：它无法观察到 supervisor 的存活 client，除非为每个消费 prompt 的部署再 spawn 一个服务器进程，或从 mcp-client 导出新的世代共享服务——机制多于功能本身。issue 明确允许包内扩展。

**默认开启桥接。** 否决：真实部署会在没有 skill registry 的情况下挂载 mcp-client（Python 运行时 smoke 显式禁用了 skills），而且默认开启会把远程服务器的 prompt 在无人要求的情况下注入每个会话目录。保持 opt-in 使这项变更在被配置前完全不可见，与「opt-in 不进出厂默认」一致。

**每个世代注册/注销 provider。** 否决：每次重连抖动都穿越 registry 的具名 provider 表，相比单个生命周期注册（内部交换候选集合并通过借来的 control 使缓存失效）没有任何收益。

**跨服务器冲突时使用 hash 后缀 slug**（工具桥接的做法）。否决：技能由人和模型通过目录寻址，而非计算出的标识符，且 registry 已经用可见警告拥有重名优先级规则；确定性遮蔽加日志与本地 provider 之间的冲突处理方式一致。

## 测试

单元测试（`tests/prompts.spec.ts`，mock SDK）：策略解析、slug 映射、含多页与空字符串游标分页及重复游标抓取失败的候选映射、回退描述、调用策略传播、带参数模板化与角色标签渲染的 `prompts/get` 懒加载、不可加载上报与加载中调用方取消的传播、重连重新列举 prompt 期间、同世代重新列举进行中以及重新同步失败后的世代一致性拒绝（同世代重新同步失败时最后一个正常目录保持可加载）、被包含的 slug 冲突及经通知处理器的恢复、通知驱动的重新同步、搭乘重连世代的重新同步与陈旧处理器惰性、预算耗尽清空目录、默认关闭的接线、缺 registry 时响亮失败，以及 dispose 注销 provider。真实组合（`tests/loader-composition.spec.ts`）：桥接从测试专用 cordis.yml 经真实 Loader 启动，仅 mock MCP SDK，测试逐字固定面向模型的目录条目与加载体，并验证 dispose 时连接关闭。快照：无——桥接不引入新的呈现形态，且该能力面只存在于显式 opt-in 配置之下。

## 后果

- 已连接的 MCP 服务器现在可以把 prompt 库交付为一等 skill 候选，按需加载，并遵循与工具相同的中断语义。
- 已知限制收缩为 Resources，以及 prompt 无法接收调用参数——skill 接口不携带参数，已声明的参数只能以指南文本呈现，取值取决于服务器在不做替换情况下的渲染结果。
- 生成的 capability-seams 图中 `ctx.skills` 增加了第三条消费者边；mcp-client 现在对 skill 服务定义声明 peer 依赖。
