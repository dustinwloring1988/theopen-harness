# @buckeyestudio/toh-mcp-client

English | [中文](README.zh.md)

MCP client bridge plugin: connects to external [Model Context Protocol](https://modelcontextprotocol.io/) servers and registers their tools on `ctx.tools`, making them available to the model as native tools under server-qualified names (`mcp__<serverName>__<rawName>`). With `prompts.enabled`, the same connection also publishes the server's MCP Prompts as skill-provider candidates on `ctx.skills`.

## Usage

One plugin instance per MCP server in `cordis.yml`:

```yaml
- id: mcp-github
  name: '@buckeyestudio/toh-mcp-client'
  config:
    serverName: github
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN

- id: mcp-web
  name: '@buckeyestudio/toh-mcp-client'
  config:
    serverName: web
    transport: streamable-http
    url: http://localhost:3000/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
```

The model sees `mcp__github__create_issue`, `mcp__web__search`, … — the same server-qualified shape Claude Code and Codex use. HMR hot-swaps: editing the entry triggers disconnect + reconnect without process restart; an unchanged `serverName` reproduces identical tool names.

## Config

| Field | Transport | Required | Description |
|---|---|---|---|
| `transport` | both | yes | `"stdio"` or `"streamable-http"` |
| `serverName` | both | yes | Namespace for this server's model-facing tool names; `[A-Za-z0-9_-]{1,32}`, unique across live instances |
| `command` | stdio | yes | Executable to spawn |
| `args` | stdio | no | Arguments passed to the command |
| `env` | stdio | no | Extra env vars merged on top of scrubbed ambient env |
| `cwd` | stdio | no | Working directory for the child process |
| `url` | http | yes | MCP server URL |
| `headers` | http | no | Extra headers (e.g. auth tokens) |
| `toolCallTimeoutMs` | both | no | Timeout per `callTool` invocation (default 60000) |
| `failOnStartupError` | both | no | Reject plugin activation when initial connection or tool synchronization fails (default `false`) |
| `reconnect.enabled` | both | no | Reconnect automatically after a lost connection (default `true`) |
| `reconnect.initialDelayMs` | both | no | First reconnect delay in ms; doubles per consecutive failed attempt (default 500) |
| `reconnect.maxDelayMs` | both | no | Backoff ceiling in ms; also the uptime after which the attempt budget resets (default 30000) |
| `reconnect.maxAttempts` | both | no | Consecutive failed attempts per outage before giving up for good (default 10) |
| `prompts.enabled` | both | no | Bridge this server's MCP Prompts into the skill registry (default `false`) |
| `prompts.modelInvocable` | both | no | Advertise bridged prompts to model-facing skill catalogs (default `true`) |

## Tool naming

Every MCP tool has two names: the raw MCP name (sent on the wire in `tools/call`) and the public name `mcp__<serverName>__<rawName>` registered on `ctx.tools`. Public names are normalized to the DeepSeek function-name contract (64 chars, `[A-Za-z0-9_-]`); when replacement or truncation changes the name, a deterministic 12-hex-char hash of `(serverName, rawName)` is appended so distinct tools never collapse into one name. Names are pure functions of `(serverName, rawName)` — connection order, re-syncs, and other servers never rename a tool.

- Two servers publishing the same raw name (e.g. `search`) coexist under their namespaces.
- A duplicate `serverName` across live instances fails the later plugin instance at load.
- A server listing the same tool name twice is rejected as an invalid tool list.
- A foreign registration squatting on this server's namespace rolls back the whole generation (never a partial set), with a loud error.

## Prompts as skills

With `prompts.enabled`, each listed prompt becomes a skill candidate: the model-facing skill name is the kebab-case slug of the prompt's raw name (`code_review` → `code-review`), the server description carries over verbatim, and declared arguments are captured as metadata. The provider registers under the label `mcp:<serverName>` with origin bucket `mcp`; remote prompts rank below every local root, so project, user, and bundled skills shadow same-named slugs, and two servers exposing the same slug resolve deterministically by plugin registration order with a visible warning for the loser.

Bodies load lazily through `prompts/get` using the raw name. The loaded content prepends an argument guide built from the discovery metadata and renders the server's messages under role tags; a load that fails because the connection is down or the server rejects the read reports the skill as unloadable instead of surfacing an error. A candidate resolves only through the generation whose listing produced its catalog: while a reconnect or `list_changed` re-sync is in flight, loads report unloadable instead of sending the old catalog's raw name to a generation that never listed it. A slug collision inside one server's list (two prompts normalizing to one slug) invalidates that fetch: the previous candidates keep serving and the failure logs at warn until the server publishes a clean list.

Prompt sync rides the same supervision as tools: every reconnect generation re-runs `prompts/list` after the tool swap, `notifications/prompts/list_changed` triggers a re-sync on the live generation, and exhausting the reconnect budget empties the catalog alongside unregistering the tools. Pagination ends only when `nextCursor` is absent; a server repeating one cursor (including echoing an empty string every page) fails the fetch inside the containing sync. During a transient outage the last good candidates stay listed while loads fail closed.

## Behavior

- On connect: plugin activation awaits `listTools()` and registers each tool via `ctx.tools.register()` under its public name before the composition starts its first turn. Initial connection, discovery, or registration failure is always logged; it rejects activation when `failOnStartupError` is true and otherwise activates with no tools.
- Listens for `notifications/tools/list_changed` → re-syncs; a fetch-phase failure keeps the previous generation registered, while a registration conflict rolls back the attempted generation and leaves no tools from that server.
- Tool execute: `client.callTool({ name: rawName, arguments }, { signal })` with timeout + abort support—the public name is never sent to the server.
- Canonical success is `{ content: JsonValue[], structuredContent? }`; complete JSON MCP blocks survive for programmatic callers. A supported advertised `outputSchema` validates `structuredContent`; unsupported schema vocabulary falls back to unconstrained `JsonValue`.
- Native/model rendering preserves MCP block order. Text-like runs join with newlines; resource links keep their name and URI as text; supported images become durable core image blocks only when `ctx.attachments` is mounted and the exact calling model route explicitly declares image input. The whole image batch is decoded and admitted before any member is saved. A malformed/refused image batch, audio, embedded resources, and unsupported blocks become explicit diagnostic text rather than disappearing.
- On disconnect/crash: the supervisor restarts the original server config with exponential backoff (`reconnect.initialDelayMs` doubling up to `reconnect.maxDelayMs`) and re-runs discovery on success — the recovered generation replaces the previous one, so tools neither duplicate nor leak. During the outage the last good generation stays registered; calls against it fail until recovery.
- With `prompts.enabled`, every tool generation swap is followed by a `prompts/list` sync in the same serialized queue; `notifications/prompts/list_changed` re-syncs the live generation, and a failed prompt fetch keeps the previous candidates while flagging the catalog incomplete so consumers retry.
- Reconnection is budgeted per outage: after `reconnect.maxAttempts` consecutive failures the server's tools are unregistered and reconnection stops until an HMR reload or Host restart. A connection that survives past `maxDelayMs` resets the budget, so an occasionally-crashing server recovers indefinitely while a crash-looping one — even with briefly successful connects — still exhausts the cap instead of restarting forever.
- Reconnect states are user-visible in logs: reconnecting (warn, with attempt count and delay), recovered (info), final failure and disabled-loss (error). Disposal cancels any pending reconnect. With `reconnect.enabled: false`, a lost connection keeps tools registered but failing until a reload — the manual-recovery behavior.

## Services consumed

| Service | Usage |
|---|---|
| `ctx.tools` | Register/unregister MCP tools |
| `ctx.skills` | Register the prompts provider when `prompts.enabled`; enabling without a mounted registry fails the plugin at load |
| `ctx.attachments` | Optionally validate and persist image result batches before model projection |
| `ctx.llm` | Optionally prove the exact calling route explicitly supports image input |

## Model Experience

### Discovered MCP tools

#### What the model sees

After initial discovery succeeds, each advertised MCP tool appears as a native tool named `mcp__<serverName>__<rawName>` (or its deterministic normalized form), with the server-provided description and input schema. A successful re-sync — including the one after an automatic reconnect — replaces the generation; plugin disposal or an exhausted reconnect budget removes it.

#### Token effect

Data-dependent schema cost is paid on every request while the tools are registered. Re-sync replaces rather than accumulates schemas, and the server-qualified name adds tokens to every tool definition and call.

#### KV Cache effect

Prefix-stable while the discovered tool set and schemas are unchanged. A re-sync that adds, removes, renames, or changes a tool replaces definitions and may invalidate reuse from the first changed schema token; a reconnect that recovers an unchanged list reproduces identical definitions and stays prefix-stable.

### Tool-call history and results

#### What the model sees

The public tool name and JSON arguments remain in assistant history. The execution-local canonical value always retains the complete JSON MCP blocks and optional structured content for programmatic and Code Mode callers. In Native context, supported image blocks are durably projected beside text in their original order after exact route-capability proof; Code Mode additionally ferries that settled rich projection through the outer `run_code` result without changing the canonical binding value. Refused images, audio, embedded resources, resource links, and unknown blocks remain visible as bounded text diagnostics, and MCP `isError` rejects the call before image persistence.

#### Token effect

Arguments, mapped text, and durable image references are retained until compaction. Inline MCP base64 stays only in the execution-local canonical value and is never copied into a session event; the provider reads verified bytes from the attachment store. Audio and embedded-resource payloads stay out of model context.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Bridged MCP prompts

#### What the model sees

With `prompts.enabled`, each listed prompt appears in the skill catalog under its kebab-case slug with the server's description; loading one yields an argument guide followed by the server-rendered prompt messages. The catalog entry disappears when the reconnect budget is exhausted or the plugin is disposed, and a recovered generation replaces the candidate set as a whole.

#### Token effect

Catalog summaries ride the session-prefix skill listing while enabled; loaded bodies are retained per invocation like any other skill body. Disabling `prompts.enabled` removes both.

#### KV Cache effect

Prefix-stable while the candidate set and bodies are unchanged; a generation swap that changes the candidate set invalidates reuse from the changed catalog token onward.

## Known Limitations and Deferred Work

- **Resources have no harness consumer** — MCP Resources are not bridged; bounded reads through the existing tool bridge are deferred.
- **Prompts cannot receive invocation arguments** — the skill seam carries no parameters, so a bridged prompt's declared arguments surface as a guide inside the loaded body and values depend on the server rendering without substitution.
- **Startup timeout is inherited from the MCP SDK** — TOH does not yet expose a connection/discovery timeout. Each initialize or paginated `tools/list`/`prompts/list` request uses the SDK's 60-second default, so an unresponsive server or cursor chain can delay both activation and teardown while the initial synchronization settles.
- **Reconnect triggers on transport close** — a crashed stdio child fires it; Streamable HTTP failures surface per request and through the SDK transport's own SSE-stream recovery, so an unreachable HTTP server is retried per call rather than respawned by the supervisor.
- **Image is the only durable rich-result bridge** — PNG, JPEG, WebP, and GIF can enter Native context after exact capability proof. Audio and embedded-resource payloads remain execution-local with explicit diagnostics, while resource links preserve only their name and URI as text.
- **Unsupported MCP output schemas are not enforced** — `structuredContent` falls back to `JsonValue` when the advertised schema uses vocabulary outside the harness subset.
