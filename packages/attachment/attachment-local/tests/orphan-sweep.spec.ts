import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@buckeyestudio/cordis'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LocalAttachmentStore from '../src/index.ts'
import { sweepStagingResidue } from '../src/sweep.ts'

/** Path whose unlink fails so the per-entry error path is exercised without mocks elsewhere. */
const rmControl = vi.hoisted(() => ({ failPath: undefined as string | undefined }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (rmControl.failPath !== undefined && String(args[0]) === rmControl.failPath) {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      }
      return actual.rm(...args)
    },
  }
})

const homes: string[] = []

const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
  'base64',
))

async function freshHome(): Promise<{ home: string; storageRoot: string }> {
  const home = await mkdtemp(join(tmpdir(), 'toh-attachment-sweep-'))
  homes.push(home)
  return { home, storageRoot: join(home, 'attachments', 'v1') }
}

/** Backdate one path one hour so a startup sweep treats it as orphaned. */
async function backdate(path: string): Promise<void> {
  const stale = new Date(Date.now() - 3_600_000)
  await utimes(path, stale, stale)
}

/**
 * Run the store's post-construction lifecycle hook directly. The invariant
 * test host pre-registers its own `attachments` double on every root for this
 * package, so the real store cannot mount through `ctx.plugin` here; direct
 * construction plus an explicit init reproduces the same open-time sequence.
 */
function invokeInit(store: LocalAttachmentStore): Promise<void> {
  type InitHook = { [Service.init](): Promise<void> }
  return (store as unknown as InitHook)[Service.init]()
}

