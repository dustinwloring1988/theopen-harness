# Agent Note: Web fetch ships behind a private-network guard

Status: implemented

English | [中文](2026-08-23-web-fetch-private-network-guard.zh.md)

## Problem

`toh-web-fetch-http` was a complete retrieval backend with no defense against the model choosing its own request target: no blocking of private, loopback, link-local, or otherwise non-public destinations, and no resolve-then-validate step. Every shipped composition therefore kept `web_fetch` off (`tool-web` config `fetch: false`, provider unmounted), because enabling it handed the model an argument-shaped SSRF primitive — reach the harness's own loopback gateways, internal network segments, or cloud metadata endpoints without needing a shell.

The [capability seam note](../architecture/2026-06-24-web-capability-seam.md) recorded what correct blocking requires: DNS-resolve-then-connect-to-the-validated-address (defeating rebinding/TOCTOU between check and dial), per-hop re-validation across redirects, IPv6 edge handling including mapped addresses, and a config switch so trusted compositions can opt out. Neither surveyed reference implementation did IP-level blocking, so the design had no copyable prior art.

## Decision

The guard is a composable policy module inside the provider package (`createPrivateNetworkPolicy`, exported from `@buckeyestudio/toh-web-fetch-http`), not inline logic in the fetch path, so a future fetch provider composes it unchanged: it resolves a hostname through an injectable resolver (default: the OS resolver via `dns.lookup(..., { all: true })`), classifies every resolved address, fails closed on unrecognizable records, and returns exactly the validated address list.

Connection pinning closes the TOCTOU where Node allows customizing resolution: the transport moved from global `fetch()` to `node:http`/`node:https` requests whose `lookup` option receives only the validated address list, so the socket cannot land anywhere else. TLS keeps the original hostname for SNI and certificate verification. Literal-IP URLs classify without any resolver involvement, and local-network hostnames (`localhost`, `.localhost`, `.local`) are refused by name before DNS can answer differently.

Blocked ranges: IPv4 loopback (127/8), unspecified (0/8), RFC 1918 (10/8, 172.16/12, 192.168/16), link-local (169.254/16, covering cloud metadata), CGNAT shared space (100.64/10), IETF protocol assignments (192.0.0/24), deprecated 6to4 relay anycast (192.88.99.0/24), benchmarking space (198.18.0.0/15), multicast (224/4), reserved plus broadcast (240/4), IANA documentation ranges; IPv6 loopback (::1), unspecified (::), unique-local (fc00::/7), link-local (fe80::/10), deprecated site-local (fec0::/10), multicast (ff00::/8), documentation (2001:db8::/32); and embedded-IPv4 forms — mapped `::ffff:a.b.c.d`, compatible `::a.b.c.d`, the NAT64 well-known prefix `64:ff9b::/96`, and 6to4 `2002::/16` — classified by their embedded IPv4 destination, so a non-public embedded destination blocks the address while a public one stays public. Valid-but-unassigned IPv6 space passes classification and stays a documented limitation; malformed output fails closed.

The pinned Node transport also decodes declared response content codings before the byte cap and charset decoding apply: `gzip`/`x-gzip`, zlib-wrapped `deflate`, and `br` decompress through `node:zlib` transforms; absent, blank, and `identity` pass through; any other declared coding throws `WEB_UNSUPPORTED_CONTENT_TYPE` rather than handing back undecodable bytes. `maxResponseBytes` measures decompressed bytes, so a compressed body cannot expand past the cap in memory; the `Content-Length` precheck still bounds the wire transfer itself.

Every same-origin redirect hop re-enters the request path, so each hop re-resolves and re-validates; cross-origin redirects were already refused (`WEB_REDIRECT_BLOCKED`). A blocked destination raises the new provider-owned code `WEB_PRIVATE_NETWORK_BLOCKED`.

**Config switch:** `allowPrivateNetworks` defaults to false, validated at construction like every other config field. CI/test compositions that intentionally target loopback fixtures set it true — the acp-agent web-fetch snapshot scenario does exactly that.

**Composition flips:** `packages/bundle/base/cordis.patch.yml` mounts `web-fetch-http` and sets `tool-web.fetch: true`, as do the three shipped agent presets' `tool-web` rows; the base bundle declares the provider dependency so bare-plugin resolution holds.

## Testing

Classification covers every named range family plus boundary addresses just outside each prefix, public controls, malformed input (including octets with leading zeros, which fail closed), mapped/compatible/NAT64/6to4 embedding (both blocked and public embedded destinations), and local-name recognition. Policy tests prove: multi-address results block when any one record is non-public; benchmarking and CGNAT destinations block by default and pass once opted in; local names refuse without consulting the resolver; literal IPs never touch the resolver; fresh resolution is consulted again per call — the property redirect hops rely on.

Provider tests run against real loopback servers, no network mocking of the OS resolver: the shipped default blocks `127.0.0.1`, blocks a `localhost` URL end-to-end through real resolution with zero server contact, and permits the same URL once opted in. Pinning is proven by dialing a hostname absent from OS DNS entirely — the request only reaches the fixture server because the dial used the validated record. Plugin-level tests pin the default-blocks-loopback posture through a real Loader mount. Content-decoding tests cover gzip, brotli, and zlib-wrapped deflate bodies, the `x-gzip` alias, blank and identity passthrough, decompression-before-charset order, the byte cap measured on decompressed output, and loud failure on unknown codings and corrupt streams.

## Alternatives considered

**Validate once, then call `fetch()` normally.** Rejected: global `fetch()` re-resolves independently, reopening the rebinding window the validation just closed; the whole point is that the checked address is the dialed address.

**Rewrite the URL to the validated IP with a Host header.** Rejected: `fetch` forbids setting `Host`, and for HTTPS the certificate check would bind to the IP instead of the hostname, breaking verification — the `lookup` route keeps SNI and cert semantics intact.

**A dependency such as `ipaddr.js`.** Rejected: the classification is a few hundred lines of pure arithmetic over well-known prefixes with exhaustive table coverage; the maintained-dependency bar (deleting owned code and tests) is not met.

**Block valid-but-unassigned IPv6 space too.** Deferred with a documented limitation: the issue's scope names the standard non-public families; treating all unallocated space as hostile is a stricter posture this change does not claim.

## Consequences

`web_fetch` ships enabled in every mode alongside `web_search`: the model can retrieve a specific URL without a shell detour, while destinations that only exist inside the host or an internal network fail loudly at execution time. Deployments that must contain outbound traffic keep a network-level control — the guard blocks private *destinations*, it is not egress filtering for a compromised process.

The HTTP/1.1-only tradeoff of leaving undici's dispatcher is accepted and documented in the package README; timeout classification, abort propagation, and redirect behavior are unchanged from the caller's perspective, while two error-code surfaces widened (`WEB_PRIVATE_NETWORK_BLOCKED` is new and unsupported declared encodings reuse `WEB_UNSUPPORTED_CONTENT_TYPE`) and the response byte cap now measures decompressed bytes.
