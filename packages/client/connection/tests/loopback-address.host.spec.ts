/** Loopback classification of server-side socket peer addresses (the local-operator pin). */

import { describe, expect, it } from 'vitest'
import { isLoopbackPeerAddress } from '../src/loopback-address.ts'

describe('isLoopbackPeerAddress', () => {
  it('accepts every spelling Node reports for a same-machine peer', () => {
    // IPv4 127/8 direct, IPv6 loopback, and the ::ffff:-mapped dual-stack form.
    for (const remoteAddress of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1']) {
      expect(isLoopbackPeerAddress(remoteAddress)).toBe(true)
    }
  })

  it('refuses LAN peers in direct and mapped spellings, and a missing address', () => {
    for (const remoteAddress of ['192.168.1.5', '10.0.0.9', '::ffff:192.168.1.5', 'fe80::1', '::2', undefined]) {
      expect(isLoopbackPeerAddress(remoteAddress)).toBe(false)
    }
  })

  it('refuses malformed dotted quads instead of guessing', () => {
    for (const remoteAddress of ['127.0.0.256', '127.0.0', '127.0.0.1.5', '::ffff:127.0.0.999']) {
      expect(isLoopbackPeerAddress(remoteAddress)).toBe(false)
    }
  })
})
