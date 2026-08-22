# Agent Note: OpenRouter as an e2e LLM provider

Status: implemented

English | [中文](2026-08-22-openrouter-e2e-provider.zh.md)

## Problem

The real-API e2e suite hardcoded the DeepSeek model ids (`deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp`) in every suite and pinned CI to `DEEPSEEK_API_KEY_EXTERNAL` at `https://api.deepseek.com`. Running the with-key lane required a DeepSeek account even though the adapter is a plain OpenAI-chat-completions client whose base URL and wire model strings are pass-through configuration.

## Decision

Every real-API suite resolves its model slots from environment variables with the shipped ids as fallbacks — `DEEPSEEK_E2E_MODEL_FLASH`, `DEEPSEEK_E2E_MODEL_PRO`, and `DEEPSEEK_E2E_MODEL_VISION` — so one set of variables retargets the whole lane. Any OpenAI-chat-completions gateway works through the existing `DEEPSEEK_BASE_URL`; the canonical alternative is OpenRouter at `https://openrouter.ai/api/v1` serving `stealth/ox-alpha`.

CI's e2e workflow selects the provider from secrets: `OPENROUTER_API_KEY_EXTERNAL` wins over `DEEPSEEK_API_KEY_EXTERNAL`, and the chosen key is exported as `DEEPSEEK_API_KEY` (the name every suite reads) together with its base URL and model slots. The Files-API image round-trip additionally requires the public DeepSeek endpoint, because `POST /files` has no gateway equivalent; the inline-base64 fallback path stays covered by unit tests.

## Consequences

A DeepSeek account is no longer needed to exercise the with-key lane, and model slots change per run without code edits (CI also honors a `DEEPSEEK_E2E_MODEL_OPENROUTER` repository variable). Gateway-specific behavior is untested by construction: thinking-mode and effort fields are DeepSeek extensions that gateways may ignore or reject, and provider-specific smokes outside the chat-completions suites (`web-search-deepseek`, the Claude Code and Codex subagent bridges) still require their own providers.

## Alternatives considered

Adding a first-class `openrouter` adapter was rejected: the DeepSeek adapter already speaks the target wire format, so a second adapter would duplicate serialization for no behavioral gain. Routing through pi-ai's catalog was rejected for the same reason plus a hard dependency on its provider list. Keeping the ids hardcoded and editing them per run was rejected because it makes the with-key lane unrunnable for anyone without a DeepSeek account.
