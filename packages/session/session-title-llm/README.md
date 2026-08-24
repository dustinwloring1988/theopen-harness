# @buckeyestudio/toh-session-title-llm

English | [中文](README.zh.md)

Optional `ctx.sessionTitle` provider that titles sessions through `ctx.llm`. The required `cadence` config selects one automatic generation behavior: `first-prompt` summarizes only the first eligible human message and runs once when a fresh non-fork session first creates its fallback, while `all-prompts` starts a new revision after each new human prompt using seeded history as well as child-session prompts. A newer revision aborts and supersedes older work; even a provider that ignores cancellation cannot commit stale output. An explicit `ctx.sessionTitle.refresh()` retries either cadence.

The registration id is derived from the configured cadence (`session-title-first-prompt-llm` or `session-title-all-prompts-llm`) and is what durable title sources and auxiliary request records record as provenance. The same package owns the shared request policy: it resolves the auxiliary route, frames exact selected human messages as JSON, records the exact dispatchable request, applies a language-aware title instruction, enforces input and output budgets, composes timeout and caller cancellation, assembles the stream, and returns normalized text with exact source seqs plus the provider/model route used to generate it.

## Route and failure contract

`provider` and `model` overrides are optional but must be supplied together as non-empty strings. Without that pair, the provider uses the exact provider/model route captured from the current session's logged `request/header`; an explicit refresh before any route exists therefore needs overrides. The final JSON-framed user prompt, including seq fields, wrappers, and JSON escaping, is measured against `maxInputBytes` before logging or dispatch instead of truncating it. Timeout and caller cancellation are rechecked while consuming the stream and after it completes, so a late successful result cannot be accepted even if an interceptor or adapter ignores abort. Malformed or empty output, tool calls, and non-stop finish reasons also reject; the session-title service decides whether that rejection is an automatic warning or an explicit caller failure. A misconfigured cadence or unknown config key fails loud at load.

After route and input validation, the package appends a log-only `session/title-llm-request` event directly through `Session` before model dispatch. It contains the title-provider id, exact source seqs, route, system prompt, message list, and output-token cap used by the call. Persistence observes the record eagerly; the append does not need a title-specific marker, cast, settlement queue, or flush. The dispatched envelope is deep-frozen, carries `purpose: 'session-title'`, and deliberately lacks toh-agent-loop's process-local request identity. Interceptors stay aligned with the record while loop-only reconstruction observers do not compare it with the conversation header. The DeepSeek adapter maps that purpose to thinking-disabled so the small output budget is reserved for visible title text; other adapters own their purpose-specific behavior. A later model failure leaves the request record intact; validation failures that never become dispatchable requests do not create one. The event stays outside derived model history.

## Configuration

Every field is required except the paired route override; there are no defaults.

| Key | Contract |
|---|---|
| `cadence` | Automatic generation cadence: `first-prompt` or `all-prompts`. |
| `targetWords` | Positive target word count for non-CJK titles. |
| `targetCjkCharacters` | Positive target character count for Chinese, Japanese, or Korean titles. |
| `maxInputBytes` | Positive UTF-8 byte ceiling for the final JSON-framed user prompt. |
| `maxOutputTokens` | Positive auxiliary generation token cap. |
| `timeoutMs` | Positive end-to-end deadline within the runtime timer limit. |
| `provider`, `model` | Optional explicit route; both or neither. |

## Model Experience

### Auxiliary title request

#### What the model sees

The title model receives a fixed system instruction to return one concise unadorned title in the input language, including the configured word and CJK-character targets. Its one user message contains a JSON array of the exact selected human messages and their seqs — only the first message under `first-prompt`, every eligible message under `all-prompts`.

#### Token effect

At most one automatic auxiliary request per fresh session under `first-prompt`; `all-prompts` requests once per new human prompt. Each call is bounded by `maxInputBytes` and `maxOutputTokens`; explicit refreshes may make additional calls. The main agent request gains zero tokens. DeepSeek title calls disable thinking; the main conversation retains its configured thinking mode.

#### KV Cache effect

No main-request invalidation. Auxiliary cache reuse is provider-specific; the fixed instruction is reusable while the JSON message array changes with each revision.

## Known Limitations and Deferred Work

- The provider accepts text output only and rejects tool calls; structured-output adapters and provider-specific prompt variants are not exposed.
- It enforces a byte ceiling for the whole framed user prompt rather than clipping individual messages or applying a retention policy.
- Under `first-prompt`, the first message alone may cease to represent a long-running session; configure `all-prompts` when later prompts should retitle it.
- A fork keeps its inherited title and never runs the `first-prompt` cadence automatically, even when its seeded first message came from the parent.
