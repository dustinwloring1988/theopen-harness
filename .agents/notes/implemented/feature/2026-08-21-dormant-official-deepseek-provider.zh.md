# Agent Note: 休眠的 DeepSeek 官方提供方

Status: implemented

[English](2026-08-21-dormant-official-deepseek-provider.md) | 中文

## 问题

Models 页面把 DeepSeek 官方适配器当成永久钉死的事实：其整分节 profile 永远算作已配置，这一行永远无法删除，而没有任何可用提供方的首次运行用户会被一个索取密钥的弹窗接管。适配器确实是随附组合的一部分，但用户运行哪些提供方应当由设置文档决定——休眠挂载的 `llm-pi-ai` 已经遵循同一条规则。那个弹窗也与页面既有的添加流程重复。

## 决策

**默认挂载不贡献任何 base 内容。**`llm-deepseek` 注册 settings base 时，取组合条目去掉所有等于 schema 默认值的字段后的结果（`src/index.ts` 的 `compositionBase`）。等于默认值的字段在省略时解析结果完全相同，因此解析与适配器行为不变，而 descriptor 得以区分「休眠」与「被钉住」。

**整分节提供方的存在与删除跟随分层。**Models 联接现在把空路径条目的 `configured` 计算为「用户层或 base 层携带内容」，把 `removable` 计算为「仅用户层携带它」。路由提供方基于路径的规则不变。删除整分节提供方会取消设置分节根（空路径），并在页面能点名目标时——对整分节提供方即其唯一 profile 所指名的引用——一并清除已配置且可写的凭据。

**创建提供方即具化分节。**新增流程的 deepseek 创建即使只键入了密钥，也会记录 profile 解析所用的 `apiKeyEnv` 引用，因为正是这次写入把休眠的目录条目变成一行；pi-ai 留空密钥的原生认证创建保持不变。

**移除首次运行的 DeepSeek 凭据步骤。**`ui-settings-models` 在 `settings.onboarding` 中只挂载内测声明；`DeepSeekOnboardingDialog`、其就绪投影（`onboardingReadiness`）以及 `ProviderEditor` 的仅凭据属性都没有其他消费者，全部删除。此决策取代[共享弹窗产品引导](2026-08-13-shared-modal-product-onboarding.zh.md)中的凭据步骤部分，并让 [deepseek onboarding credential setup](../../archived/feature/2026-07-30-deepseek-onboarding-credential-setup.md) 与 [onboarding reads every provider](../../archived/bug-fix/2026-08-12-onboarding-reads-every-provider.md) 退役归档。

## 已考虑的替代方案

**保留常驻行，只让 Delete 生效。**否决：用户明确要求该提供方不被预置，而一行只承载 schema 默认值的事实没有任何可操作的内容。

**把 `llm-deepseek` 的 settings 结构重构成按路由键控的 profile。**本次变更中否决：扁平的整分节结构是适配器自己的契约，分层内容的 presence 判定能在不打破格式的前提下达成同样的页面语义。

**让适配器路由注册依赖配置。**否决：CLI 在零配置下靠环境变量密钥即可服务请求，网页选择器读取的也是同一批存活路由；休眠是配置界面的呈现方式，不是路由存活事实。

## 后果

全新部署在 Models 页上看不到任何提供方行；DeepSeek 官方路由在新增下拉框中与休眠的 pi-ai catalog 并列等待，存入配置后也可删除回这个状态。在 `cordis.yml` 中钉住非默认值的部署仍会渲染出一行被钉住、不可删除的提供方。使用环境变量密钥的用户在该页面只会把它看作可新增项，直到某次 settings 写入具化分节——本页面管理的是设置文档与页面存储的凭据，而不是启动环境。CLI 开箱即用的 `DEEPSEEK_API_KEY` 流程不受影响：插件挂载即注册路由。
