/**
 * Private-network policy for the local HTTP(S) fetch provider: resolve a
 * hostname, decide whether every resolved address is a public destination,
 * and hand back exactly the validated address list so the caller can pin its
 * connection to what was checked. Composed by `toh-web-fetch-http`; shaped so
 * another fetch provider can reuse it unchanged.
 *
 * @module @buckeyestudio/toh-web-fetch-http/private-network
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { WebError } from '@buckeyestudio/toh-web'

/** One DNS-resolved (or literal) destination address. */
export interface ResolvedAddress {
  /** The address in standard textual form. */
  readonly address: string
  /** The IP family of {@link ResolvedAddress.address}. */
  readonly family: 4 | 6
}

/**
 * Resolve one hostname to its candidate dial addresses. The default
 * implementation is the OS resolver (`dns.lookup` with `all: true`,
 * `verbatim: true`) — the same source Node's own dialing consults.
 */
export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>

/**
 * The OS resolver, exposed so callers compose policies over one resolution
 * source.
 *
 * @param hostname - the hostname to resolve.
 * @returns every record the resolver hands back for it.
 */
export const systemHostResolver: HostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, order: 'verbatim' })
  return records.map(record => ({ address: record.address, family: record.family as 4 | 6 }))
}

/**
 * The non-public IP ranges this policy recognizes. Every range routes only
 * inside a host or a closed administrative scope; none is reachable as a
 * public internet destination.
 */
export type NonPublicRange =
  | 'loopback'
  | 'unspecified'
  | 'private'
  | 'link-local'
  | 'shared-address-space'
  | 'ietf-protocol-assignments'
  | 'relay-anycast'
  | 'benchmarking'
  | 'multicast'
  | 'reserved'
  | 'broadcast'
  | 'unique-local'
  | 'deprecated-site-local'
  | 'documentation'

/** A blocked classification: a named non-public range, or an address outside every known form. */
export type BlockedRange = NonPublicRange | 'unrecognized-address'

/**
 * Classify one textual address into the non-public range it belongs to, or
 * `undefined` when it is a public unicast address. An input that is neither a
 * valid IPv4 nor IPv6 address classifies as `'unrecognized-address'` so the
 * policy fails closed on malformed resolver output.
 *
 * @param address - the textual address to classify.
 * @returns the blocking range, or `undefined` for a public address.
 */
export function classifyBlockedRange(address: string): BlockedRange | undefined {
  const family = isIP(address)
  if (family === 4) return classifyIPv4(address)
  if (family === 6) return classifyIPv6(address)
  return 'unrecognized-address'
}

/**
 * Parse dotted-quad IPv4 into its unsigned 32-bit value. Only reachable with
 * input `isIP` already accepted (or the embedded tail of such an address), so
 * the four-octet form is assumed.
 */
function ipv4Value(address: string): number {
  return address.split('.').reduce((value, part) => value * 256 + Number.parseInt(part, 10), 0)
}

function classifyIPv4(address: string): BlockedRange | undefined {
  const value = ipv4Value(address)
  const octet1 = value >>> 24
  const octet2 = value >>> 16 & 0xff
  const octet3 = value >>> 8 & 0xff
  if (octet1 === 127) return 'loopback'
  if (octet1 === 0) return 'unspecified'
  // RFC 1918: 10/8, 172.16/12, 192.168/16.
  if (octet1 === 10 || (octet1 === 172 && octet2 >= 0x10 && octet2 <= 0x1f) || (octet1 === 192 && octet2 === 168)) return 'private'
  if (octet1 === 169 && octet2 === 254) return 'link-local'
  // CGNAT shared address space: 100.64/10.
  if (octet1 === 100 && octet2 >= 64 && octet2 < 128) return 'shared-address-space'
  // IETF protocol assignments (192.0.0/24): anycast services such as PCP and
  // NAT64 discovery that route inside administrative scopes, not the internet.
  if (octet1 === 192 && octet2 === 0 && octet3 === 0) return 'ietf-protocol-assignments'
  // Deprecated 6to4 relay anycast (192.88.99/24): returned to IANA by RFC 7526;
  // no legitimate public endpoint lives here.
  if (octet1 === 192 && octet2 === 88 && octet3 === 99) return 'relay-anycast'
  // Benchmarking space (198.18/15): routed only inside test networks.
  if (octet1 === 198 && octet2 >= 18 && octet2 <= 19) return 'benchmarking'
  if ((octet1 & 0xf0) === 0xe0) return 'multicast'
  if ((octet1 & 0xf0) === 0xf0) return octet1 === 255 && (value & 0x00ff_ffff) === 0x00ff_ffff ? 'broadcast' : 'reserved'
  if (octet1 === 192 && octet2 === 0 && octet3 === 2) return 'documentation'
  if (octet1 === 198 && octet2 === 51 && octet3 === 100) return 'documentation'
  if (octet1 === 203 && octet2 === 0 && octet3 === 113) return 'documentation'
  return undefined
}

