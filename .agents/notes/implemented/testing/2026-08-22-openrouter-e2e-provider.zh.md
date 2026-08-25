# Agent Note: OpenRouter 作为 e2e LLM provider

Status: implemented

[English](2026-08-22-openrouter-e2e-provider.md) | 中文

## 问题

真实 API e2e 套件在每处都硬编码了 DeepSeek 模型 id（`deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp`），并把 CI 固定在 `https://api.deepseek.com` 的 `DEEPSEEK_API_KEY_EXTERNAL` 上。尽管该适配器只是一个 base URL 与线路模型串皆可透传配置的 OpenAI-chat-completions 客户端，跑通带密钥通道却仍然必须拥有 DeepSeek 账号。

## 决策

每个真实 API 套件的模型槽位都改为从环境变量解析，并以出厂 id 作为回退——`DEEPSEEK_E2E_MODEL_FLASH`、`DEEPSEEK_E2E_MODEL_PRO`、`DEEPSEEK_E2E_MODEL_VISION`——一组变量即可重定向整条通道。任何 OpenAI-chat-completions 网关都能通过既有的 `DEEPSEEK_BASE_URL` 接入；规范的替代方案是 `https://openrouter.ai/api/v1` 上的 OpenRouter，模型为 `stealth/ox-alpha`。带密钥冒烟所启动的出厂示例组合（`examples/acp-agent/cordis.yml`、`examples/headless-agent/cordis.yml`）也从同一组槽位解析其目录与 agent 行。

CI 的 e2e 工作流按 secret 选择 provider：`OPENROUTER_API_KEY_EXTERNAL` 优先于 `DEEPSEEK_API_KEY_EXTERNAL`，选中的密钥以 `DEEPSEEK_API_KEY`（所有套件读取的名字）连同其 base URL 与模型槽位一起导出。两套套件把端点原生场景固定在公共 DeepSeek API 上：pi-ai 孪生套件会为其已安装目录未描述的模型拒绝具名 reasoning effort（`UNSUPPORTED_REASONING_EFFORT`），因此它的 effort 相关测试与线路形状一致性检查只在无 base-URL 覆盖时运行；Files-API 图片上传还额外要求 `DEEPSEEK_VISION_E2E=1` 加公共端点，因为 `POST /files` 没有网关等价物。附件图片往返本身在所有端点运行——网关经适配器的 inline-base64 回退承接——因此像 `stealth/ox-alpha` 这样的图像能力网关模型可以直接演练它。

## 影响

带密钥通道不再需要 DeepSeek 账号，且模型槽位可按次运行修改而无需改代码（CI 还支持 `DEEPSEEK_E2E_MODEL_OPENROUTER` 仓库变量）。图像输入在所有端点都有覆盖，因此带密钥通道能通过其点名的网关模型证明多模态往返。网关特有行为不在测试范围内：thinking-mode 与 effort 字段是 DeepSeek 扩展，网关可能忽略或拒绝；chat-completions 套件之外的 provider 专属冒烟（`web-search-deepseek`、Claude Code subagent 桥）仍需各自的 provider——Codex 桥已跟随这些槽位（[坍缩修复](2026-08-25-e2e-gateway-collapse-fixes.zh.md)）。

## 已考虑的替代方案

新增一等 `openrouter` 适配器被否决：DeepSeek 适配器已讲目标线路格式，第二个适配器只会为无行为收益的序列化买单。改走 pi-ai 目录同样被否决——理由相同，还叠加了对它 provider 列表的硬依赖。保留硬编码 id 并在每次运行前手改被否决，因为那会让没有 DeepSeek 账号的人无法运行带密钥通道。
