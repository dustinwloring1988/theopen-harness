import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@buckeyestudio/cordis'
import Storage, { storageBackendServiceKey } from '@buckeyestudio/toh-storage'
import InvariantRegistry from '@buckeyestudio/toh-invariants'
import { runKvBackendContract } from '../../storage/tests/contract.ts'
import { Config, JsonStorageBackend, apply } from '../src/index.ts'
import * as InvariantCompanion from '../src/invariant.ts'

// Publications cannot be timed or failed from outside; this wrapper gates each
// `writeAtomic` call in invocation order and records every snapshot that lands.
const publications = vi.hoisted(() => ({
  written: [] as string[],
  plans: [] as Array<{ holdUntil?: Promise<void>; failWith?: Error }>,
}))

vi.mock('../src/atomic.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/atomic.ts')>()
  return {
    ...actual,
    writeAtomic: async (path: string, data: string) => {
      const plan = publications.plans.shift()
      await plan?.holdUntil
      if (plan?.failWith) throw plan.failWith
      publications.written.push(data)
      return actual.writeAtomic(path, data)
    },
  }
})

const roots: string[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'toh-storage-json-'))
  roots.push(root)
  return root
}

function stagePublications(plans: typeof publications.plans): string[] {
  publications.written.length = 0
  publications.plans.push(...plans)
  return publications.written
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((resolveOnce) => {
    resolve = resolveOnce
  })
  return { promise, resolve }
}

afterEach(() => {
  publications.written.length = 0
  publications.plans.length = 0
})

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

runKvBackendContract('json', async () => {
  const root = await freshRoot()
  return {
    backend: new JsonStorageBackend(root),
    reopen: async () => new JsonStorageBackend(root),
  }
})

