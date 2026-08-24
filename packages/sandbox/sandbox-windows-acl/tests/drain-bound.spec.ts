/**
 * Bounded piped-output capture: drainPipe retains only the most recent
 * maxBytes per drained stream (the subprocess seam's OutputCollector
 * tail-keep shape), so a chatty or runaway confined child cannot grow host
 * memory without bound. The trim cases are pure stubs — no real Win32 calls —
 * so they run on every platform; the end-to-end case drives a REAL confined
 * child through the restricted token on win32 hosts.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import koffi from 'koffi'

import type { NativePtr, Win32Bindings } from '../src/ffi.ts'
import { AclSandbox, tempWriteSid, workspaceWriteSid } from '../src/index.ts'
import { DEFAULT_MAX_OUTPUT_BYTES, drainPipe } from '../src/spawn.ts'
import * as abi from '../src/win32-abi.ts'

/**
 * The stub one bounded drain needs: each script entry is reported available
 * by PeekNamedPipe and then "read" whole by ReadFile; after the script is
 * exhausted the peek reports ERROR_BROKEN_PIPE (clean EOF).
 */
function scriptedDrainApi(script: string[]): Win32Bindings {
  let poll = 0
  return {
    peekNamedPipe: vi.fn((_pipe: unknown, _buffer: unknown, _size: unknown, _read: unknown, totalAvail: NativePtr) => {
      poll++
      const part = script[poll - 1]
      if (part === undefined) return 0
      koffi.encode(totalAvail, 'uint32', Buffer.byteLength(part, 'utf8'))
      return 1
    }),
    readFile: vi.fn((_pipe: unknown, chunk: Buffer, _count: unknown, read: NativePtr) => {
      const part = script[poll - 1] as string
      chunk.write(part, 0, 'utf8')
      koffi.encode(read, 'uint32', Buffer.byteLength(part, 'utf8'))
      return 1
    }),
    getLastError: vi.fn(() => abi.ERROR_BROKEN_PIPE),
    closeHandle: vi.fn(() => 1),
  } as unknown as Win32Bindings
}

describe('drainPipe byte budget', () => {
  it('returns sub-cap output intact across polls', async () => {
    const api = scriptedDrainApi(['hello ', 'world'])
    await expect(drainPipe(api, 30n as NativePtr, 1024)).resolves.toEqual(Buffer.from('hello world'))
  })

  it('keeps exactly the last maxBytes once the stream exceeds the cap', async () => {
    // 10a + 95b + 30c over cap 100: dropping the whole head chunk still leaves
    // 125 bytes, so the next chunk's head is trimmed too — both drop paths run,
    // and the retained window is byte-exact at the cap.
    const api = scriptedDrainApi(['a'.repeat(10), 'b'.repeat(95), 'c'.repeat(30)])
    const buffer = await drainPipe(api, 30n as NativePtr, 100)
    expect(buffer.length).toBe(100)
    expect(buffer.equals(Buffer.from(`${'b'.repeat(70)}${'c'.repeat(30)}`))).toBe(true)
  })

  it('trims a single over-cap chunk to its tail', async () => {
    const api = scriptedDrainApi(['x'.repeat(300)])
    const buffer = await drainPipe(api, 30n as NativePtr, 100)
    expect(buffer.length).toBe(100)
    expect(buffer.equals(Buffer.from('x'.repeat(100)))).toBe(true)
  })
})

const isWin32 = process.platform === 'win32'

describe.skipIf(!isWin32)('bounded capture from a real confined child', () => {
  const scratchDirs: string[] = []
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'toh-acl-drain-'))
    scratchDirs.push(dir)
    return dir
  }

  async function initializedSandbox(): Promise<AclSandbox> {
    const workspaceDir = scratch()
    const tempDir = scratch()
    const sandbox = new AclSandbox({
      writableDirs: [workspaceDir],
      tempDir,
      writeSid: workspaceWriteSid(workspaceDir),
      tempWriteSid: tempWriteSid(tempDir),
      mode: 'workspace-write',
    })
    await sandbox.init()
    return sandbox
  }

  it('caps an over-producing child at maxOutputBytes and keeps each stream tail', async () => {
    const sandbox = await initializedSandbox()
    try {
      const cap = 4_096
      const child = sandbox.spawn({
        command: process.execPath,
        args: ['-e', 'process.stdout.write("o".repeat(96000));process.stderr.write("e".repeat(48000))'],
        cwd: process.cwd(),
        stdio: 'pipe',
        maxOutputBytes: cap,
      })
      const { stdout, stderr, exitCode } = await child.wait()
      expect(exitCode).toBe(0)
      expect(stdout.length).toBe(cap)
      expect(stdout.equals(Buffer.from('o'.repeat(cap)))).toBe(true)
      expect(stderr.equals(Buffer.from('e'.repeat(cap)))).toBe(true)
    } finally {
      sandbox.dispose()
    }
  }, 30_000)

  it('applies the default budget when maxOutputBytes is omitted', async () => {
    const sandbox = await initializedSandbox()
    try {
      const child = sandbox.spawn({
        command: process.execPath,
        args: ['-e', 'process.stdout.write("o".repeat(70000))'],
        cwd: process.cwd(),
        stdio: 'pipe',
      })
      const { stdout, stderr, exitCode } = await child.wait()
      expect(exitCode).toBe(0)
      expect(stdout.length).toBe(DEFAULT_MAX_OUTPUT_BYTES)
      expect(stdout.equals(Buffer.from('o'.repeat(DEFAULT_MAX_OUTPUT_BYTES)))).toBe(true)
      expect(stderr.length).toBe(0)
    } finally {
      sandbox.dispose()
    }
  }, 30_000)

  it('rejects a fractional maxOutputBytes before spawning', async () => {
    const sandbox = await initializedSandbox()
    try {
      expect(() => sandbox.spawn({
        command: process.execPath,
        args: ['-e', 'process.stdout.write("o")'],
        cwd: process.cwd(),
        stdio: 'pipe',
        maxOutputBytes: 4096.5,
      })).toThrow(/maxOutputBytes must be a positive integer/u)
    } finally {
      sandbox.dispose()
    }
  }, 30_000)
})