beforeEach(() => {
  rmControl.failPath = undefined
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('attachment staging-residue sweep helper', () => {
  it('removes stale staging files and request-image temporaries, keeping everything else', async () => {
    const { storageRoot } = await freshHome()
    const tmp = join(storageRoot, 'tmp')
    const bucket = join(storageRoot, 'request-images', 'ab')
    const objects = join(storageRoot, 'objects', 'cd')
    await mkdir(tmp, { recursive: true })
    await mkdir(join(storageRoot, 'request-images', 'ef'), { recursive: true })
    await mkdir(bucket, { recursive: true })
    await mkdir(objects, { recursive: true })

    // Staging entries carry no distinguishing suffix, so only ones older than
    // this process's start are collected; a fresh one may be a live write.
    const staleStage = join(tmp, 'stale-uuid')
    const freshStage = join(tmp, 'fresh-uuid')
    await writeFile(staleStage, 'partial')
    await writeFile(freshStage, 'partial')
    await backdate(staleStage)

    // A *.tmp name beside a cache object is provable garbage at any age.
    const staleTemp = join(bucket, 'ab12.uuid-1.tmp')
    const freshTemp = join(bucket, 'ab12.uuid-2.tmp')
    await writeFile(staleTemp, 'partial')
    await writeFile(freshTemp, 'partial')

    // A cached variant never carries .tmp and must survive even when stale.
    const cachedVariant = join(bucket, 'ab12')
    await writeFile(cachedVariant, 'variant')
    await backdate(cachedVariant)
    const stray = join(bucket, 'readme.md')
    await writeFile(stray, 'not a temp')

    const liveObject = join(objects, 'cd'.padEnd(64, '0'))
    await writeFile(liveObject, 'object-bytes')

    // The cutoff sits between the two staging files' mtimes.
    const swept = await sweepStagingResidue(storageRoot, Date.now() - 1_800_000)

    expect(swept).toBe(3)
    expect(existsSync(staleStage)).toBe(false)
    expect(existsSync(staleTemp)).toBe(false)
    expect(existsSync(freshTemp)).toBe(false)
    expect(existsSync(freshStage)).toBe(true)
    expect(existsSync(cachedVariant)).toBe(true)
    expect(existsSync(stray)).toBe(true)
    expect(existsSync(liveObject)).toBe(true)
  })

  it('skips an entry it cannot remove and still sweeps the rest', async () => {
    const { storageRoot } = await freshHome()
    const tmp = join(storageRoot, 'tmp')
    const bucket = join(storageRoot, 'request-images', 'ab')
    await mkdir(tmp, { recursive: true })
    await mkdir(bucket, { recursive: true })
    const locked = join(tmp, 'locked-uuid')
    const removable = join(bucket, 'ab12.uuid-3.tmp')
    await writeFile(locked, 'partial')
    await writeFile(removable, 'partial')
    await backdate(locked)
    rmControl.failPath = locked

    const swept = await sweepStagingResidue(storageRoot, Date.now())

    expect(swept).toBe(1)
    expect(existsSync(locked)).toBe(true)
    expect(existsSync(removable)).toBe(false)
  })

  it('rejects when a swept location exists but cannot be enumerated', async () => {
    const { storageRoot } = await freshHome()
    await mkdir(join(storageRoot), { recursive: true })
    // A file where the staging directory belongs is an unexpected layout:
    // enumeration fails (ENOTDIR), which the helper must surface.
    await writeFile(join(storageRoot, 'tmp'), 'not a directory')

    await expect(sweepStagingResidue(storageRoot, Date.now())).rejects.toThrow()
  })

  it('accepts an absent storage root', async () => {
    const { storageRoot } = await freshHome()
    await expect(sweepStagingResidue(join(storageRoot, 'missing'), Date.now())).resolves.toBe(0)
  })
})

describe('local attachment store open-time sweep', () => {
  it('sweeps crash-orphaned residue when the store mounts and stays usable', async () => {
    const { home, storageRoot } = await freshHome()
    const tmp = join(storageRoot, 'tmp')
    const bucket = join(storageRoot, 'request-images', 'cd')
    await mkdir(tmp, { recursive: true })
    await mkdir(bucket, { recursive: true })
    // Planted before open: the stale entry predates the process-start cutoff
    // and is collected; the fresh and future-dated ones stand in for a
    // concurrent writer's in-flight temp created after this process started
    // and survive — a mount-time cutoff would collect the fresh one.
    const staleStage = join(tmp, 'orphaned-uuid')
    const liveStage = join(tmp, 'in-flight-uuid')
    const freshStage = join(tmp, 'fresh-uuid')
    await writeFile(staleStage, 'partial')
    await writeFile(liveStage, 'partial')
    await writeFile(freshStage, 'partial')
    await backdate(staleStage)
    const future = new Date(Date.now() + 3_600_000)
    await utimes(liveStage, future, future)
    const orphanTemp = join(bucket, 'ef01.uuid-4.tmp')
    await writeFile(orphanTemp, 'partial')

    const ctx = new Context()
    const store = new LocalAttachmentStore(ctx, { tohHome: home })
    await invokeInit(store)

    expect(existsSync(staleStage)).toBe(false)
    expect(existsSync(liveStage)).toBe(true)
    expect(existsSync(freshStage)).toBe(true)
    expect(existsSync(orphanTemp)).toBe(false)
    expect(existsSync(tmp)).toBe(true)

    // The mounted store still publishes and serves objects after sweeping.
    const ref = await store.saveImage({ data: PNG, mediaType: 'image/png' })
    await expect(store.readImage(ref)).resolves.toEqual({ ref, data: PNG })
  })

  it('still opens when the sweep fails to enumerate', async () => {
    const { home, storageRoot } = await freshHome()
    await mkdir(storageRoot, { recursive: true })
    // A file where the staging directory belongs makes the sweep reject; the
    // mount must survive because the sweep is best-effort.
    await writeFile(join(storageRoot, 'tmp'), 'not a directory')

    const ctx = new Context()
    const store = new LocalAttachmentStore(ctx, { tohHome: home })
    await invokeInit(store)

    expect(ctx.attachments).toBeDefined()
  })
})
