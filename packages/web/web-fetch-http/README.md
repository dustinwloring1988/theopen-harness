# @buckeyestudio/toh-web-fetch-http

English | [中文](README.zh.md)

An anonymous public HTTP(S) `WebFetchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It retrieves a concrete URL and returns a status code plus bounded decoded content.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the key and it does not register a model-facing tool. It is a function/namespace plugin (`inject: ['web']`).

## Responsibility split

The provider owns **safe resource retrieval**: URL validation, DNS-resolve-then-validate with connection pinning, HTTP transport, redirect policy, a resource-backstop timeout, abort propagation, byte caps, charset decoding, content-type classification, and binary rejection. `@buckeyestudio/toh-tool-web` owns **presentation** (HTML→markdown, truncation formatting). A non-2xx HTTP response is a *result* (status code + decoded body), not an error; `WebError` is reserved for failures to safely retrieve or represent the resource.

The provider's `timeoutMs` is a resource backstop for direct `ctx.web.fetch()` callers and misconfigured deployments, not the model-facing tool-call budget. [`toh-tool-call-timeout-policy`](../../guard/timeout-policy/README.md) owns the `web_fetch` tool-call budget by arming `exec.signal`.

A shipping web-tool deployment sets the provider backstop above the tool budget, so model calls normally return `TOOL_TIMEOUT`. If the outer deadline reaches the provider first, the provider reports `WEB_ABORTED` and the outer policy replaces it with `TOOL_TIMEOUT`. `WEB_FETCH_TIMEOUT` therefore identifies a direct service caller whose provider budget elapsed.

## Transport hygiene

- Accepts only `http:` and `https:` URLs; rejects credentials in URLs (`WEB_BLOCKED_URL`) and over-long/malformed URLs (`WEB_INVALID_URL`).
- Resolves each destination hostname before dialing and blocks loopback, private, link-local, CGNAT, multicast, ULA, documentation, and otherwise non-public addresses with `WEB_PRIVATE_NETWORK_BLOCKED`; the connection dials only validated addresses, so no unchecked second resolution can pick the target. Local-network hostnames (`localhost`, `.localhost`, `.local`) are refused by name, and literal-IP URLs are classified without any resolution.
- Enforces a max URL length, response byte cap (`WEB_FETCH_TOO_LARGE`), decoded body character cap, timeout (`WEB_FETCH_TIMEOUT`), and redirect hop cap.
- Propagates the caller's abort signal (`WEB_ABORTED`) into the resolution, the network request, and the streaming read.
- Follows only **same-origin** redirects; a cross-origin redirect fails with `WEB_REDIRECT_BLOCKED`, requiring a fresh tool call (the model of Claude Code's WebFetch). Every hop re-enters the same request path, so each hop's destination is re-resolved and re-validated.
- Sends an explicit product `User-Agent`, never a browser disguise.
- Rejects unsupported (e.g. binary) content types with `WEB_UNSUPPORTED_CONTENT_TYPE`.

## Private-network policy

The guard lives in the composable policy module `createPrivateNetworkPolicy` (exported from this package), shaped so another fetch provider can reuse it: it resolves a hostname through an injectable resolver (default: the OS resolver via `dns.lookup(..., { all: true })`), classifies every resolved address, and returns exactly the validated address list. The provider hands that list to its connection's `lookup` function, so Node dials one of the checked addresses — there is no gap in which a second, unchecked resolution can pick the destination, closing the resolve-then-connect TOCTOU where Node allows customizing the resolver.

Blocked ranges: IPv4 loopback (127/8), unspecified ("this network", 0/8), RFC 1918 private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, including cloud-metadata endpoints), CGNAT shared address space (100.64/10), multicast (224/4), reserved plus broadcast (240/4), and IANA documentation ranges; IPv6 loopback (::1), unspecified (::), unique-local (fc00::/7), link-local (fe80::/10), deprecated site-local (fec0::/10), multicast (ff00::/8), documentation (2001:db8::/32); and the embedded-IPv4 forms — mapped (`::ffff:a.b.c.d`), compatible (`::a.b.c.d`), and the NAT64 well-known prefix (`64:ff9b::/96`) — which classify by their embedded IPv4 destination.

## Config

| Key | Default | Meaning |
|---|---|---|
| `maxUrlLength` | `2048` | Maximum accepted request URL length. |
| `maxResponseBytes` | `5_000_000` | Maximum response body size in bytes. |
| `maxBodyChars` | `100_000` | Maximum decoded body length in characters. |
| `timeoutMs` | `30_000` | Fetch timeout within Node's timer range — a resource backstop for direct `ctx.web.fetch()` callers, not the model-facing tool-call budget (that is `toh-tool-call-timeout-policy`). |
| `maxRedirects` | `5` | Maximum same-origin redirect hops (`0` follows none). |
| `userAgent` | `theopen-harness/…` | `User-Agent` header. |
| `allowPrivateNetworks` | `false` | Permit loopback, private, and otherwise non-public destinations — for CI/test compositions and explicitly trusted deployments. |

The numeric limits are validated at plugin construction: every cap except `maxRedirects` must be a positive finite number, and `maxRedirects` must be a non-negative integer. `allowPrivateNetworks` must be a boolean. An invalid value throws rather than silently constructing a provider with nonsensical limits.

## Model Experience

Indirectly, through [`toh-tool-web`](../tool-web/README.md), which places this provider's `maxBodyChars`-bounded decoded text or markdown-shaped HTML under its fetch-result wrapper and retains provider failures while redirects, headers, and transport mechanics remain hidden.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Valid-but-unassigned IPv6 space passes classification** — the guard blocks the named non-public ranges above; a valid IPv6 address outside them (e.g. `fe00::/13`) is treated as public. Malformed resolver output fails closed (`WEB_PRIVATE_NETWORK_BLOCKED`).
- **Transport is HTTP/1.1** — the pinned-lookup dial uses `node:http`/`node:https`, so no HTTP/2 connection reuse; one request per dial.
- **Only textual content decodes** — html/xhtml and `text/*`-plus-JSON/XML families; a missing `Content-Type` or any binary type throws `WEB_UNSUPPORTED_CONTENT_TYPE`, and text-extractable PDF decoding is named deferred work.
- **Charset comes only from the `Content-Type` header** (UTF-8 default) — an HTML `<meta charset>` declaration is ignored, and a declared-but-unrecognized charset label throws rather than falling back.
