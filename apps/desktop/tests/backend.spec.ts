/**
 * Behavior tests for the spawned backend handle, driven against an HTTP fixture
 * process instead of the real CLI: readiness resolves when the fixture answers
 * on its picked port, rejects on early exit, and stopping terminates the child.
 * @module
 */

import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { findFreeLoopbackPort, spawnWebBackend, stopWebBackend } from '../src/backend.ts'

/** Absolute path of the fake backend fixture. */
const FAKE_BIN = fileURLToPath(new URL('./fixtures/fake-toh-web.cjs', import.meta.url))

describe('findFreeLoopbackPort', () => {
  it('returns a port a server can still bind on 127.0.0.1', async () => {
    const port = await findFreeLoopbackPort()
    const server = createServer()
    await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', resolve) })
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    expect(port).toBeGreaterThan(0)
  })
})

describe('spawnWebBackend', () => {
  it('resolves readiness with the URL of the port it passed to the child', async () => {
    const backend = await spawnWebBackend(FAKE_BIN, { readyTimeoutMs: 10_000 })
    try {
      const url = await backend.ready
      const portIndex = backend.child.spawnargs.indexOf('--port')
      expect(url).toBe(`http://127.0.0.1:${String(backend.child.spawnargs[portIndex + 1])}`)
      await expect(fetch(url)).resolves.toHaveProperty('status', 200)
    } finally {
      stopWebBackend(backend)
    }
  })

  it('rejects when the child exits without serving HTTP', async () => {
    const backend = await spawnWebBackend(FAKE_BIN, {
      env: { FAKE_TOH_WEB_EXIT_WITHOUT_SERVING: '1' },
      readyTimeoutMs: 10_000,
    })
    await expect(backend.ready).rejects.toThrow(/exited before answering/u)
  })

  it('stop terminates the child process', async () => {
    const backend = await spawnWebBackend(FAKE_BIN, { readyTimeoutMs: 10_000 })
    await backend.ready
    stopWebBackend(backend)
    await once(backend.child, 'exit')
    expect(backend.child.exitCode ?? backend.child.signalCode).not.toBeNull()
  })
})
