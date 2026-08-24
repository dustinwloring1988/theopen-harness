/**
 * Safe HTTP(S) retrieval for `ctx.web`: validates URLs, resolves and validates
 * the destination against the private-network policy, dials only validated
 * addresses, follows only same-origin redirects (re-validating every hop),
 * enforces time and size limits, classifies and decodes text, and leaves
 * presentation to `@buckeyestudio/toh-tool-web`. Requests carry no browser
 * cookies or ambient credentials.
 *
 * @module @buckeyestudio/toh-web-fetch-http/provider
 */

import http from 'node:http'
import https from 'node:https'
import type { IncomingMessage, RequestOptions } from 'node:http'
import type { Readable, Transform } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { WebError } from '@buckeyestudio/toh-web'
import type { WebFetchBody, WebFetchProvider, WebFetchRequest, WebFetchResult } from '@buckeyestudio/toh-web'
import { deadline, timeoutOf } from '@buckeyestudio/toh-timeout'
import type { ResolvedAddress } from './private-network.ts'
import { createPrivateNetworkPolicy } from './private-network.ts'
import type { PrivateNetworkPolicy } from './private-network.ts'
import { classifyContentType, decoderForCharset, isSameOrigin, parseCharset, validateFetchUrl } from './policy.ts'

/** Resolved provider limits (the plugin's schemastery Config supplies defaults). */
export interface HttpFetchLimits {
  /** Maximum accepted request URL length. */
  maxUrlLength: number
  /** Maximum response body size in bytes, measured after content-coding decoding (read is aborted past this). */
  maxResponseBytes: number
  /** Maximum decoded body length in characters (truncated past this). */
  maxBodyChars: number
  /** Default fetch timeout in milliseconds. */
  timeoutMs: number
  /** Maximum number of (same-origin) redirect hops to follow. */
  maxRedirects: number
  /** `User-Agent` header sent on every request. */
  userAgent: string
  /**
   * When false (default) every destination hostname must resolve to public
   * internet addresses; loopback, private, link-local, and otherwise
   * non-public destinations fail with `WEB_PRIVATE_NETWORK_BLOCKED`.
   */
  allowPrivateNetworks: boolean
}

/** Stable id this provider registers under. */
export const LOCAL_FETCH_PROVIDER_ID = 'http'

/** One transport-level response before content classification. */
interface TransportResponse {
  /** The HTTP status code. */
  status: number
  /** The response headers. */
  headers: Headers
  /** The raw response stream, drained or destroyed by the caller. */
  stream: IncomingMessage | null
}

/** The anonymous public HTTP(S) fetch provider. */
export class HttpFetchProvider implements WebFetchProvider {
  readonly id = LOCAL_FETCH_PROVIDER_ID

  /**
   * @param limits - the resolved transport and size limits.
   * @param policy - the private-network policy; defaults to composing one
   *   over the OS resolver under the configured allow switch.
   */
  constructor(
    private readonly limits: HttpFetchLimits,
    private readonly policy: PrivateNetworkPolicy = createPrivateNetworkPolicy({ allowPrivateNetworks: limits.allowPrivateNetworks }),
  ) {}

  /** No credentials to check â€” an anonymous public fetcher is always usable. */
  available(): boolean {
    return true
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')

    // One signal stops resolution, the request, and the body read. The deadline's
    // TimeoutReason later distinguishes this provider's timeout from caller or
    // outer-deadline cancellation.
    using d = deadline(signal, this.limits.timeoutMs, 'WEB_FETCH_TIMEOUT')
    return await this.followAndRead(request.url, d.signal)
  }

