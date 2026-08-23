import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { Context } from '@buckeyestudio/cordis'
import WebRuntime from '@buckeyestudio/toh-web'
import { HttpFetchProvider, LOCAL_FETCH_PROVIDER_ID } from '@buckeyestudio/toh-web-fetch-http'
import type { HttpFetchLimits } from '@buckeyestudio/toh-web-fetch-http'
import * as fetchPlugin from '@buckeyestudio/toh-web-fetch-http'
import { classifyBlockedRange, createPrivateNetworkPolicy, isLocalNetworkHostname } from '../src/private-network.ts'
import type { HostResolver, PrivateNetworkPolicy, ResolvedAddress } from '../src/private-network.ts'
import { pinnedLookup } from '../src/provider.ts'
import { classifyContentType, decoderForCharset, isSameOrigin, parseCharset, validateFetchUrl } from '../src/policy.ts'

// The loopback fixture servers below are the explicitly trusted composition:
// every provider under test opts in, while dedicated suites prove the
// shipped default blocks these same targets.
const limits: HttpFetchLimits = {
  maxUrlLength: 2048,
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 5_000,
  maxRedirects: 5,
  userAgent: 'test-agent/1.0',
  allowPrivateNetworks: true,
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void

let server: Server
let base: string
let handler: Handler
/** Requests answered by the fixture server in the current test (any suite may assert it). */
let servedRequests = 0

beforeEach(async () => {
  handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('default') }
  servedRequests = 0
  server = createServer((req, res) => { servedRequests++; handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await new Promise<void>(resolve => server.close(() => { resolve() }))
})

function provider(overrides: Partial<HttpFetchLimits> = {}, policy?: PrivateNetworkPolicy): HttpFetchProvider {
  return new HttpFetchProvider({ ...limits, ...overrides }, policy)
}

describe('policy helpers', () => {
  it('validates scheme, credentials, and length', () => {
    expect(validateFetchUrl('https://example.com/x', 2048).hostname).toBe('example.com')
    expect(() => validateFetchUrl('ftp://example.com', 2048)).toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
    expect(() => validateFetchUrl('not a url', 2048)).toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
    expect(() => validateFetchUrl('https://user:pass@example.com', 2048)).toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    expect(() => validateFetchUrl(`https://example.com/${'a'.repeat(3000)}`, 2048)).toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
  })

  it('classifies content types', () => {
    expect(classifyContentType('text/html; charset=utf-8')).toBe('html')
    expect(classifyContentType('application/xhtml+xml')).toBe('html')
    expect(classifyContentType('text/plain')).toBe('text')
    expect(classifyContentType('application/json')).toBe('text')
    expect(classifyContentType('image/png')).toBeUndefined()
    expect(classifyContentType(null)).toBeUndefined()
  })

  it('compares origins', () => {
    expect(isSameOrigin(new URL('https://a.com/x'), new URL('https://a.com/y'))).toBe(true)
    expect(isSameOrigin(new URL('https://a.com'), new URL('https://b.com'))).toBe(false)
    expect(isSameOrigin(new URL('http://a.com'), new URL('https://a.com'))).toBe(false)
  })

  it('parses the charset parameter', () => {
    expect(parseCharset('text/html; charset=UTF-8')).toBe('utf-8')
    expect(parseCharset('text/plain; charset="iso-8859-1"')).toBe('iso-8859-1')
    expect(parseCharset('text/plain')).toBeUndefined()
    expect(parseCharset(null)).toBeUndefined()
  })

  it('builds a decoder for a charset and defaults to UTF-8', () => {
    expect(decoderForCharset(undefined).encoding).toBe('utf-8')
    expect(decoderForCharset('iso-8859-1').encoding).toBe('windows-1252')
    expect(() => decoderForCharset('not-a-charset')).toThrow(expect.objectContaining({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' }))
  })
})

describe('private-network classification', () => {
  const blockedCases: Array<[address: string, range: string]> = [
    // Loopback and unspecified.
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['0.0.0.0', 'unspecified'],
    ['0.255.0.0', 'unspecified'],
    // RFC 1918 private.
    ['10.1.2.3', 'private'],
    ['172.16.0.0', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    // Link-local, including the cloud-metadata endpoint.
    ['169.254.169.254', 'link-local'],
    // CGNAT shared address space (100.64/10).
    ['100.64.0.0', 'shared-address-space'],
    ['100.127.255.255', 'shared-address-space'],
    // Multicast, reserved, and broadcast.
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
    // Documentation ranges are not public destinations either.
    ['192.0.2.9', 'documentation'],
    ['198.51.100.7', 'documentation'],
    ['203.0.113.99', 'documentation'],
    // IPv6 loopback, unspecified, ULA fc00::/7, link-local fe80::/10,
    // deprecated site-local fec0::/10, multicast ff00::/8, documentation.
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'unique-local'],
    ['fc00::', 'unique-local'],
    ['fd12:3456:789a::1', 'unique-local'],
    ['fe80::1', 'link-local'],
    ['febf::ffff', 'link-local'],
    ['fec0::1', 'deprecated-site-local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    // IPv4-mapped IPv6 classifies by its embedded IPv4 destination.
    ['::ffff:10.0.0.5', 'private'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:169.254.9.9', 'link-local'],
    // The deprecated IPv4-compatible form embeds the same way.
    ['::10.0.0.5', 'private'],
    ['::0.0.0.5', 'unspecified'],
    // The NAT64 well-known prefix carries an embedded IPv4 destination too.
    ['64:ff9b::10.0.0.5', 'private'],
  ]
  it.each(blockedCases)('classifies %s as %s', (address, range) => {
    expect(classifyBlockedRange(address)).toBe(range)
  })

  const publicCases = [
    // Boundaries just outside every blocked prefix.
    '8.8.8.8',
    '172.32.0.0',
    '172.15.255.255',
    '100.63.255.255',
    '100.128.0.1',
    '169.253.0.1',
    '198.51.101.1',
    '203.0.114.1',
    '2606:4700:4700::1111',
    // Uncompressed (no `::`) presentation parses the same as compressed.
    '2001:4860:4860:0000:0000:0000:0000:8888',
    '::ffff:8.8.8.8',
  ]
  it.each(publicCases.map(address => [address] as const))('classifies %s as public', (address) => {
    expect(classifyBlockedRange(address)).toBeUndefined()
  })

  it.each([
    ['not-an-ip'],
    ['1.2.3'],
    ['1.2.3.4.5'],
    ['256.1.1.1'],
    ['01.02.03.04'],
    ['::gggg::1'],
    ['1:2:3:4:5:6:7:8:9'],
    ['1::2::3'],
  ])('fails closed on unrecognized input %s', (address) => {
    expect(classifyBlockedRange(address)).toBe('unrecognized-address')
  })
})

describe('local-network hostnames', () => {
  it.each([
    ['localhost'],
    ['LOCALHOST'],
    ['localhost.'],
    ['sub.localhost'],
    ['printer.local'],
  ])('recognizes %s as a local-network name', (hostname) => {
    expect(isLocalNetworkHostname(hostname)).toBe(true)
  })

  it.each([
    ['example.com'],
    ['local'],
    ['notlocalhost'],
    ['local.dev'],
  ])('treats %s as a public name', (hostname) => {
    expect(isLocalNetworkHostname(hostname)).toBe(false)
  })
})

/** A resolver over a fixed hostname→records table; unknown names fail like ENOTFOUND. */
function fakeResolver(records: Record<string, ResolvedAddress[]>): HostResolver {
  return async (hostname) => {
    const hit = records[hostname]
    if (hit === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' })
    return hit
  }
}

describe('private-network policy', () => {
  it('blocks a hostname resolving into a non-public range', async () => {
    const policy = createPrivateNetworkPolicy({ allowPrivateNetworks: false, resolve: fakeResolver({ 'private.test': [{ address: '10.0.0.9', family: 4 }] }) })
    await expect(policy.resolveValidated('private.test'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PRIVATE_NETWORK_BLOCKED', message: expect.stringContaining('10.0.0.9') as string }))
  })

  it('blocks when any one of several resolved addresses is non-public', async () => {
    const policy = createPrivateNetworkPolicy({
      allowPrivateNetworks: false,
      resolve: fakeResolver({ 'mixed.test': [{ address: '93.184.216.34', family: 4 }, { address: 'fd00::1', family: 6 }] }),
    })
    await expect(policy.resolveValidated('mixed.test'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PRIVATE_NETWORK_BLOCKED' }))
  })

  it('passes validated addresses through in resolution order', async () => {
    const records: ResolvedAddress[] = [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }]
    const policy = createPrivateNetworkPolicy({ allowPrivateNetworks: false, resolve: fakeResolver({ 'public.test': records }) })
    await expect(policy.resolveValidated('public.test')).resolves.toEqual(records)
  })

  it('permits non-public resolutions only under allowPrivateNetworks', async () => {
    const records: ResolvedAddress[] = [{ address: '192.168.0.20', family: 4 }]
    const allowing = createPrivateNetworkPolicy({ allowPrivateNetworks: true, resolve: fakeResolver({ 'private.test': records }) })
    await expect(allowing.resolveValidated('private.test')).resolves.toEqual(records)
  })

  it('blocks local-network names without consulting the resolver', async () => {
    let resolverCalls = 0
    const policy = createPrivateNetworkPolicy({
      allowPrivateNetworks: false,
      resolve: async () => { resolverCalls++; return [] },
    })
    await expect(policy.resolveValidated('metadata.internal.local'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PRIVATE_NETWORK_BLOCKED' }))
    expect(resolverCalls).toBe(0)
  })

  it('skips resolution for literal-IP hostnames and classifies them directly', async () => {
    let resolverCalls = 0
    const policy = createPrivateNetworkPolicy({
      allowPrivateNetworks: false,
      resolve: async () => { resolverCalls++; return [] },
    })
    await expect(policy.resolveValidated('127.0.0.1'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PRIVATE_NETWORK_BLOCKED' }))
    await expect(policy.resolveValidated('8.8.8.8')).resolves.toEqual([{ address: '8.8.8.8', family: 4 }])
    expect(resolverCalls).toBe(0)
  })

  it('fails closed when the resolver returns an unrecognizable record', async () => {
    const policy = createPrivateNetworkPolicy({ allowPrivateNetworks: false, resolve: async () => [{ address: 'corrupt', family: 4 }] })
    await expect(policy.resolveValidated('weird.test'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PRIVATE_NETWORK_BLOCKED' }))
  })

  it('re-validates fresh resolution on each call — the property redirect hops rely on', async () => {
    let calls = 0
    const flipping: HostResolver = async () => {
      calls++
      return calls === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '10.0.0.9', family: 4 }]
    }
    const policy = createPrivateNetworkPolicy({ allowPrivateNetworks: false, resolve: flipping })
    await expect(policy.resolveValidated('rebinding.test')).resolves.toHaveLength(1)
    await expect(policy.resolveValidated('rebinding.test'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PRIVATE_NETWORK_BLOCKED', message: expect.stringContaining('10.0.0.9') as string }))
    expect(calls).toBe(2)
  })
})

describe('HttpFetchProvider success', () => {
  it('fetches a text body', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hello world') }
    const result = await provider().fetch({ url: base })
    expect(provider().available()).toBe(true)
    expect(result.statusCode).toBe(200)
    expect(result.body).toEqual({ kind: 'text', content: 'hello world' })
    expect(result.truncated).toBe(false)
  })

  it('fetches an html body and classifies it as html', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>hi</h1>') }
    const result = await provider().fetch({ url: base })
    expect(result.body).toEqual({ kind: 'html', content: '<h1>hi</h1>' })
  })

  it('sends the configured user agent', async () => {
    let seen: string | undefined
    handler = (req, res) => { seen = req.headers['user-agent']; res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok') }
    await provider().fetch({ url: base })
    expect(seen).toBe('test-agent/1.0')
  })

  it('returns a non-2xx response as a result, not an error', async () => {
    handler = (_req, res) => { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope') }
    const result = await provider().fetch({ url: base })
    expect(result.statusCode).toBe(404)
    expect(result.body).toEqual({ kind: 'text', content: 'nope' })
  })
})

describe('HttpFetchProvider caps', () => {
  it('rejects an over-cap Content-Length with WEB_FETCH_TOO_LARGE', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '999999' }); res.end('x'.repeat(999999)) }
    await expect(provider({ maxResponseBytes: 10 }).fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_FETCH_TOO_LARGE' }))
  })

  it('truncates a stream that grows past the byte cap', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('abcdefghij') }
    const result = await provider({ maxResponseBytes: 4 }).fetch({ url: base })
    expect(result.body.content).toBe('abcd')
    expect(result.truncated).toBe(true)
  })

  it('does not flag a body that exactly fills the byte cap as truncated', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('abcd') }
    const result = await provider({ maxResponseBytes: 4 }).fetch({ url: base })
    expect(result.body.content).toBe('abcd')
    expect(result.truncated).toBe(false)
  })

  it('truncates a decoded body past the character cap', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('abcdefghij') }
    const result = await provider({ maxBodyChars: 3 }).fetch({ url: base })
    expect(result.body.content).toBe('abc')
    expect(result.truncated).toBe(true)
  })

  it('rejects an unsupported content type', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end('binary') }
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' }))
  })

  it('rejects a response with no content type at all', async () => {
    handler = (_req, res) => { res.writeHead(200); res.end('no type') }
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' }))
  })

  it('accepts a declared content-length within the cap', async () => {
    handler = (_req, res) => { const body = 'sized'; res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(body.length) }); res.end(body) }
    const result = await provider().fetch({ url: base })
    expect(result.body.content).toBe('sized')
  })

  it('decodes a non-UTF-8 declared charset', async () => {
    // 0xE9 is "é" in ISO-8859-1; decoded as UTF-8 it would be a replacement char.
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain; charset=iso-8859-1' }); res.end(Buffer.from([0x63, 0x61, 0x66, 0xE9])) }
    const result = await provider().fetch({ url: base })
    expect(result.body.content).toBe('café')
  })

  it('joins repeated headers and keeps array-valued headers readable', async () => {
    // set-cookie always arrives as an array; the adapter must not choke on it.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': ['a=1', 'b=2'] })
      res.end('ok')
    }
    const result = await provider().fetch({ url: base })
    expect(result.statusCode).toBe(200)
  })

  it('rejects an unsupported declared charset', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain; charset=not-a-charset' }); res.end('x') }
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' }))
  })
})

describe('HttpFetchProvider redirects', () => {
  it('follows a same-origin redirect and reports the final URL', async () => {
    handler = (req, res) => {
      if (req.url === '/start') { res.writeHead(302, { location: '/end' }); res.end() }
      else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('arrived') }
    }
    const result = await provider().fetch({ url: `${base}/start` })
    expect(result.body.content).toBe('arrived')
    expect(result.url).toBe(`${base}/end`)
  })

  it('blocks a cross-origin redirect with WEB_REDIRECT_BLOCKED', async () => {
    handler = (_req, res) => { res.writeHead(302, { location: 'https://example.com/' }); res.end() }
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED' }))
  })

  it('re-validates a redirect target, rejecting same-origin credentials in the Location', async () => {
    const { port } = server.address() as AddressInfo
    handler = (_req, res) => { res.writeHead(302, { location: `http://user:pass@127.0.0.1:${port}/` }); res.end() }
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it('rejects exceeding the redirect hop cap', async () => {
    handler = (req, res) => {
      const n = Number(new URL(req.url ?? '/', base).searchParams.get('n') ?? '0')
      res.writeHead(302, { location: `/?n=${n + 1}` })
      res.end()
    }
    await expect(provider({ maxRedirects: 2 }).fetch({ url: `${base}/?n=0` }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED' }))
  })

  it('follows exactly maxRedirects hops: a chain landing on the Nth redirect succeeds', async () => {
    // maxRedirects: 2 → /?n=0 → /?n=1 → /?n=2(200). Exactly 2 redirects + 1
    // final = 3 requests; the cap is inclusive of the landing request.
    let requests = 0
    handler = (req, res) => {
      requests++
      const n = Number(new URL(req.url ?? '/', base).searchParams.get('n') ?? '0')
      if (n >= 2) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('landed') }
      else { res.writeHead(302, { location: `/?n=${n + 1}` }); res.end() }
    }
    const result = await provider({ maxRedirects: 2 }).fetch({ url: `${base}/?n=0` })
    expect(result.body.content).toBe('landed')
    expect(requests).toBe(3)
  })

  it('makes exactly maxRedirects+1 requests before blocking an over-long chain', async () => {
    // maxRedirects: 2 on an infinite chain: requests at n=0,1,2 (the 3rd is the
    // over-limit redirect, refused before its Location is followed) = 3 total.
    let requests = 0
    handler = (req, res) => {
      requests++
      const n = Number(new URL(req.url ?? '/', base).searchParams.get('n') ?? '0')
      res.writeHead(302, { location: `/?n=${n + 1}` })
      res.end()
    }
    await expect(provider({ maxRedirects: 2 }).fetch({ url: `${base}/?n=0` }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED', message: 'exceeded the maximum of 2 redirects' }))
    expect(requests).toBe(3)
  })

  it('reports an over-limit redirect as "exceeded", not cross-origin, even when the over-limit hop points cross-origin', async () => {
    // The redirect budget is checked BEFORE the over-limit hop's target is
    // origin-validated, so the diagnosis is "exceeded", not "cross-origin".
    handler = (req, res) => {
      const n = Number(new URL(req.url ?? '/', base).searchParams.get('n') ?? '0')
      const location = n === 0 ? '/?n=1' : 'https://example.com/'
      res.writeHead(302, { location })
      res.end()
    }
    await expect(provider({ maxRedirects: 1 }).fetch({ url: `${base}/?n=0` }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED', message: 'exceeded the maximum of 1 redirects' }))
  })

  it('maxRedirects: 0 follows no redirect but still fetches a direct 200', async () => {
    handler = (req, res) => {
      if (req.url === '/r') { res.writeHead(302, { location: '/done' }); res.end() }
      else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('direct') }
    }
    await expect(provider({ maxRedirects: 0 }).fetch({ url: `${base}/r` }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED' }))
    const direct = await provider({ maxRedirects: 0 }).fetch({ url: `${base}/done` })
    expect(direct.body.content).toBe('direct')
  })

  it('treats a redirect without a Location header as a provider error', async () => {
    handler = (_req, res) => { res.writeHead(302); res.end() }
    await expect(provider().fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('follows a relative same-origin redirect', async () => {
    handler = (req, res) => {
      if (req.url === '/a') { res.writeHead(301, { location: 'b' }); res.end() }
      else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('landed') }
    }
    const result = await provider().fetch({ url: `${base}/a` })
    expect(result.body.content).toBe('landed')
  })
})

describe('HttpFetchProvider invalid URLs and abort', () => {
  it('rejects a non-http scheme before any network access', async () => {
    await expect(provider().fetch({ url: 'ftp://example.com' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
  })

  it('rejects credentials in the URL', async () => {
    await expect(provider().fetch({ url: 'http://user:pass@127.0.0.1/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it('honors a pre-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(provider().fetch({ url: base }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('aborts an in-flight fetch via the signal', async () => {
    handler = (_req, _res) => { /* never responds */ }
    const controller = new AbortController()
    const promise = provider().fetch({ url: base }, controller.signal)
    controller.abort()
    await expect(promise).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('times out a slow response with WEB_FETCH_TIMEOUT', async () => {
    handler = (_req, _res) => { /* never responds */ }
    await expect(provider({ timeoutMs: 50 }).fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_FETCH_TIMEOUT' }))
  })

  it('classifies a timeout DURING the body read as WEB_FETCH_TIMEOUT, not WEB_ABORTED', async () => {
    // Promise body that resolves headers (so fetch() returns) but a content-length
    // that outlasts the bytes sent, so readCapped()'s reader awaits more and the
    // timeout fires mid-read — the reader then surfaces a generic AbortError that
    // must still be recovered as the timeout reason via signal.reason.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' })
      res.write('partial')
      // never send the remaining bytes nor end the response
    }
    await expect(provider({ timeoutMs: 80 }).fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_FETCH_TIMEOUT' }))
  })

  it('maps a connection failure to WEB_PROVIDER_ERROR', async () => {
    // Port 1 on loopback is not listening: a real connection failure (not abort).
    await expect(provider().fetch({ url: 'http://127.0.0.1:1/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

})

describe('HttpFetchProvider private-network guard', () => {
  it('blocks a loopback target under the shipped default (allowPrivateNetworks: false)', async () => {
    await expect(provider({ allowPrivateNetworks: false }).fetch({ url: base }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PRIVATE_NETWORK_BLOCKED' }))
    expect(servedRequests).toBe(0)
  })

  it('blocks a literal-IP loopback URL without any resolution', async () => {
    await expect(provider({ allowPrivateNetworks: false }).fetch({ url: 'http://127.0.0.1:9/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PRIVATE_NETWORK_BLOCKED' }))
    expect(servedRequests).toBe(0)
  })

  it('blocks a localhost name through real OS resolution', async () => {
    // `localhost` resolves to loopback through the OS resolver on every
    // platform; no mocking — the shipped default must refuse it end to end.
    const { port } = server.address() as AddressInfo
    await expect(provider({ allowPrivateNetworks: false }).fetch({ url: `http://localhost:${port}/` }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PRIVATE_NETWORK_BLOCKED', message: expect.stringMatching(/localhost|loopback/) as string }))
    expect(servedRequests).toBe(0)
  })

  it('permits the same target once allowPrivateNetworks is opted into', async () => {
    const { port } = server.address() as AddressInfo
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('private ok') }
    const result = await provider().fetch({ url: `http://localhost:${port}/` })
    expect(result.body.content).toBe('private ok')
    expect(servedRequests).toBe(1)
  })

  it('pins each dial to the validated addresses, not a second resolution', async () => {
    // `pin.test` does not exist in OS DNS at all: the request can only reach
    // the fixture server because the dial used exactly the address list the
    // policy returned.
    const { port } = server.address() as AddressInfo
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('pinned') }
    const policy = createPrivateNetworkPolicy({ allowPrivateNetworks: true, resolve: fakeResolver({ 'pin.test': [{ address: '127.0.0.1', family: 4 }] }) })
    const result = await provider({}, policy).fetch({ url: `http://pin.test:${port}/` })
    expect(result.body.content).toBe('pinned')
    expect(servedRequests).toBe(1)
  })

  it('re-resolves and re-validates on every same-origin redirect hop', async () => {
    // Same-origin redirects keep the hostname string identical, so per-hop
    // address validation is what re-checks the destination each hop: the
    // resolver must be consulted once per request, twice for one redirect.
    const { port } = server.address() as AddressInfo
    let calls = 0
    const counting: HostResolver = async (hostname) => {
      calls++
      return hostname === 'hop.test' ? [{ address: '127.0.0.1', family: 4 }] : []
    }
    handler = (req, res) => {
      if (req.url === '/start') { res.writeHead(302, { location: '/end' }); res.end() }
      else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('arrived') }
    }
    const policy = createPrivateNetworkPolicy({ allowPrivateNetworks: true, resolve: counting })
    const result = await provider({}, policy).fetch({ url: `http://hop.test:${port}/start` })
    expect(result.body.content).toBe('arrived')
    expect(calls).toBe(2)
    expect(servedRequests).toBe(2)
  })

  it('blocks a redirect hop whose fresh resolution lands in a non-public range', async () => {
    // The policy-level property behind the per-hop check: hop 1 validates
    // cleanly; by hop 2 the same hostname resolves into a private range, and
    // validation fails without dialing.
    let calls = 0
    const flipping: HostResolver = async (hostname) => {
      calls++
      return hostname === 'flip.test'
        ? (calls === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.0.0.9', family: 4 }])
        : []
    }
    const allowing = createPrivateNetworkPolicy({ allowPrivateNetworks: true, resolve: flipping })
    const validating = createPrivateNetworkPolicy({ allowPrivateNetworks: false, resolve: flipping })
    // The chain cannot run under the validating policy (hop 1's loopback
    // record is blocked there), so prove the flip is caught at the policy
    // layer with the same resolver state the second hop would see.
    await expect(allowing.resolveValidated('flip.test')).resolves.toHaveLength(1)
    await expect(validating.resolveValidated('flip.test'))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PRIVATE_NETWORK_BLOCKED',
        message: expect.stringContaining('10.0.0.9') as string,
      }))
    expect(calls).toBe(2)
    expect(servedRequests).toBe(0)
  })

  it('surfaces resolver failure as WEB_PROVIDER_ERROR', async () => {
    const { port } = server.address() as AddressInfo
    const policy = createPrivateNetworkPolicy({
      allowPrivateNetworks: true,
      resolve: fakeResolver({}),
    })
    await expect(provider({}, policy).fetch({ url: `http://missing.test:${port}/` }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('applies the deadline while resolution itself is outstanding', async () => {
    const { port } = server.address() as AddressInfo
    const policy = createPrivateNetworkPolicy({
      allowPrivateNetworks: true,
      resolve: () => new Promise<ResolvedAddress[]>(() => { /* never settles */ }),
    })
    await expect(provider({ timeoutMs: 60 }, policy).fetch({ url: `http://slow-dns.test:${port}/` }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_FETCH_TIMEOUT' }))
    expect(servedRequests).toBe(0)
  })

  it('classifies an abort arriving during resolution as WEB_ABORTED', async () => {
    const { port } = server.address() as AddressInfo
    const controller = new AbortController()
    // A non-Error abort reason must still classify as WEB_ABORTED. The
    // hostname form keeps the request on the resolution path (literal IPs
    // never consult a resolver).
    const policy = createPrivateNetworkPolicy({
      allowPrivateNetworks: true,
      resolve: () => new Promise<ResolvedAddress[]>(() => {
        controller.abort('caller-cancelled')
      }),
    })
    await expect(provider({}, policy).fetch({ url: `http://slow-resolve.test:${port}/` }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(servedRequests).toBe(0)
  })
})

describe('pinnedLookup', () => {
  const addresses: ResolvedAddress[] = [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }]

  function callLookup(list: ResolvedAddress[], options: { all: boolean }): Promise<string | Array<{ address: string; family: number }>> {
    return new Promise((resolveCall, rejectCall) => {
      try {
        pinnedLookup(list)('', options, (error, result) => {
          if (error !== null) rejectCall(error)
          else resolveCall(result)
        })
      } catch (error: unknown) {
        rejectCall(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  it('returns only the first validated address in single-address form', async () => {
    await expect(callLookup(addresses, { all: false })).resolves.toBe('127.0.0.1')
  })

  it('returns every validated address in all-address form', async () => {
    await expect(callLookup(addresses, { all: true })).resolves.toEqual([
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
    ])
  })

  it('throws when handed an empty validated list', async () => {
    await expect(callLookup([], { all: true })).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('web-fetch-http plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    // The loopback fixture is the trusted-composition opt-in; the shipped
    // default's blocking behavior has its own suite above.
    const fiber = await ctx.plugin(fetchPlugin, { allowPrivateNetworks: true })
    await expect(ctx.web.fetch({ url: `${base}/` }))
      .resolves.toMatchObject({ statusCode: 200 })
    await fiber.dispose()
    await expect(ctx.web.fetch({ url: `${base}/` }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('blocks loopback under the default config, proving the shipped posture', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    const fiber = await ctx.plugin(fetchPlugin, {})
    await expect(ctx.web.fetch({ url: `${base}/` }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PRIVATE_NETWORK_BLOCKED' }))
    await fiber.dispose()
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in fetchPlugin).toBe(false)
  })

  it('rejects a non-positive resource limit at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(fetchPlugin, { maxResponseBytes: -1 }))
      .rejects.toThrow(/maxResponseBytes must be a positive finite number/)
  })

  it('rejects a zero timeout at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(fetchPlugin, { timeoutMs: 0 }))
      .rejects.toThrow(/timeoutMs must be a positive finite number/)
  })

  it('rejects a timeout beyond Node timer range at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(fetchPlugin, { timeoutMs: 2_147_483_648 }))
      .rejects.toThrow(/timeoutMs must be no greater than 2147483647/)
  })

  it('rejects a fractional redirect cap at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(fetchPlugin, { maxRedirects: 1.5 }))
      .rejects.toThrow(/maxRedirects must be a non-negative integer/)
  })

  it('rejects a negative redirect cap at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(fetchPlugin, { maxRedirects: -1 }))
      .rejects.toThrow(/maxRedirects must be a non-negative integer/)
  })

  it('accepts maxRedirects: 0 (follow no redirects) as valid config', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    const fiber = await ctx.plugin(fetchPlugin, { maxRedirects: 0, allowPrivateNetworks: true })
    await expect(ctx.web.fetch({ url: `${base}/` }))
      .resolves.toMatchObject({ statusCode: 200 })
    await fiber.dispose()
  })
})
