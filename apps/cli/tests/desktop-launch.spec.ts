/**
 * Launch resolution for `toh desktop`, driven against the real workspace
 * install: the Electron devDependency of `apps/desktop` resolves to a usable
 * binary path, and resolution or build-shape failures fail loud instead of
 * guessing.
 * @module
 */

import type { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { resolveDesktopLaunch } from '../src/desktop.ts'

/** The launcher's injectable require-factory parameter. */
type RequireFactory = typeof createRequire

/**
 * A require factory whose `resolve` answers per script and whose calls load
 * the named entry.
 * @param resolve - stands in for CJS resolution of `'electron'`.
 * @param load - stands in for loading the resolved entry.
 */
function factoryOf(
  resolve: () => string,
  load: (entry: string) => unknown,
): RequireFactory {
  const nodeRequire = Object.assign(
    (entry: string) => load(entry),
    { resolve: (_request: string) => resolve(), paths: { id: 'electron', filename: '', resolved: undefined } },
  ) as unknown as NodeJS.Require
  return () => nodeRequire
}

describe('resolveDesktopLaunch', () => {
  it('resolves the Electron runtime through apps/desktop and launches that app directory', () => {
    const { binary, args } = resolveDesktopLaunch(new URL('../../desktop/', import.meta.url))
    expect(binary.length).toBeGreaterThan(0)
    expect(binary).not.toMatch(/node\.exe$/)
    expect(args).toHaveLength(1)
    expect(args[0].replace(/\\/g, '/')).toMatch(/apps\/desktop\/$/)
  })

  it('propagates a missing electron runtime loud', () => {
    // A stub factory stands in for the runner's resolver so the failure is
    // deterministic regardless of what the workspace happens to have hoisted.
    const missing = factoryOf(() => { throw new Error("Cannot find package 'electron'") }, () => undefined)
    expect(() => resolveDesktopLaunch(new URL('../../desktop/', import.meta.url), missing))
      .toThrow(/Cannot find package 'electron'/u)
  })

  it('rejects an electron entry that does not expose a binary path', () => {
    const shapeless = factoryOf(() => '/electron/index.js', () => ({ version: '43.4.1' }))
    expect(() => resolveDesktopLaunch(new URL('../../desktop/', import.meta.url), shapeless))
      .toThrow(/did not expose a binary path/u)
  })
})
