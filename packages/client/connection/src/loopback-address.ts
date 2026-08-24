/**
 * Node-side loopback classification of a socket peer address, the server-side
 * half of the local-operator pin: the Host header is client-controlled and
 * forgeable by any non-browser caller over plain HTTP, while the socket peer
 * address is read from the accepted connection and cannot be chosen by the
 * request. Browser-safe pure string logic; no Node imports.
 */

import { isLoopbackIpv4 } from './loopback-hostname.ts'

/**
 * Whether the server-side socket peer address is this machine's loopback.
 * Node reports IPv6 loopback as `::1` and IPv4 peers on dual-stack sockets
 * as `::ffff:`-mapped dotted quads.
 * @param remoteAddress - `req.socket.remoteAddress` of the accepted connection.
 * @returns true for `::1` or `127.0.0.0/8`, plain or `::ffff:`-mapped; false otherwise, failing closed when no peer is reported.
 */
export function isLoopbackPeerAddress(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) return false
  const address = remoteAddress.toLowerCase()
  if (address === '::1') return true
  const ipv4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return isLoopbackIpv4(ipv4)
}
