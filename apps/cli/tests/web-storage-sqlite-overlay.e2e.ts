/**
 * Keyless real-composition evidence for the opt-in SQLite storage overlay:
 * the shipped Web composition booted with examples/web-storage-sqlite applied,
 * proving the inserted backend row registers before the domain facility routes
 * the workspace domain onto the database file.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Context } from '@buckeyestudio/cordis'
import { boot, healProfilesModuleFallback, loadOverlayPatches } from '@buckeyestudio/toh-app-boot'
import { provideCmdline } from '@buckeyestudio/toh-cmdline'
import type { PatchOptions } from '@buckeyestudio/cordis-plugin-include'
// Type-only: resolves `ctx.storage` and `ctx.workspaceRegistry` declarations.
import type {} from '@buckeyestudio/toh-storage'
import type {} from '@buckeyestudio/toh-workspace'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const BASE_PATCH = join(REPO_ROOT, 'packages/bundle/base/cordis.patch.yml')
const WEB_PATCH = join(REPO_ROOT, 'packages/bundle/web-app/cordis.patch.yml')
const OVERLAY = join(REPO_ROOT, 'examples/web-storage-sqlite/cordis.yml')
const INSTALL_ANCHOR = join(REPO_ROOT, 'apps/cli/package.json')

let ctx: Context
let home: string
let previousHome: string | undefined

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'toh-web-storage-sqlite-'))
  // The overlay's own `!!js tohHomePath(...)` config resolves against this, so
  // both the JSON units and the routed SQLite medium land inside the sandbox.
  previousHome = process.env.TOH_HOME
  process.env.TOH_HOME = home
  const settingsFile = join(home, 'settings.yaml')
  await writeFile(settingsFile, '{}\n')
  const overrides: PatchOptions[] = [
    { id: 'settings', config: { path: settingsFile, watch: false } },
    // Same pinning rationale as web-agent-presets: the shipped roots anchor to
    // the developer's real $TOH_HOME, which this sandbox replaces.
    { id: 'storage-json', config: { root: join(home, 'storages') } },
    { id: 'webserver', disabled: true },
    { id: 'web-runtime', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'modules', disabled: true },
    { id: 'connection', disabled: true },
    { id: 'client-hmr', disabled: true },
    // The `-auto` chooser resolves its interaction from a running host and so
    // waits for the webserver disabled above; the browse variant supplies
    // `directoryPicker` without one, keeping the api-proxy's wait satisfied.
    { id: 'directory-picker', disabled: true },
    { insert: [
      { id: 'directory-picker-browse', name: '@buckeyestudio/toh-host-directory-picker-browse' },
      { id: 'ui-directory-picker-browse', name: '@buckeyestudio/toh-client-ui-directory-picker-browse' },
    ] },
  ]
  // Bare plugin names resolve through the flat installation fallback, exactly
  // as a built `toh web --patch` resolves them.
  healProfilesModuleFallback(INSTALL_ANCHOR, home)
  const profileDir = join(home, 'profiles', 'spec')
  await mkdir(profileDir, { recursive: true })
  const rootConfig = join(profileDir, 'cordis.yml')
  await writeFile(rootConfig, '[]\n')
  ctx = await boot('toh-test', rootConfig, [
    ...loadOverlayPatches('toh-test', BASE_PATCH),
    ...loadOverlayPatches('toh-test', WEB_PATCH),
    ...loadOverlayPatches('toh-test', OVERLAY),
    ...overrides,
  ], (bootCtx) => {
    provideCmdline(bootCtx, { args: [], exit: () => {} })
  })
}, 120_000)

afterAll(async () => {
  if (previousHome === undefined) delete process.env.TOH_HOME
  else process.env.TOH_HOME = previousHome
  await ctx?.fiber.dispose()
  if (home !== undefined) await rm(home, { recursive: true, force: true })
})

describe('the opt-in SQLite storage overlay', () => {
  it('composes both backends side by side and routes the workspace domain to sqlite', async () => {
    expect(ctx.storage.backend.get('json')).toBeDefined()
    expect(ctx.storage.backend.get('sqlite')).toBeDefined()
    const dir = join(await mkdtemp(join(home, 'workspace-')), 'root')
    await mkdir(dir, { recursive: true })
    // The registry's domain open resolved its route through the hub: a
    // misrouted or unregistered backend name fails the boot instead, and a
    // create round-trip proves the routed medium accepts writes.
    const workspace = await ctx.workspaceRegistry.create(dir)
    await expect(ctx.workspaceRegistry.delete(workspace.id)).resolves.toBe(true)
  })

  it('lands workspace records as durable rows in the routed database file', async () => {
    const dbPath = join(home, 'storages', 'workspace.sqlite3')
    const dir = join(await mkdtemp(join(home, 'workspace-')), 'root')
    await mkdir(dir, { recursive: true })
    const workspace = await ctx.workspaceRegistry.create(dir)
    try {
      // A second connection observes the committed write through WAL: the KV
      // contract makes each resolved primitive durable on the medium.
      const reader = new DatabaseSync(dbPath)
      try {
        const globalRow = reader.prepare(
          "SELECT value FROM unit_globals WHERE unit = 'workspace'",
        ).get() as { value: string }
        expect(JSON.parse(globalRow.value)).toMatchObject({ initialized: true })
        const records = reader.prepare(
          'SELECT COUNT(*) AS n FROM "u_workspace_workspaces"',
        ).get() as { n: number }
        expect(records.n).toBe(1)
      } finally {
        reader.close()
      }
    } finally {
      await ctx.workspaceRegistry.delete(workspace.id)
    }
  })
})