/** The eight 16-bit groups of one IPv6 address, in presentation order. */
type Ipv6Groups = [number, number, number, number, number, number, number, number]

/**
 * Parse an IPv6 address into its eight 16-bit groups, accepting `::`
 * compression and a trailing embedded IPv4 tail (`::ffff:1.2.3.4`). Only
 * reachable with input `isIP` already accepted, so the segment layout is
 * assumed well-formed.
 */
function ipv6Groups(address: string): Ipv6Groups {
  const separator = address.indexOf('::')
  const compressed = separator !== -1
  const head = compressed ? address.slice(0, separator) : address
  const tail = compressed ? address.slice(separator + 2) : ''
  const headSegments = head.length === 0 ? [] : head.split(':')
  const tailSegments = tail.length === 0 ? [] : tail.split(':')

  // The only non-hex segment form `isIP` accepts is a final dotted quad.
  const parseSegments = (segments: string[]): number[] => {
    const parsed: number[] = []
    for (const segment of segments) {
      if (/^[\da-fA-F]{1,4}$/.test(segment)) {
        parsed.push(Number.parseInt(segment, 16))
        continue
      }
      const embedded = ipv4Value(segment)
      parsed.push(embedded >>> 16, embedded & 0xffff)
    }
    return parsed
  }

  const parsedHead = parseSegments(headSegments)
  const parsedTail = compressed ? parseSegments(tailSegments) : []

  // An embedded IPv4 tail parses into two groups, so the group count — not the
  // segment count — decides.
  const totalGroups = parsedHead.length + parsedTail.length
  const zeros = new Array<number>(8 - totalGroups).fill(0)
  return [...parsedHead, ...zeros, ...parsedTail] as Ipv6Groups
}

function classifyIPv6(address: string): BlockedRange | undefined {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = ipv6Groups(address)

  // Embedded IPv4 forms (::ffff:a.b.c.d mapped, ::a.b.c.d compatible, and the
  // NAT64 well-known prefix 64:ff9b::/96) carry an IPv4 destination in their
  // low bits; the embedded address decides.
  if (g0 === 0x64 && g1 === 0xff9b && [g2, g3, g4, g5].every(group => group === 0)) {
    return classifyEmbeddedIPv4(g6, g7)
  }
  if ([g0, g1, g2, g3, g4].every(group => group === 0) && (g5 === 0xffff || g5 === 0)) {
    if (g5 === 0 && g6 === 0) {
      if (g7 === 1) return 'loopback'
      if (g7 === 0) return 'unspecified'
    }
    return classifyEmbeddedIPv4(g6, g7)
  }

  // A 6to4 address (2002::/16) tunnels to the IPv4 destination embedded after
  // the relay prefix, so a non-public embedded destination targets a closed
  // scope; with a public embedded destination the address stays public.
  if (g0 === 0x2002) {
    const embedded = classifyEmbeddedIPv4(g1, g2)
    if (embedded !== undefined) return embedded
  }

  if ((g0 & 0xfe00) === 0xfc00) return 'unique-local'
  if ((g0 & 0xffc0) === 0xfe80) return 'link-local'
  if ((g0 & 0xffc0) === 0xfec0) return 'deprecated-site-local'
  if ((g0 & 0xff00) === 0xff00) return 'multicast'
  if (g0 === 0x2001 && g1 === 0x0db8) return 'documentation'
  return undefined
}

