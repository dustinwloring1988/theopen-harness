# Agent Note: Bound every provider response body the host buffers

Status: implemented

English | [中文](2026-08-23-bounded-provider-response-reads.zh.md)

## Problem

The three web search providers parsed upstream replies with unbounded `response.json()`, and the DeepSeek chat adapter read non-2xx bodies with unbounded `response.text()`. Both buffered the complete body in host memory before any check ran. The endpoints are deployment- and user-configurable (`baseURL` is a settings field, partly env-resolved), so a hostile or compromised endpoint returning a multi-gigabyte body exhausts the process. The repository already treats user-typed endpoints as requiring streamed caps — `llm-pi-ai` discovery refuses model listings past 4 MiB and `web-fetch-http` caps page reads at 5 MiB — but these four call sites predated or missed that rule.

## Decision

Every HTTP response body the host buffers is now read through a local two-stage bounded reader: a declared `Content-Length` over the ceiling cancels the unread body and refuses immediately; otherwise the stream accumulates and refuses once total bytes cross the ceiling. The ceiling is 4 MiB at all four sites (`MAX_RESPONSE_BYTES` in each search provider, `MAX_ERROR_BODY_BYTES` in the chat adapter), matching the discovery precedent for JSON metadata payloads and error bodies; successful adapter calls keep streaming SSE through `parseSse` and are never buffered. Overflow throws the caller's own error type with a message naming the provider and ceiling — `WebError` `WEB_PROVIDER_ERROR` for search replies, the status-mapped `LlmError` code for adapter error bodies — so an oversized reply fails loudly instead of wrapping as an unparseable-body diagnostic. Error-path enrichment keeps its existing rule that only a usable body can improve the status-line message, but an oversize refusal now escapes that fallback rather than hiding behind it.

Each package owns its private reader, beside the already-local abort and integer predicates, marked with `jscpd` ignore ranges. No shared utility package exists for HTTP transport internals; inventing one for one function would add cross-group public API surface against the seam packages' explicit keep-internals-local convention.

## Alternatives considered

**Share one reader from a new util package.** Rejected: the repo's established pattern is per-package private implementations (discovery, fetch-http truncating reader, agent-instructions file reader all differ locally), the search providers deliberately keep even two-line predicates out of the public seam, and a new package would couple four independent plugins to a new workspace dependency for one function.

**Truncate oversized bodies instead of refusing.** Rejected for these call sites: a truncated JSON document cannot parse, so truncation converts a clear refusal into a misleading "unprocessable response" while still paying most of the transfer cost; `web-fetch-http` may truncate because it returns prose to a consumer that tolerates partial pages.

**Cap only success bodies.** Rejected: the error path is the cheaper attack surface — a hostile endpoint can return an enormous body under any non-2xx status, which the old code buffered just as eagerly.

## Verification

Each search provider spec covers an exactly-at-ceiling success reply parsing normally, a streamed reply crossing the ceiling refused on both success and error paths with the exact refusal message, a declared-length refusal proven not to drain the body (the fixture stream never closes), and aborts during bounded reads surfacing as `WEB_ABORTED`. Adapter specs cover a streamed oversized error body and a declared-length one through the real mock HTTP server. Existing suites pin unchanged behavior for normal, malformed, and abort paths.

## Consequences

A configured endpoint can no longer exhaust host memory through any buffered response read; worst case per call is the 4 MiB ceiling plus chunk assembly. A legitimate endpoint answering above the ceiling now fails its call instead of succeeding — none of the covered payloads plausibly reach 4 MiB when well-formed. The four readers duplicate one another by design; a future transport-wide HTTP service (the `TODO(http)` adoption noted in the adapter) remains the place to consolidate them.
