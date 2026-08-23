# Agent Note: Privileged /api methods pin the socket peer, not just Host

Status: implemented

English | [中文](2026-08-23-api-privileged-loopback-socket-pin.zh.md)

## Problem

The privileged-method pin on the Web GUI `/api` surface — settings reads and writes, `credentials.describe`/`set`/`unset`, `llm.discoverModels`, `agentPreset.read`/`copy`/`openDocument`/`remove`, `host.pickDirectory`/`openPath`, and every `loopback`-authority RPC channel — decided "local operator" from the request `Host` header alone: the same [browser-trust fence](../../../../packages/client/connection/src/api-request-trust.ts) run with an empty trust list. Over plain HTTP a non-browser client can put any Host on the wire, so on an all-interfaces composition — which a bundle `cordis.yml` can select directly even though the CLI refuses `--host 0.0.0.0` — every LAN caller passed the loopback pin: `curl -H 'Host: localhost:<port>' http://<lan-ip>:<port>/api/credentials.set` was allowed, and the same forged request reached `llm.discoverModels`, which makes the host issue a GET to a caller-chosen URL and report back the status or body, plus `settings.describe`/`credentials.describe`, reconnaissance over the exposed configuration and secret store.

The Host fence itself is correct for its adversary: a browser cannot tell Host anything other than the authority it connected to, which is what makes rebinding detectable. The pin's adversary is different — a non-browser caller on the LAN, which owns every header it sends.

## Decision

The privilege pin requires two agreeing facts ([isLocalApiRequest](../../../../packages/client/connection/src/api-request-trust.ts)): the existing empty-list fence pass, unchanged, and a loopback server-side socket peer address read from the accepted connection (`req.socket.remoteAddress`, normalizing `::1` and `::ffff:`-mapped IPv4 spellings; a transport reporting no peer fails closed). The address is threaded from each node HTTP request through the `/api` bridge into the fetch layer, where both gates live — the privileged-method check in the shared `/api` fallback and the `loopback`-authority interceptor gate — and dedicated `loopback`-authority channels apply it in their route handlers. Everything else keeps the Host fence untouched: non-privileged methods on trusted-host deployments still serve declared authorities regardless of peer address, because the model catalog and preset roster legitimately serve LAN clients and carry no key or configuration state.

This partially supersedes [the api browser-trust boundary Agent Note](../architecture/2026-07-28-api-browser-trust-boundary.md), whose rationale dropped the earlier socket-peer guard on the ground that headers cover every adversary the carrier fence owns; that holds for browsers, not for the non-browser caller this pin defends against.

## Alternatives considered

**Refuse all-interfaces bindings harder (CLI-level only today).** Rejected: bundle configs set the bind directly, so a refusal in one launcher does not enforce the decision in the operation that makes it, and all-interfaces serving with declared authorities remains a supported deployment for the LAN model picker.

**An authentication layer for remote callers.** Rejected for this change: token minting, storage, and rotation are real product surface; the pin restores the missing half of the local-operator test today without pre-deciding the auth design.

**Require a loopback peer on every `/api` request.** Rejected: it would cut legitimate LAN clients off unprivileged surface for no security gain — the browser adversary never chooses the socket either way, and genuinely remote callers stay out of scope until authentication exists.

## Consequences

On an all-interfaces composition, LAN callers lose exactly the privileged set even when their authority is declared; browsers are unaffected, since their loopback claims were true before and remain unverified against the socket only when they come from loopback itself. A local reverse proxy still presents a loopback peer: the pin proves the connection originated on the host machine, not who is behind it, and authentication remains the recorded deferred work. In-process callers that reach the fetch layer without a transport report no peer and fail closed on privileged surface.

## Testing

Connection package specs deny privileged methods and `loopback`-authority channels on a forged loopback Host from a reported LAN peer, admit them for every loopback peer spelling (`127/8`, `::1`, `::ffff:`-mapped) over fakes and a real HTTP server, refuse a missing peer address, and keep non-privileged methods answerable to the Host fence alone; bridge specs assert the socket peer reaches the fetch handler.
