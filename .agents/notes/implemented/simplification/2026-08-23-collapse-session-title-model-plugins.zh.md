# Agent Note: 将会话标题模型插件合并为一个按节奏配置的包

Status: implemented

[English](2026-08-23-collapse-session-title-model-plugins.md) | 中文

## 问题

两个完整的插件包实现了只会话标题 LLM 提供方，其注册逻辑仅差一个节奏字面量和一个简单的消息选择器：`@buckeyestudio/toh-session-title-first-prompt-llm` 以 `first-prompt` 节奏选取第一条合格的用户消息，`@buckeyestudio/toh-session-title-all-prompts-llm` 以 `all-prompts` 节奏透传所有合格消息。这种拆分的代价是逐字节相同的 `Config` 块（各自都需要 jscpd 抑制），外加重复的清单、不变量伴随插件、双语 README 和测试套件。

`all-prompts` 孪生包还没有任何消费方：没有任何 bundle、示例、应用或 Python 运行时闭包组合它——只有它自己的清单提到它。与此同时，标题服务早已把节奏词表收拢为闭合联合（`SessionTitleAutomaticMode = 'first-prompt' | 'all-prompts'`），因此这些额外的包只增加了表面积，却没有带来任何部署可达的行为。

## 决策

由一个包 [`@buckeyestudio/toh-session-title-llm`](../../../../packages/session/session-title-llm) 独自拥有模型驱动的标题提供方。它在已有的共享请求策略之外导出标准插件接口（`name`/`inject`/`Config`/`apply`），两个孪生包一并删除。其必填且经过验证的 `cadence: 'first-prompt' | 'all-prompts'` 配置字段选择消息选择器；非法值或未知键在加载时大声失败。两种行为仍然可以通过 cordis.yml 由用户选择，随附组合（`bundle/base`）保持 `first-prompt` 节奏且各项限制不变。

注册的提供方 id 继续由所配置的节奏派生（`session-title-first-prompt-llm` / `session-title-all-prompts-llm`），因此在这次重新打包前后，持久的标题来源、辅助请求记录和出处记录仍准确指名产生它们的选择行为。jscpd 抑制随重复的 schema 块一起消失；剩下的 `Config` 就是共享 schema 对象本身。

本次变更更新了[日志化会话标题决策](../feature/2026-07-21-log-backed-session-titles.zh.md)中的事实，但没有改变该决策本身；服务、事件词表、回退和时序约定均未改动。

## 验证

包测试通过真实的提供方注册覆盖两种节奏（消息选取、出处 id、预置历史、路由继承）；直接构造验证拒绝非法节奏；Loader 组合测试从 cordis.yml 启动插件，并证明不受支持的节奏在加载时大声失败。由于派生的出处 id 保持稳定，无密钥的整体快照原样重放。

## 考虑过的替代方案

**只删除无人消费的孪生包，保留 first-prompt 原样。** 不予采纳：这能消除重复，却完全放弃了 `all-prompts` 行为，与服务自身的闭合节奏联合相矛盾——后者将因此命名一个不可达的模式。

**在共享辅助库之上保留两个薄插件。** 不予采纳：它会保留逐字相同的 Config 块、成对的清单、不变量伴随插件以及 README 与测试套件，而它们存在的唯一目的就是各携带一个字面量。

**把幸存的孪生包重命名为中性的插件名。** 不予采纳：共享策略包已经以准确的名字存在，否则它将成为只有一个消费方的辅助库；把插件并入其中是删除一个包，而不是重命名两个。

## 后果

部署配置一行插件（`cadence` 加既有限制）即可，不再需要在两个包名之间选择；配置错误的节奏在加载时失败而不是被静默解析。仓库少了一个包族成员，该区域不再有 jscpd 抑制，不变量伴随插件、README 对与测试套件从三份变为一处。未来新增一种节奏时，只需作为联合的新成员添加一个选择器分支，而不是新建一个包。