  /** Follow same-origin redirects up to the hop cap, then read the final response. */
  private async followAndRead(initialUrl: string, signal: AbortSignal): Promise<WebFetchResult> {
    let currentUrl = validateFetchUrl(initialUrl, this.limits.maxUrlLength)
    let redirectsFollowed = 0

    for (;;) {
      const response = await this.requestOnce(currentUrl, signal)

      if (isRedirectStatus(response.status)) {
        // Enforce the redirect budget before resolving or validating the next hop.
        if (redirectsFollowed >= this.limits.maxRedirects) {
          cancelStream(response)
          throw new WebError(`exceeded the maximum of ${this.limits.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED')
        }
        const location = response.headers.get('location')
        if (location === null) {
          // A redirect status with no Location is not a usable resource. Cancel
          // the stream before throwing so no socket leaks.
          cancelStream(response)
          throw new WebError(`redirect response (HTTP ${response.status}) without a Location header`, 'WEB_PROVIDER_ERROR')
        }
        const target = resolveRedirect(location, currentUrl)
        // Re-validate the target against the same transport hygiene a direct
        // request gets: a redirect must not be a back door to a credentialed,
        // non-http(s), or over-long URL that validateFetchUrl would reject.
        let validatedTarget: URL
        try {
          validatedTarget = validateFetchUrl(target.toString(), this.limits.maxUrlLength)
          if (!isSameOrigin(validatedTarget, currentUrl)) {
            throw new WebError(
              `cross-origin redirect to ${validatedTarget.origin} is not followed automatically; retry against that URL directly`,
              'WEB_REDIRECT_BLOCKED',
            )
          }
        } catch (error: unknown) {
          cancelStream(response)
          throw error
        }
        cancelStream(response)
        currentUrl = validatedTarget
        redirectsFollowed++
        continue
      }

      return await this.readBody(response, currentUrl, signal)
    }
  }

  /**
   * Run one request against `url`: resolve the hostname through the
   * private-network policy, dial one of the validated addresses, and return
   * the response head. Every redirect hop re-enters here, so each hop's
   * destination is re-resolved and re-validated.
   */
  private async requestOnce(url: URL, signal: AbortSignal): Promise<TransportResponse> {
    try {
      const addresses = await resolveBeforeDial(this.policy.resolveValidated(url.hostname), signal)
      return await openConnection(url, addresses, this.limits.userAgent, signal)
    } catch (error: unknown) {
      throw translateAbortOrNetwork(error, signal)
    }
  }

  /** Decode content-coding, byte-cap, classify, and charset-decode the final response body. */
  private async readBody(response: TransportResponse, finalUrl: URL, signal: AbortSignal): Promise<WebFetchResult> {
    const contentType = response.headers.get('content-type')
    const kind = classifyContentType(contentType)
    if (kind === undefined) {
      cancelStream(response)
      throw new WebError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }

    // Resolve the decoder BEFORE reading the body so an unsupported charset
    // fails without consuming the stream â€” but cancel the stream on that
    // failure so the socket does not leak (matching the unsupported-content-type path).
    let decoder: TextDecoder
    try {
      decoder = decoderForCharset(parseCharset(contentType))
    } catch (error: unknown) {
      cancelStream(response)
      throw error
    }
    const { bytes, truncatedByBytes } = await this.readCapped(response, signal)
    const decoded = decoder.decode(bytes)
    const truncatedByChars = decoded.length > this.limits.maxBodyChars
    const content = truncatedByChars ? decoded.slice(0, this.limits.maxBodyChars) : decoded
    const body: WebFetchBody = kind === 'html' ? { kind: 'html', content } : { kind: 'text', content }

    return {
      url: finalUrl.toString(),
      statusCode: response.status,
      body,
      truncated: truncatedByBytes || truncatedByChars,
    }
  }

  /**
   * Read the response body up to `maxResponseBytes`, measured AFTER
   * content-coding decoding so a compressed body cannot expand past the cap in
   * memory. A `Content-Length` over the cap rejects immediately with
   * `WEB_FETCH_TOO_LARGE`; it bounds the wire transfer (the compressed size
   * when a coding is declared). A stream that yields more decompressed bytes
   * than the cap is cut short (`truncatedByBytes`) rather than rejected, so a
   * server that under-reports still yields a bounded usable body.
   */
  private async readCapped(response: TransportResponse, signal: AbortSignal): Promise<{ bytes: Uint8Array; truncatedByBytes: boolean }> {
    const declared = response.headers.get('content-length')
    if (declared !== null) {
      const length = Number(declared)
      if (Number.isFinite(length) && length > this.limits.maxResponseBytes) {
        cancelStream(response)
        throw new WebError(`response exceeds the maximum of ${this.limits.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE')
      }
    }

    const raw = response.stream
    /* v8 ignore next -- a completed HTTP response always exposes a body stream; the null guard is defensive. */
    if (raw === null) return { bytes: new Uint8Array(0), truncatedByBytes: false }

    // Resolve the content coding BEFORE consuming the stream so an unsupported
    // declared coding fails without reading body bytes — but destroy the raw
    // stream on that failure so the socket does not leak (matching the
    // unsupported-charset path in readBody).
    let encoding: SupportedContentEncoding | undefined
    try {
      encoding = parseContentEncoding(response.headers.get('content-encoding'))
    } catch (error: unknown) {
      raw.destroy()
      throw error
    }
    const source = encoding === undefined ? raw : decodeContentStream(raw, encoding)

    const chunks: Uint8Array[] = []
    let total = 0
    let truncatedByBytes = false
    try {
      await new Promise<void>((fulfillRead, rejectRead) => {
        const detach = () => {
          source.off('data', onData)
          source.off('end', onEnd)
          source.off('error', onError)
        }
        const onData = (chunk: Buffer) => {
          const remaining = this.limits.maxResponseBytes - total
          // Only DROPPED bytes count as truncation: a chunk that exactly fills the
          // remaining capacity keeps all its bytes and we read on to observe EOF,
          // so an exactly-at-cap body is not falsely flagged truncated.
          if (chunk.byteLength > remaining) {
            chunks.push(chunk.subarray(0, remaining))
            total += remaining
            truncatedByBytes = true
            detach()
            fulfillRead()
            return
          }
          chunks.push(chunk)
          total += chunk.byteLength
        }
        const onEnd = () => {
          detach()
          fulfillRead()
        }
        const onError = (error: Error) => {
          detach()
          rejectRead(error)
        }
        source.on('data', onData)
        source.on('end', onEnd)
        source.on('error', onError)
      })
    } catch (error: unknown) {
      /* v8 ignore next -- a mid-stream read fault needs a network drop after headers; abort branches are covered by request-phase tests. */
      throw translateAbortOrNetwork(error, signal)
    } finally {
      /* v8 ignore start -- destroy() after a completed or faulted read is unobserved cleanup; the bytes we need are already collected. */
      raw.destroy()
      source.destroy()
      /* v8 ignore stop */
    }

    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, truncatedByBytes }
  }
}

/** The content codings this transport decodes (`x-gzip` normalizes to `gzip`). */
type SupportedContentEncoding = 'gzip' | 'deflate' | 'br'

/**
 * Parse the response `Content-Encoding` header into one supported coding.
 * An absent or empty value and `identity` mean no coding. Any other declared
 * coding throws {@link WebError} `WEB_UNSUPPORTED_CONTENT_TYPE` — the transport
 * never hands back bytes it could not decode.
 *
 * @param header - the raw `Content-Encoding` header value, or `null` when absent.
 * @returns the supported coding, or `undefined` when no decoding is needed.
 */
function parseContentEncoding(header: string | null): SupportedContentEncoding | undefined {
  const value = header?.trim().toLowerCase()
  if (value === undefined || value === '' || value === 'identity') return undefined
  if (value === 'gzip' || value === 'x-gzip') return 'gzip'
  if (value === 'deflate' || value === 'br') return value
  throw new WebError(`unsupported content encoding "${header}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
}

/** The streaming decoder for each supported content coding. */
const DECOMPRESSORS: Record<SupportedContentEncoding, () => Transform> = {
  gzip: createGunzip,
  deflate: createInflate,
  br: createBrotliDecompress,
}

/**
 * Pipe the raw response stream through its declared content-coding decoder and
 * return the stream whose bytes are the decoded body. `.pipe()` does not
 * forward source faults, so a socket error mid-body is forwarded explicitly —
 * otherwise the pending read would hang until the deadline instead of failing.
 * A standing noop error listener keeps a late decoder fault — arriving after
 * the read handlers detached — from surfacing as an unhandled 'error' event,
 * matching the raw stream's own guard.
 *
 * @param raw - the undecoded response stream.
 * @param encoding - the declared content coding to decode.
 * @returns the decoded-body stream.
 */
function decodeContentStream(raw: IncomingMessage, encoding: SupportedContentEncoding): Readable {
  const decompressor = DECOMPRESSORS[encoding]()
  raw.on('error', (error) => { decompressor.destroy(error) })
  decompressor.on('error', () => {})
  raw.pipe(decompressor)
  return decompressor
}

/** HTTP redirect status codes that carry a `Location`. */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** Resolve a (possibly relative) `Location` against the current URL. */
function resolveRedirect(location: string, base: URL): URL {
  try {
    return new URL(location, base)
  } catch (error: unknown) {
    /* v8 ignore next 2 -- URL resolution against a valid absolute base effectively never throws; defensive guard. */
    throw new WebError(`invalid redirect Location "${location}"`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

/**
 * Race one resolution step against the deadline signal, so a hung resolver
 * cannot outlive `timeoutMs` the way the dial itself cannot.
 *
 * @param resolution - the pending `resolveValidated` promise.
 * @param signal - the deadline signal to honor.
 * @returns the resolution outcome.
 */
async function resolveBeforeDial(
  resolution: Promise<readonly ResolvedAddress[]>,
  signal: AbortSignal,
): Promise<readonly ResolvedAddress[]> {
  /* v8 ignore next -- fetch()'s entry guard rejects caller-aborted signals first; a settled deadline here is only the listener race. */
  if (signal.aborted) throw rejectionReason(signal)
  const aborted = new Promise<never>((_resolve, rejectAborted) => {
    signal.addEventListener('abort', () => { rejectAborted(rejectionReason(signal)) }, { once: true })
  })
  return await Promise.race([resolution, aborted])
}

/** The abort reason when it is an Error, else a neutral error carrying nothing. */
function rejectionReason(signal: AbortSignal): Error {
  return asError(signal.reason)
}

/** Coerce an unknown thrown value into an Error for promise rejection. */
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Open the HTTP(S) connection through `pinnedLookup(addresses)`: Node consults
 * that lookup function instead of resolving again, so the socket lands on an
 * address the policy validated â€” there is no window in which a second,
 * unchecked resolution can pick the destination. TLS keeps the original
 * hostname for SNI and certificate verification.
 */
function openConnection(
  url: URL,
  addresses: readonly ResolvedAddress[],
  userAgent: string,
  signal: AbortSignal,
): Promise<TransportResponse> {
  /* v8 ignore next -- the TLS arm shares the identical request pipeline; exercising it needs TLS fixtures this suite does not carry. */
  const transport = url.protocol === 'https:' ? https.request : http.request
  return new Promise((resolveRequest, rejectRequest) => {
    const request = transport(url, {
      method: 'GET',
      headers: { 'user-agent': userAgent, 'accept': 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8' },
      lookup: pinnedLookup(addresses),
      signal,
    }, (response) => {
      /* v8 ignore start -- adaptResponse is total over any IncomingMessage; the catch keeps adapter regressions off unhandled events. */
      try {
        resolveRequest(adaptResponse(response))
      } catch (adaptError: unknown) {
        rejectRequest(asError(adaptError))
      }
      /* v8 ignore stop */
    })
    request.on('error', rejectRequest)
    request.end()
  })
}

/** The `lookup` option shape accepted by `http.request`. */
type LookupFunction = NonNullable<RequestOptions['lookup']>

/**
 * Build the `lookup` function that restricts one dial to the validated
 * address list, in both the single-address and `all` callback forms Node
 * requests.
 *
 * @param addresses - the validated addresses, in resolution order.
 * @returns the pinning lookup function.
 */
export function pinnedLookup(addresses: readonly ResolvedAddress[]): LookupFunction {
  /* v8 ignore next 3 -- the OS resolver hands back a non-empty record list; the empty-list guard is defensive. */
  const first = addresses[0]
  if (first === undefined) {
    throw new WebError('no resolved address is available to dial', 'WEB_PROVIDER_ERROR')
  }
  return ((_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, addresses.map(address => ({ address: address.address, family: address.family })))
      return
    }
    callback(null, first.address, first.family)
  })
}

/** Adapt an `IncomingMessage` into the transport-level response shape. */
function adaptResponse(response: IncomingMessage): TransportResponse {
  const headerEntries: [string, string][] = []
  for (const [key, value] of Object.entries(response.headers)) {
    /* v8 ignore next -- header entries carry a value or an array of values; the null fallback is defensive. */
    headerEntries.push([key, Array.isArray(value) ? value.join(', ') : value ?? ''])
  }
  /* v8 ignore next -- a completed HTTP response always reports a status code; the null guard is defensive. */
  const status = response.statusCode ?? 0
  // A standing noop error listener keeps a late socket fault â€” arriving after
  // the read handlers detached â€” from surfacing as an unhandled 'error' event;
  // read-phase faults surface through readCapped's own listener.
  response.on('error', () => {})
  return { status, headers: new Headers(headerEntries), stream: response }
}

/** Destroy the response stream so a refused hop leaks no socket. */
function cancelStream(response: TransportResponse): void {
  /* v8 ignore next -- every completed response carries a stream; the null guard is defensive. */
  response.stream?.destroy()
}

/**
 * Translate a thrown resolution/connection/stream error into a `WebError`,
 * classified by the deadline signal rather than the thrown value (which
 * differs by phase). A `WebError` â€” the private-network policy's block, for
 * example â€” passes through unchanged: it is already the classified outcome.
 * `timeoutOf(signal, 'WEB_FETCH_TIMEOUT')` recovering OUR reason means our
 * timeout fired (`WEB_FETCH_TIMEOUT`); any other abort â€” an upstream cancel,
 * or a foreign/outer deadline's timeout under nesting â€” is `WEB_ABORTED`; a
 * throw with the signal NOT aborted is a transport/network failure
 * (`WEB_PROVIDER_ERROR`, including DNS failure and connection refusal).
 */
function translateAbortOrNetwork(error: unknown, signal: AbortSignal): WebError {
  if (error instanceof WebError) return error
  const timeout = timeoutOf(signal, 'WEB_FETCH_TIMEOUT')
  if (timeout !== undefined) return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: timeout })
  if (signal.aborted) return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
  return new WebError(`web fetch failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}