/** Classify the IPv4 destination carried in two 16-bit groups. */
function classifyEmbeddedIPv4(high: number, low: number): BlockedRange | undefined {
  return classifyIPv4(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`)
}

/**
 * Hostname forms whose resolution stays inside the local network stack:
 * RFC 6761 `localhost` names (which resolve to loopback by specification) and
 * `.local` mDNS names (which resolve only on the local link). Blocking them by
 * name keeps the policy independent of whatever resolver answers.
 *
 * @param hostname - the hostname from the request URL.
 * @returns true when the name only ever resolves inside the local network stack.
 */
export function isLocalNetworkHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '')
  return name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local')
}

/** Options for {@link createPrivateNetworkPolicy}. */
export interface PrivateNetworkPolicyOptions {
  /**
   * When true the policy resolves as usual but classifies nothing, permitting
   * loopback, private, and otherwise non-public destinations. Default false:
   * only public internet destinations are fetchable.
   */
  allowPrivateNetworks: boolean
  /** Resolver override for callers composing the policy over a different resolution source. */
  resolve?: HostResolver
}

/** The composed private-network policy: resolve, classify, and return validated addresses. */
export interface PrivateNetworkPolicy {
  /** Whether non-public destinations are permitted, as configured. */
  readonly allowPrivateNetworks: boolean
  /**
   * Resolve `hostname` and return every address the dial may use. Throws
   * {@link WebError} `WEB_PRIVATE_NETWORK_BLOCKED` when any resolved address
   * (or the hostname itself) lands in a non-public range and private networks
   * are not allowed. Literal IP hostnames are classified without resolution;
   * a bracketed IPv6 literal (`[::1]`) is classified as its unbracketed
   * address, which is also what the returned list carries.
   *
   * @param hostname - the hostname from the request URL.
   * @returns the validated addresses, in resolution order.
   */
  resolveValidated(hostname: string): Promise<readonly ResolvedAddress[]>
}

/**
 * Compose a private-network policy over a resolver. Callers resolve before
 * dialing and restrict their connection to the returned addresses, so the
 * address they validated is the address they contact — there is no gap in
 * which a second, unchecked resolution can pick the destination.
 *
 * @param options - the allow switch and optional resolver.
 * @returns the composed policy.
 */
export function createPrivateNetworkPolicy(options: PrivateNetworkPolicyOptions): PrivateNetworkPolicy {
  const resolve = options.resolve ?? systemHostResolver
  const allowPrivateNetworks = options.allowPrivateNetworks
  return {
    allowPrivateNetworks,
    async resolveValidated(hostname: string): Promise<readonly ResolvedAddress[]> {
      // Literal IP hostnames classify directly: no resolver participates, so
      // the dial cannot be steered by DNS at all. URL serialization keeps the
      // brackets around an IPv6 literal (`[::1]`), while `isIP` and the dial
      // both speak the bare address; classify and return that form.
      const name = unwrapIpv6Literal(hostname)
      const literalFamily = isIP(name)
      if (literalFamily !== 0) {
        if (allowPrivateNetworks) return [{ address: name, family: literalFamily as 4 | 6 }]
        const range = classifyBlockedRange(name)
        if (range === undefined) return [{ address: name, family: literalFamily as 4 | 6 }]
        throw new WebError(`"${name}" is a ${range} address; fetching non-public destinations is blocked`, 'WEB_PRIVATE_NETWORK_BLOCKED')
      }
      if (!allowPrivateNetworks && isLocalNetworkHostname(name)) {
        throw new WebError(`"${name}" is a local-network hostname; fetching non-public destinations is blocked`, 'WEB_PRIVATE_NETWORK_BLOCKED')
      }
      const addresses = await resolve(name)
      if (!allowPrivateNetworks) {
        for (const resolved of addresses) assertPublicAddress(name, resolved)
      }
      return addresses
    },
  }
}

/** Strip the brackets URL serialization keeps around an IPv6 literal host (`[::1]` becomes `::1`). */
function unwrapIpv6Literal(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/** Throw when one resolved address is not a public destination. */
function assertPublicAddress(hostname: string, resolved: ResolvedAddress): void {
  const range = classifyBlockedRange(resolved.address)
  if (range !== undefined) {
    throw new WebError(
      `"${hostname}" resolved to ${resolved.address} in the ${range} range; fetching non-public destinations is blocked`,
      'WEB_PRIVATE_NETWORK_BLOCKED',
    )
  }
}
