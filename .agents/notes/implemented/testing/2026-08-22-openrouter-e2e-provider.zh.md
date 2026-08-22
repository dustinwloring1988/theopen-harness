# Agent Note: OpenRouter 作为 e2e LLM provider

Status: implemented

[English](2026-08-22-openrouter-e2e-provider.md) | 中文

## 问题

真实 API e2e 套件在每处都硬编码了 DeepSeek 模型 id（`deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp`），并把 CI 固定在 `https://api.deepseek.com` 的 `DEEPSEEK_API_KEY_EXTERNAL` 上。尽管该适配器只是一个 base URL 与线路模型串皆可透传配置的 OpenAI-chat-completions 客户端，跑通带密钥通道却仍然必须拥有 DeepSeek 账号。

## 决策

每个真实 API 套件的模型槽位都改为从环境变量解析，并以出厂 id 作为回退——`DEEPSEEK_E2E_MODEL_FLASH`、`DEEPSEEK_E2E_MODEL_PRO`、`DEEPSEEK_E2E_MODEL_VISION`——一组变量即可重定向整条通道。任何 OpenAI-chat-completions 网关都能通过既有的 `DEEPSEEK_BASE_URL` 接入；规范的替代方案是 `https://openrouter.ai/api/v1` 上的 OpenRouter，模型为 `stealth/ox-alpha`。

CI 的 e2e 工作流按 secret 选择 provider：`OPENROUTER_API_KEY_EXTERNAL` 优先于 `DEEPSEEK_API_KEY_EXTERNAL`，选中的密钥以 `DEEPSEEK_API_KEY`（所有套件读取的名字）连同其 base URL 与模型槽位一起导出。Files-API 图片往返额外要求公共 DeepSeek 端点，因为 `POST /files` 没有网关等价物；inline-base64 回退路径仍由单元测试覆盖。

## 影响

带密钥通道不再需要 DeepSeek 账号，且模型槽位可按次运行修改而无需改代码（CI 还支持 `DEEPSEEK_E2E_MODEL_OPENROUTER` 仓库变量）。网关特有行为不在测试范围内：thinking-mode 与 effort 字段是 DeepSeek 扩展，网关可能忽略或拒绝；chat-completions 套件之外的 provider 专属冒烟（`web-search-deepseek`、Claude Code 与 Codex subagent 桥）仍需各自的 provider。

## 已考虑的替代方案

新增一等 `openrouter` 适配器被否决：DeepSeek 适配器已讲目标线路格式，第二个适配器只会为无行为收益的序列化买单。改走 pi-ai 目录同样被否决——理由相同，还叠加了对它 provider 列表的硬依赖。保留硬编码 id 并在每次运行前手改被否决，因为那会让没有 DeepSeek 账号的人无法运行带密钥通道。
