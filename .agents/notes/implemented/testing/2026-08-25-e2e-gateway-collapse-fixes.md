# Agent Note: e2e gateway collapse and stale-lane repairs

Status: implemented

English | [中文](2026-08-25-e2e-gateway-collapse-fixes.zh.md)

## Problem

Routing every real-API suite through one gateway model (the canonical CI shape: all three `DEEPSEEK_E2E_MODEL_*` slots resolve to the same id) broke four lanes the 2026-08-22 provider note left behind. The shipped example compositions emitted one catalog row per slot, so a full collapse handed the DeepSeek adapter three rows with one id and its fail-loud duplicate check rejected the whole plugin tree — every with-key smoke that boots `examples/acp-agent` or `examples/headless-agent` died at load. The pi-ai twin suite overrode `baseURL` without declaring models, and an unknown id is not routable on that adapter, so all its gateway scenarios ended in `UNKNOWN_MODEL`. The Codex bridge refused to translate for any upstream but the official endpoint, so its Responses lane 502'd under the gateway key. Separately, five portal components relied on inferred `createPortal` return types, which declaration emit cannot name portably when Wine's drive-letter layout splits React's type identity (`TS2883`), red-ing the blocking Windows job; the Web composition gained `web_fetch` without regenerating its composition graph or the preset e2e's expected tool list; and the acp-demo built-bin smoke resolved `@agentclientprotocol/sdk/package.json`, a subpath the SDK's exports map does not expose.

## Decision

Slot collapse is normalized where the slots are read, not in the adapter: both example compositions build their catalog rows through a `!!js` expression that dedupes by id and unions image capability, so a collapsed deployment yields one row while an env-less boot resolves byte-identically to the previous list. The pi-ai e2e harness declares its slots as hand-declared models in gateway mode, deduped by id because a collapse resolves two slots to one gateway model and the adapter refuses duplicate rows (a bare id yields serviceable defaults; the installed catalog keeps serving public-endpoint runs, whose reasoning metadata the effort scenarios assert). Its reasoning-control scenarios — including explicit `off`, which has nothing to disable on a non-reasoning slot and is refused before provider I/O — moved into the public-endpoint-only describe. The Codex bridge forwards to whatever `DEEPSEEK_BASE_URL` names using the resolved flash slot under a generous completion cap, because a reasoning gateway spends tokens before the echoed text and a small cap truncates it mid-string; the Responses lane thus runs against any completions gateway. The Claude Code lane still self-skips off the official endpoint because the Claude CLI speaks Anthropic Messages against DeepSeek's `/anthropic` surface, which no gateway serves.

The five portal components (`Modal`, `Toast`, `OnboardingSurface`, `DropOverlay`, `ImageLightbox`) carry explicit return annotations, so their declarations no longer depend on inference across React's type identity. The built-bin consumer links dependencies by resolving each package's entry and walking up to the owning `package.json`. The compaction harness keys its small test catalog on the resolved flash slot rather than a literal id, and the regenerated composition graph plus the preset e2e's tool list now include `web_fetch`.

## Alternatives considered

Relaxing the adapter's duplicate-id check into a silent merge was rejected: two static rows naming one id with different capabilities is ambiguous configuration, and fail-loud at load stays the repo contract; collapse is a property of the environment, so the composition that reads the environment owns it. Routing the Claude CLI through a gateway was rejected: it would need an Anthropic-Messages facade no current gateway provides. Teaching the service layer to accept `off` on non-reasoning slots was rejected: the refusal is documented `UNSUPPORTED_REASONING_EFFORT` behavior asserted by `toh-llm` specs, and omitting the effort produces the identical wire request.

## Consequences

The whole with-key lane now boots and answers through a single gateway model, which is how CI actually runs it. Gateway scope stays honest by construction: plain-text generation proves the routed model end to end, while reasoning controls stay pinned to the endpoint whose extensions they probe. The Windows blocking job compiles under Wine's path identity again. The codex subagent note in the 2026-08-22 provider record is superseded in part — its bridge now follows the shared slots, while Claude Code still requires its own provider.
