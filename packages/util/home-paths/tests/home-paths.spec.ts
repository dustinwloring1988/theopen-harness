import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TOH_HOME_DISPLAY,
  TOH_HOME_DIR_NAME,
  canonicalizeWatchPath,
  defaultDshHome,
  tohHomeDisplay,
  tohHomePath,
  expandHomePath,
  resolveDshHome,
} from '@buckeyestudio/toh-home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('toh path helpers', () => {
  it('owns the shared default TOH home directory name', () => {
    expect(TOH_HOME_DIR_NAME).toBe('.toh')
    expect(DEFAULT_TOH_HOME_DISPLAY).toBe('~/.toh')
    expect(defaultDshHome()).toBe(join(homedir(), '.toh'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.toh')).toBe(join(homedir(), '.toh'))
    expect(expandHomePath('~\\.toh')).toBe(join(homedir(), '.toh'))
    expect(expandHomePath('/tmp/.toh')).toBe('/tmp/.toh')
    expect(expandHomePath('~other/.toh')).toBe('~other/.toh')
  })

  it('resolves explicit path before TOH_HOME and the default', () => {
    const envHome = join(homedir(), 'env-toh')

    expect(resolveDshHome('/tmp/explicit-toh', { TOH_HOME: '~/env-toh' })).toBe(resolve('/tmp/explicit-toh'))
    expect(resolveDshHome(undefined, { TOH_HOME: '~/env-toh' })).toBe(envHome)
    expect(resolveDshHome(undefined, {})).toBe(defaultDshHome())
  })

  it('treats an empty or whitespace-only TOH_HOME as unset', () => {
    expect(resolveDshHome(undefined, { TOH_HOME: '' })).toBe(defaultDshHome())
    expect(resolveDshHome(undefined, { TOH_HOME: '   ' })).toBe(defaultDshHome())
  })

  it('joins child segments onto the resolved TOH_HOME', () => {
    vi.stubEnv('TOH_HOME', '~/env-toh')
    expect(tohHomePath()).toBe(join(homedir(), 'env-toh'))
    expect(tohHomePath('storages', 'cache')).toBe(join(homedir(), 'env-toh', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(tohHomeDisplay(resolve(defaultDshHome()))).toBe('~/.toh')
    expect(tohHomeDisplay('/some/other/root')).toBe('$TOH_HOME')
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'toh-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
