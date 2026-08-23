/**
 * The `toh desktop` launcher: resolve the Electron runtime installed beside
 * the desktop container app and exec it with that app's directory, forwarding
 * the child's exit code.
 *
 * Resolution rides the workspace dependency graph instead of checkout-relative
 * paths: the container app declares `electron` as its devDependency, so
 * requiring it from `apps/desktop` yields the platform binary path in every
 * install shape pnpm produces (source checkout and packaged app).
 * @module @buckeyestudio/toh/desktop-launch
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * Resolve one launch of the desktop container app.
 * @param appDirUrl - directory URL of `apps/desktop`, relative to this module
 * (`../../desktop/` from both the source tree and the built bin).
 * @param createModuleRequire - the CJS require factory; tests substitute a
 * stub to drive resolution failures deterministically past the runner's own
 * resolver.
 * @returns the Electron binary path and the argv to launch it with.
 */
export function resolveDesktopLaunch(
  appDirUrl: URL,
  createModuleRequire: typeof createRequire = createRequire,
): { binary: string; args: [string] } {
  const require = createModuleRequire(import.meta.url)
  const entry = require.resolve('electron', { paths: [fileURLToPath(appDirUrl)] })
  // Outside the Electron runtime, the package's entry exports the binary path;
  // a non-string means an unexpected Electron build shape, not a usable launch.
  const binary: unknown = require(entry)
  if (typeof binary !== 'string' || binary.length === 0) {
    throw new Error('toh desktop: the resolved electron package did not expose a binary path')
  }
  return { binary, args: [fileURLToPath(appDirUrl)] }
}

/**
 * Launch the desktop container app and wait for it to exit.
 * @returns the child's exit code; a spawn failure propagates as a rejection.
 */
export async function runDesktop(): Promise<number> {
  const { binary, args } = resolveDesktopLaunch(new URL('../../desktop/', import.meta.url))
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => { resolve(code ?? 0) })
  })
}
