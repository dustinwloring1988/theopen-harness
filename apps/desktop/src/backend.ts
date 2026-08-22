/**
 * The spawned `toh web` backend process: pick a free loopback port, launch the
 * built CLI on it, resolve readiness by polling the HTTP server, and stop the
 * whole process tree on shutdown. Pure Node, so tests drive it without
 * Electron.
 *
 * Readiness is an HTTP probe rather than the stdout URL line: libuv-created
 * stdio pipes of a GUI-spawned child were observed to perturb the CLI's module
 * resolution, and the probe also decouples startup from the backend's
 * `printUrl` composition.
 * @module @buckeyestudio/toh-desktop/backend
 */

import { createServer } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import type { AddressInfo } from 'node:net'

/** How long the shell waits for the HTTP server before giving up. */
const BACKEND_READY_TIMEOUT_MS = 60_000

/** Pause between readiness probes. */
const BACKEND_POLL_INTERVAL_MS = 250

/** A live backend child together with the promise that settles at readiness. */
export interface WebBackend {
  /** The spawned CLI process; still owned by this module until {@link stopWebBackend}. */
  child: ChildProcess
  /** Resolves with the loopback base URL once the server answers HTTP; rejects on exit, spawn failure, or timeout. */
  ready: Promise<string>
}

/** Optional launch overrides. */
export interface SpawnWebBackendOptions {
  /** Extra environment entries layered over the parent environment; tests drive fixtures through it. */
  env?: NodeJS.ProcessEnv
  /**
   * Executable that runs the CLI; defaults to `node` from PATH. A checkout
   * built with pnpm already requires that toolchain.
   */
  execPath?: string
  /** Readiness deadline override; tests shrink the default minute. */
  readyTimeoutMs?: number
}

/**
 * Ask the OS for one free 127.0.0.1 port and release it immediately for the
 * CLI to bind. The window between release and bind is small, and losing it is
 * a loud boot failure rather than a silent misroute.
 * @returns the free port number.
 */
export async function findFreeLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  return port
}

/** Resolve once any HTTP response arrives from the backend; reject at the deadline. */
async function pollUntilAnswering(url: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    try {
      await fetch(url)
      return
    } catch {
      // Connection refused while the CLI is still booting is expected traffic.
    }
    if (Date.now() > deadline) throw new Error(`toh web did not answer ${url} within ${String(deadlineMs)}ms`)
    await new Promise((resolve) => { setTimeout(resolve, BACKEND_POLL_INTERVAL_MS) })
  }
}

/**
 * Spawn the built toh CLI's web profile on a freshly picked port and wait
 * until its HTTP server answers. `--no-open` suppresses the default-browser
 * handoff; the desktop window replaces it.
 * @param cliBinPath - absolute path of the built CLI entry (`apps/cli/lib/bin.js`).
 * @param options - optional launch overrides.
 * @returns the child and its readiness promise.
 */
export async function spawnWebBackend(cliBinPath: string, options: SpawnWebBackendOptions = {}): Promise<WebBackend> {
  const port = await findFreeLoopbackPort()
  const url = `http://127.0.0.1:${String(port)}`
  const child = spawn(options.execPath ?? 'node', [
    cliBinPath,
    '--profile', 'web',
    '--port', String(port),
    '--no-open',
  ], {
    // Inherited streams instead of libuv-created pipes: piped handles of a
    // GUI-spawned child were observed to break the CLI's module resolution,
    // and inheritance keeps backend diagnostics on this process's console.
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  const deadlineMs = options.readyTimeoutMs ?? BACKEND_READY_TIMEOUT_MS
  let exitListener: ((code: number | null) => void) | undefined
  const ready = (async () => {
    const exited = new Promise<never>((_, reject) => {
      exitListener = (code) => { reject(new Error(`toh web exited before answering requests (code ${String(code)})`)) }
      child.once('exit', exitListener)
    })
    const failure = new Promise<never>((_, reject) => {
      child.once('error', (error) => { reject(error instanceof Error ? error : new Error(String(error))) })
    })
    try {
      await Promise.race([pollUntilAnswering(url, deadlineMs), exited, failure])
    } finally {
      if (exitListener !== undefined) child.off('exit', exitListener)
    }
    return url
  })()
  return { child, ready }
}

/**
 * Stop the backend, killing its whole process tree so tool subprocesses do not
 * outlive the desktop app.
 * @param backend - the handle returned by {@link spawnWebBackend}.
 */
export function stopWebBackend(backend: WebBackend): void {
  if (backend.child.exitCode !== null || backend.child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(backend.child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  backend.child.kill('SIGTERM')
}