describe('json backend specifics', () => {
  const descriptor = { name: 'shape', version: 1, tables: ['t'], hasGlobal: true }

  it('publishes a human-readable pretty-printed file', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('t', 'k', { hello: 'world' })
    const text = await readFile(join(root, 'shape.json'), 'utf8')
    expect(text).toBe(`${JSON.stringify(
      { unit: { name: 'shape', version: 1 }, global: null, tables: { t: { k: { hello: 'world' } } } },
      null,
      2,
    )}\n`)
    await backend.close()
  })

  it('defers materialization until the first write', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    await backend.kv.open(descriptor)
    await expect(readFile(join(root, 'shape.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await backend.close()
  })

  it('rejects a malformed medium', async () => {
    const root = await freshRoot()
    await writeFile(join(root, 'shape.json'), 'not json at all', 'utf8')
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it('rejects a foreign unit header', async () => {
    const root = await freshRoot()
    await writeFile(
      join(root, 'shape.json'),
      JSON.stringify({ unit: { name: 'other', version: 1 }, global: null, tables: {} }),
      'utf8',
    )
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it('rejects double-open of one unit as a plain caller error', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    await backend.kv.open(descriptor)
    await expect(backend.kv.open(descriptor)).rejects.toThrow(/already open/)
    await backend.close()
  })

  it('rolls back memory when a publish fails', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('t', 'k', { v: 'committed' })
    await unit.setGlobal({ g: 'committed' })
    const path = join(root, 'shape.json')
    const backup = join(root, 'shape.committed.json')
    // A directory at the publish target rejects atomic replacement on every host.
    await rename(path, backup)
    await mkdir(path)
    await expect(unit.putRecord('t', 'k', { v: 'rejected' })).rejects.toThrow()
    await expect(unit.putRecord('t', 'k2', { v: 'also rejected' })).rejects.toThrow()
    await expect(unit.deleteRecord('t', 'k')).rejects.toThrow()
    await expect(unit.setGlobal({ g: 'rejected' })).rejects.toThrow()
    await rm(path, { recursive: true })
    await rename(backup, path)
    const snapshot = await unit.loadAll()
    expect(snapshot.tables['t']).toEqual({ k: { v: 'committed' } })
    expect(snapshot.global).toEqual({ g: 'committed' })
    // The next successful publish must not carry rejected writes to disk.
    await unit.putRecord('t', 'k3', { v: 'later' })
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain('rejected')
    await backend.close()
  })

  it('rejects undeclared table and global access as caller errors', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open({ name: 'shape', version: 1, tables: ['t'], hasGlobal: false })
    await expect(unit.putRecord('undeclared', 'k', {})).rejects.toThrow(/does not declare table/)
    await expect(unit.setGlobal({})).rejects.toThrow(/does not declare a global slot/)
    await backend.close()
  })

  it('rejects invalid unit and table names', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open({ ...descriptor, name: 'Bad-Name' })).rejects.toMatchObject({
      name: 'StorageError',
      code: 'malformed-medium',
    })
    await expect(backend.kv.open({ ...descriptor, tables: ['ok', 'not ok'] })).rejects.toMatchObject({
      name: 'StorageError',
      code: 'malformed-medium',
    })
    await backend.close()
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'closed' })
  })

  it('opens a file missing a declared table as that table empty', async () => {
    const root = await freshRoot()
    await writeFile(
      join(root, 'contract_unit.json'),
      JSON.stringify({ unit: { name: 'contract_unit', version: 3 }, global: null, tables: { alpha: { k: 1 } } }),
      'utf8',
    )
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open({ name: 'contract_unit', version: 3, tables: ['alpha', 'beta'], hasGlobal: true })
    const snapshot = await unit.loadAll()
    expect(snapshot.tables['alpha']).toEqual({ k: 1 })
    expect(snapshot.tables['beta']).toEqual({})
    await backend.close()
  })

  it('propagates non-ENOENT read failures', async () => {
    const root = await freshRoot()
    const { mkdir } = await import('node:fs/promises')
    // A directory where the unit file should be: readFile fails with EISDIR.
    await mkdir(join(root, 'shape.json'))
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'EISDIR' })
    await backend.close()
  })

  it('rejects malformed table shapes and foreign versions distinctly', async () => {
    const root = await freshRoot()
    await writeFile(
      join(root, 'shape.json'),
      JSON.stringify({ unit: { name: 'shape', version: 1 }, global: null, tables: { t: ['not', 'an', 'object'] } }),
      'utf8',
    )
    const backend = new JsonStorageBackend(root)
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })

    await writeFile(
      join(root, 'shape.json'),
      JSON.stringify({ unit: { name: 'shape', version: 9 }, global: null, tables: {} }),
      'utf8',
    )
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'version-mismatch' })

    await writeFile(join(root, 'shape.json'), JSON.stringify({ unit: { name: 'shape', version: 1 }, global: null }), 'utf8')
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })

    await writeFile(join(root, 'shape.json'), JSON.stringify('just a string'), 'utf8')
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it('registers on the hub via apply and closes on dispose', async () => {
    const root = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(Storage)
    const fiber = await ctx.plugin({ apply, Config, inject: ['storage'] }, { root })
    const backend = ctx.storage.backend.get('json')
    expect(ctx.get(storageBackendServiceKey('json'))).toBe(backend)
    const unit = await backend.kv!.open(descriptor)
    await unit.putRecord('t', 'k', { v: 1 })
    await fiber.dispose()
    expect(() => ctx.storage.backend.get('json')).toThrow()
    expect(ctx.get(storageBackendServiceKey('json'))).toBeUndefined()
    await expect(unit.putRecord('t', 'x', {})).rejects.toMatchObject({ code: 'closed' })
  })

  it('registers the invariant companion and disposes cleanly', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(InvariantCompanion)
    // Disposal releases the reservation: a fresh mount succeeds.
    await fiber.dispose()
    await ctx.plugin(InvariantCompanion)
  })

  it('close drains in-flight writes and blocks in-flight opens', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    const bigWrite = unit.putRecord('t', 'big', { blob: 'x'.repeat(4 * 1024 * 1024) })
    await unit.close()
    await expect(bigWrite).resolves.toBeUndefined()
    const onDisk = JSON.parse(await readFile(join(root, 'shape.json'), 'utf8')) as {
      tables: Record<string, Record<string, unknown>>
    }
    expect(onDisk.tables['t']?.['big']).toBeDefined()

    const backend2 = new JsonStorageBackend(root)
    const opening = backend2.kv.open(descriptor)
    const closing = backend2.close()
    await expect(opening.then(u => u.putRecord('t', 'x', {}))).rejects.toMatchObject({ code: 'closed' })
    await closing
  })

  it('serializes overlapping publishes so the newest acknowledged write reaches disk', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    // Overlapping un-awaited writes stage independent temp files; renames must
    // not complete out of call order and strand a stale snapshot. Holding the
    // first publication until every later write is queued proves each slot
    // publishes only committed earlier slots plus its own mutation.
    const hold = deferred()
    const written = stagePublications([{ holdUntil: hold.promise }])
    const pending: Promise<void>[] = []
    for (let index = 0; index < 24; index += 1) {
      pending.push(unit.putRecord('t', 'shared', { v: index }))
    }
    hold.resolve()
    await Promise.all(pending)
    expect(written).toHaveLength(24)
    expect((JSON.parse(written[0]!) as {
      tables: Record<string, Record<string, unknown>>
    }).tables['t']?.['shared']).toEqual({ v: 0 })
    const onDisk = JSON.parse(await readFile(join(root, 'shape.json'), 'utf8')) as {
      tables: Record<string, Record<string, unknown>>
    }
    expect(onDisk.tables['t']?.['shared']).toEqual({ v: 23 })
    await backend.close()
  })

  it('keeps both records when a second put overlaps an unresolved first', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    const hold = deferred()
    const written = stagePublications([{ holdUntil: hold.promise }])
    const first = unit.putRecord('t', 'a', { v: 'first' })
    const second = unit.putRecord('t', 'b', { v: 'second' })
    hold.resolve()
    await Promise.all([first, second])
    expect(written).toHaveLength(2)
    // The first slot's snapshot predates the second put entirely.
    expect((JSON.parse(written[0]!) as {
      tables: Record<string, Record<string, unknown>>
    }).tables['t']).toEqual({ a: { v: 'first' } })
    const onDisk = JSON.parse(await readFile(join(root, 'shape.json'), 'utf8')) as {
      tables: Record<string, Record<string, unknown>>
    }
    expect(onDisk.tables['t']).toEqual({ a: { v: 'first' }, b: { v: 'second' } })
    await backend.close()
  })

  it('keeps a rejected overlapping write out of memory and off disk', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('t', 'a', { v: 'committed' })
    const rejection = new Error('publish rejected')
    const written = stagePublications([{}, { failWith: rejection }])
    const kept = unit.putRecord('t', 'b', { v: 'kept' })
    const rejected = unit.putRecord('t', 'c', { v: 'rejected' })
    await expect(rejected).rejects.toBe(rejection)
    await expect(kept).resolves.toBeUndefined()
    expect(written).toHaveLength(1)
    // The surviving slot's snapshot carries no trace of the rejected write.
    expect((JSON.parse(written[0]!) as {
      tables: Record<string, Record<string, unknown>>
    }).tables['t']).toEqual({ a: { v: 'committed' }, b: { v: 'kept' } })
    const onDisk = JSON.parse(await readFile(join(root, 'shape.json'), 'utf8')) as {
      tables: Record<string, Record<string, unknown>>
    }
    expect(onDisk.tables['t']).toEqual({ a: { v: 'committed' }, b: { v: 'kept' } })
    expect((await unit.loadAll()).tables['t']).toEqual(onDisk.tables['t'])
    await backend.close()
  })

  it('publishes sequential writes in call order with each resolution durable', async () => {
    const root = await freshRoot()
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv.open(descriptor)
    const path = join(root, 'shape.json')
    const readShared = async (): Promise<unknown> => {
      const onDisk = JSON.parse(await readFile(path, 'utf8')) as {
        tables: Record<string, Record<string, unknown>>
      }
      return onDisk.tables['t']?.['k']
    }
    await unit.putRecord('t', 'k', { v: 1 })
    expect(await readShared()).toEqual({ v: 1 })
    await unit.putRecord('t', 'k', { v: 2 })
    expect(await readShared()).toEqual({ v: 2 })
    await backend.close()
  })
})
