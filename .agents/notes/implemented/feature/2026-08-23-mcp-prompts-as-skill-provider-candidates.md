# Agent Note: MCP prompts as opt-in skill-provider candidates

Status: implemented

English | [中文](2026-08-23-mcp-prompts-as-skill-provider-candidates.zh.md)

## Problem

The [MCP client](2026-07-07-mcp-client-plugin.md) bridged exactly one of MCP's three primitives: tools became native harness tools, while a connected server's Prompts and Resources reached no consumer at all — the README's Known Limitations said so verbatim. MCP Prompts are reusable, server-authored instruction templates, and the harness already owns a consumer shaped for exactly that: the `ctx.skills` provider registry, whose `registerProvider` seam accepts layered candidates with model/user invocation policy and lazy body loading. No bridge existed between them, so servers that publish prompts wasted that surface.

## Decision

`packages/mcp/mcp-client/src/prompts.ts` adds an in-package prompts bridge rather than a sibling provider package: the bridge must ride the connection supervisor's generations (`connection.ts`), and a separate package would need either its own server process or a new cross-package generation service. With `prompts.enabled` (default **false**), `apply()` requires the mounted skill registry — failing loud at load when absent — and registers one skill provider labeled `mcp:<serverName>` for the plugin lifetime.

**Candidates.** Each listed prompt becomes a candidate whose model-facing name is the kebab-case slug of the raw name; descriptions carry over verbatim, with a generated fallback when the server omits one. Declared arguments are captured into the opaque locator as discovery-time metadata. Candidates report source bucket `mcp` and rank below every local root, so project, user, and bundled skills shadow same-named slugs; cross-server duplicates resolve deterministically by registration order while the registry logs the skipped entry. A slug collision inside one server invalidates that fetch (contained, warn-logged, last-good candidates keep serving), mirroring the tool bridge's invalid-list handling.

**Bodies load lazily** through `prompts/get` using the raw wire name. Loaded content prepends an argument guide derived from the locator metadata and renders each message under a role tag; unsupported content blocks become bounded diagnostics. A failed load reports `undefined`, the registry contract's "no longer loadable", because mid-outage failures are expected states rather than defects. A candidate resolves only through the listing that produced its catalog, and only while that listing is still the newest one: while a reconnect or `prompts/list_changed` re-sync is in flight, lookups report unloadable instead of sending one catalog's raw name and metadata to another server state. The fence is monotonic across sync attempts, so a re-sync whose fetch fails also fails closed: the previous candidates stay listed for discovery while their loads report unloadable until the next clean catalog commits.

**Supervision reuse.** Prompt sync rides the supervisor's serialized sync queue behind every tool swap, guarded by the same `isCurrent` fence, so reconnect generations re-sync both primitives atomically per queue turn; a `notifications/prompts/list_changed` handler re-syncs the live generation; exhausting the reconnect budget empties the catalog through `giveUp()` alongside unregistering tools; disposal unregisters the provider after the queue quiesces. Failed fetches flag the observation incomplete, so consumers never cache a catalog that may be missing usable candidates. Pagination ends only when `nextCursor` is absent; a server repeating one cursor — including an empty string echoed every page — fails that fetch inside the containing sync.

**Config.** Both transports accept `prompts { enabled, modelInvocable }`; `resolvePromptsPolicy()` re-judges unknown keys at load exactly like `resolveReconnectPolicy()`. `modelInvocable` (default true) marks the whole server's candidates; user invocation stays permitted.

## Alternatives considered

**A separate `packages/mcp/mcp-prompts-skill` package.** Rejected: it cannot observe the supervisor's live client without either spawning a second server process per prompt-consuming deployment or exporting a new generation-sharing service from mcp-client — more machinery than the feature itself. The issue explicitly allowed an in-package extension.

**Default-on bridging.** Rejected: real deployments mount mcp-client without a skill registry (the Python runtime smoke disables skills), and defaulting on would inject a remote server's prompts into every session catalog unprompted. Opt-in keeps the change invisible until configured, consistent with keeping opt-ins out of shipped defaults.

**Register and unregister the provider per generation.** Rejected: churn through the registry's named-provider table per reconnect flap buys nothing over one lifetime registration whose candidate set swaps internally and invalidates caches through the borrowed control.

**Hash-suffixed slugs for cross-server collisions** (the tool bridge's approach). Rejected: skills are addressed by humans and models through catalogs, not by computed identifiers, and the registry already owns duplicate-name precedence with visible warnings; deterministic shadowing plus logging matches how local providers collide.

## Testing

Unit (`tests/prompts.spec.ts`, mocked SDK): policy resolution, slug mapping, candidate mapping including multi-page and empty-string-cursor pagination plus a repeated-cursor fetch failure, fallback description, invocation-policy propagation, lazy `prompts/get` loading with argument templating and role-tagged rendering, unloadable-body reporting with mid-load caller cancellation propagation, generation-coherence refusals while a reconnect re-lists prompts, while a same-generation re-list is in flight, after a failed re-sync (a failed same-generation resync keeps the previous candidates listed while their loads stay unloadable until the next clean sync commits), an in-flight lookup dropped when a replacement listing commits during its request, contained slug collisions with recovery through the notification handler, notification-driven resync, resync riding a reconnect generation with stale-handler inertness, budget exhaustion emptying the catalog, default-off wiring, loud failure without a registry, and disposal unregistering the provider. Real composition (`tests/loader-composition.spec.ts`): the bridge boots through the real Loader from test-only cordis.yml with only the MCP SDK mocked, and the test pins the model-visible catalog entry and loaded body verbatim plus connection teardown on disposal. Snapshot (`examples/acp-agent/tests/snapshots/mcp-prompts-skill-load/`): keyless authored replay through the shipped ACP app pins the model-visible skill-catalog entry and the loaded body of a prompt served by a deterministic fixture MCP server over stdio.

## Consequences

- Connected MCP servers can now deliver prompt libraries as first-class skill candidates, loaded on demand and following the same outage semantics as tools.
- The Known Limitations statement shrinks to Resources and to prompts' inability to receive invocation arguments — the skill seam carries no parameters, so declared arguments surface as guidance text and values depend on the server rendering without substitution.
- `ctx.skills` gained its third consumer edge in the generated capability-seams graph; mcp-client now declares a peer dependency on the skill service definition.
