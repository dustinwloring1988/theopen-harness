import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@buckeyestudio/cordis'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SessionId } from '@buckeyestudio/toh-session'
import type { Session } from '@buckeyestudio/toh-session'
import JsonlSessionPersistence from '../src/index.ts'
import { logPath, projectDir, sessionDir } from '../src/format.ts'
import { appendLog, oneTurnLog } from '../../session-persistence/tests/contract.ts'

/** Sentinel root whose enumeration fails so the sweep's error path is exercised. */
const sweepFailure = vi.hoisted(() => ({ root: undefined as string | undefined }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: (async (...args: Parameters<typeof actual.readdir>) => {
      if (sweepFailure.root !== undefined && String(args[0]) === sweepFailure.root) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      }
      return actual.readdir(...args)
    }) as typeof actual.readdir,
  }
})

const dirs: string[] = []

async function freshRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'toh-jsonl-sweep-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  sweepFailure.root = undefined
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('JsonlSessionPersistence: orphaned staging-temp sweep', () => {
  let ctx: Context
  let id: ReturnType<typeof SessionId>

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(SessionStore)
    id = SessionId('sweep-live')
  })

  /** Write one real closed-turn log through a first backend instance, then unmount. */
  async function seedLiveLog(root: string): Promise<void> {
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const session: Session = ctx.sessions.create(id, { meta: { cwd: '/work' } })
    appendLog(session, oneTurnLog())
    await ctx.fiber.dispose()
    ctx = new Context()
    await ctx.plugin(SessionStore)
  }

  it('removes crash-orphaned temporaries at open and preserves logs and non-matching files', async () => {
    const root = await freshRoot()
    await seedLiveLog(root)
    const dir = sessionDir(root, '/work', id)
    const project = projectDir(root, '/work')

    // Both residues are indistinguishable by mtime age; the *.tmp suffix is
    // the garbage proof because publication always renames away from it.
    const oldTmp = join(dir, 'session.jsonl.deadbeef.tmp')
    const newTmp = join(dir, 'session.jsonl.cafe01.tmp')
    await writeFile(oldTmp, '{"type":"turn/star')
    await writeFile(newTmp, '{"type":"user/messa')
    const stray = join(dir, 'notes.txt')
    await writeFile(stray, 'not a temp')
    // Temps only ever exist inside session directories; a stale *.tmp beside
    // (not inside) a session directory is outside the sweep's tight scope.
    const misplacedTmp = join(project, 'session.jsonl.stray.tmp')
    await writeFile(misplacedTmp, '{"type":"turn/star')

    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })

    expect(existsSync(oldTmp)).toBe(false)
    expect(existsSync(newTmp)).toBe(false)
    expect(existsSync(stray)).toBe(true)
    expect(existsSync(misplacedTmp)).toBe(true)

    // The published log survives the sweep untouched and still lists.
    expect(existsSync(logPath(root, '/work', id, 'none'))).toBe(true)
    expect((await ctx.sessionPersistence.list()).map(header => header.id)).toContain(id)
  })

  it('loads the surviving log byte-identically after sweeping', async () => {
    const root = await freshRoot()
    await seedLiveLog(root)
    const finalPath = logPath(root, '/work', id, 'none')
    const before = await readFile(finalPath, 'utf8')
    await writeFile(join(sessionDir(root, '/work', id), 'session.jsonl.ab12cd.tmp'), 'partial')

    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })

    expect(await readFile(finalPath, 'utf8')).toBe(before)
    const inspection = await ctx.sessionPersistence.inspect(id)
    expect(inspection.events.map(event => event.type)).toEqual(oneTurnLog().map(event => event.type))
  })

  it('still opens when the sweep cannot enumerate the root', async () => {
    const root = await freshRoot()
    sweepFailure.root = root
    await mkdir(join(root, 'project-x', 'sess'), { recursive: true })

    const fiber = await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })

    expect(ctx.sessionPersistence).toBeDefined()
    await fiber.dispose()
  })

  it('accepts an absent root without sweeping', async () => {
    const root = await freshRoot()
    const fiber = await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'missing'), compression: 'none' })
    expect(ctx.sessionPersistence).toBeDefined()
    await fiber.dispose()
  })
})
