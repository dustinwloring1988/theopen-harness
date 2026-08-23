/**
 * Keyless assembled-app snapshots for the opt-in SQLite storage overlay, driven
 * through the real runnable example's documented command (`toh web --patch
 * examples/web-storage-sqlite/cordis.yml`): the CLI bin's composed profile tree
 * pins the overlay's provenance-marked rows, and a boot of the built bin to
 * readiness pins the serving transcript plus the routed database file the boot
 * leaves behind.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@buckeyestudio/toh-loader-smoke'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const BIN_SCRIPT = join(REPO_ROOT, 'apps/cli/src/bin.ts')
const TSCONFIG_PATH = join(REPO_ROOT, 'tsconfig.json')
const OVERLAY = join(REPO_ROOT, 'examples/web-storage-sqlite/cordis.yml')
const builtBin = join(REPO_ROOT, 'apps/cli/lib/bin.js')
// The browser-open fixture owns the exit-on-ready hook the boot scenario needs
// to stop the long-lived Web server after the URL line prints.
const exitOnReadyHook = new URL('./fixtures/web-browser-open/register.mjs', import.meta.url).href
const tempRoots: string[] = []
const builtArtifactsExist = existsSync(builtBin)

if (process.env.TOH_EXAMPLE_MODE === 'lib' && !builtArtifactsExist) {
  throw new Error('web-storage-sqlite overlay boot snapshot requires built CLI artifacts in lib mode')
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('web-storage-sqlite overlay assembled snapshots', () => {
  it('composes the overlay into the shipped Web profile through the documented command', async () => {
    const result = await runLoaderSmoke({
      label: 'web-storage-sqlite overlay composition snapshot',
      tempDirPrefix: 'web-storage-sqlite-overlay-composition-',
      binScript: BIN_SCRIPT,
      tsconfigPath: TSCONFIG_PATH,
      binArgs: ['web', '--patch', OVERLAY, '--dump-config'],
      env: { NODE_NO_WARNINGS: '1' },
    })
    // The dump labels each row group with its absolute source paths; the token
    // keeps the golden identical across checkouts and path separators.
    const composed = result.stdout.replaceAll(OVERLAY, '{{overlay}}')
    // Pin only the groups whose provenance names the overlay: the rest of the
    // tree belongs to the shipped bundles' own coverage.
    const transcript = composed.split(/^# == /mu).slice(1)
      .filter(group => group.includes('{{overlay}}'))
      .map(group => `# == ${group}`.trimEnd())
      .join('\n')

    expect({
      stderr: result.stderr,
      transcript,
    }).toMatchInlineSnapshot(`
      {
        "stderr": "",
        "transcript": "# == @buckeyestudio/toh-web-app, patched by {{overlay}}
      - id: storage-domain
        name: '@buckeyestudio/toh-storage-domain'
        config:
          backend: json
          routes:
            workspace: sqlite
      # == {{overlay}}
      - id: storage-sqlite
        name: '@buckeyestudio/toh-storage-sqlite'
        config:
          path: !!js tohHomePath('storages/workspace.sqlite3')",
      }
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  describe.skipIf(!builtArtifactsExist)('assembled boot of the built bin', () => {
    it('boots the documented command to a serving Web app and materializes the routed database', async () => {
      const root = mkdtempSync(join(tmpdir(), 'web-storage-sqlite-overlay-boot-'))
      tempRoots.push(root)
      // A misrouted or unregistered backend name fails this boot instead, so a
      // settled URL line is itself routing acceptance; the file check pins the
      // README's $TOH_HOME/storages location without any session traffic.
      const result = await execa(process.execPath, [
        '--import', exitOnReadyHook,
        builtBin,
        'web',
        '--patch', OVERLAY,
        '--no-open',
        '--port', '0',
      ], {
        cwd: root,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: 'keyless-browser-open-no-call',
          NODE_NO_WARNINGS: '1',
          TOH_AGENTS_HOME: join(root, '.agents'),
          TOH_BROWSER_OPEN_TEST_EXIT_ON_READY: '1',
          TOH_HOME: join(root, '.toh'),
          TOH_TELEMETRY_DISABLED: '1',
        },
        input: '',
        timeout: 30_000,
        killSignal: 'SIGKILL',
        reject: false,
      })
      expect(existsSync(join(root, '.toh', 'storages', 'workspace.sqlite3'))).toBe(true)
      // Only the canonical loopback URL is pinned: the line may carry a
      // machine-dependent LAN suffix, and the port is ephemeral.
      const readyUrl = /toh web: (http:\/\/127\.0\.0\.1:\d+)/u.exec(result.stdout)?.[1]
        ?.replace(/:\d+$/u, ':{{port}}')

      expect({
        exitCode: result.exitCode,
        readyUrl,
        stderr: result.stderr,
      }).toMatchInlineSnapshot(`
        {
          "exitCode": 0,
          "readyUrl": "http://127.0.0.1:{{port}}",
          "stderr": "",
        }
      `)
    }, LOADER_SMOKE_TEST_TIMEOUT_MS)
  })
})
