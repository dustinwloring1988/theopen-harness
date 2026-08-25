# Agent Note: OpenRouter as an e2e LLM provider

Status: implemented

English | [中文](2026-08-22-openrouter-e2e-provider.zh.md)

## Problem

The real-API e2e suite hardcoded the DeepSeek model ids (`deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp`) in every suite and pinned CI to `DEEPSEEK_API_KEY_EXTERNAL` at `https://api.deepseek.com`. Running the with-key lane required a DeepSeek account even though the adapter is a plain OpenAI-chat-completions client whose base URL and wire model strings are pass-through configuration.

## Decision

Every real-API suite resolves its model slots from environment variables with the shipped ids as fallbacks — `DEEPSEEK_E2E_MODEL_FLASH`, `DEEPSEEK_E2E_MODEL_PRO`, and `DEEPSEEK_E2E_MODEL_VISION` — so one set of variables retargets the whole lane. Any OpenAI-chat-completions gateway works through the existing `DEEPSEEK_BASE_URL`; the canonical alternative is OpenRouter at `https://openrouter.ai/api/v1` serving `stealth/ox-alpha`. The shipped example compositions the with-key smokes boot (`examples/acp-agent/cordis.yml`, `examples/headless-agent/cordis.yml`) resolve their catalog and agent rows from the same slots.

CI's e2e workflow selects the provider from secrets: `OPENROUTER_API_KEY_EXTERNAL` wins over `DEEPSEEK_API_KEY_EXTERNAL`, and the chosen key is exported as `DEEPSEEK_API_KEY` (the name every suite reads) together with its base URL and model slots. Two suites keep endpoint-native scenarios pinned to the public DeepSeek API: the pi-ai twin refuses named reasoning efforts for models its installed catalog does not describe (`UNSUPPORTED_REASONING_EFFORT`), so its effort-dependent tests and wire-shape parity check run only without a base-URL override; and the Files-API image upload additionally requires `DEEPSEEK_VISION_E2E=1` plus the public endpoint, because `POST /files` has no gateway equivalent. The attached-image round trip itself runs on every endpoint — gateways serve it through the adapter's inline-base64 fallback — so an image-capable gateway model such as `stealth/ox-alpha` exercises it.

## Consequences

A DeepSeek account is no longer needed to exercise the with-key lane, and model slots change per run without code edits (CI also honors a `DEEPSEEK_E2E_MODEL_OPENROUTER` repository variable). Image input is covered on every endpoint, so the with-key lane proves multimodal round trips through the gateway model it names. Gateway-specific behavior stays untested by construction: thinking-mode and effort fields are DeepSeek extensions that gateways may ignore or reject, and provider-specific smokes outside the chat-completions suites (`web-search-deepseek`, the Claude Code subagent bridge) still require their own providers — the Codex bridge now follows these slots ([collapse repairs](2026-08-25-e2e-gateway-collapse-fixes.md)).

## Alternatives considered

Adding a first-class `openrouter` adapter was rejected: the DeepSeek adapter already speaks the target wire format, so a second adapter would duplicate serialization for no behavioral gain. Routing through pi-ai's catalog was rejected for the same reason plus a hard dependency on its provider list. Keeping the ids hardcoded and editing them per run was rejected because it makes the with-key lane unrunnable for anyone without a DeepSeek account.
