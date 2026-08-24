/**
 * Tests for the local memory provider: remember/recall/forget round-trip,
 * keyword/tag/scope narrowing, newest-first ordering, and persistence across
 * a full context reopen over the same storage root.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@buckeyestudio/cordis'
import MemoryRegistry from '@buckeyestudio/toh-memory'
import * as MemoryLocal from '@buckeyestudio/toh-memory-local'
import { matchesRow } from '@buckeyestudio/toh-memory-local/src/match.ts'
import Storage from '@buckeyestudio/toh-storage'
import * as StorageDomain from '@buckeyestudio/toh-storage-domain'
import * as StorageJson from '@buckeyestudio/toh-storage-json'

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `toh-memory-local-${prefix}-`))
  roots.push(root)
  return root
}

/** One fully composed context over `root`, as a deployment would mount it. */
async function mountedContext(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(MemoryRegistry)
  await ctx.plugin(MemoryLocal)
  return ctx
}

describe('local memory provider', () => {
  it('registers under the memory registry and round-trips a fact', async () => {
    const ctx = await mountedContext(await tempRoot('roundtrip'))
    const stored = await ctx.memory.remember({
      text: 'Deploy scripts live in infra/ci',
      tags: ['deploy', 'ci'],
      scope: '/work/project',
    })
    expect(stored.id).toBeTruthy()
    expect(stored).toMatchObject({
      text: 'Deploy scripts live in infra/ci',
      tags: ['deploy', 'ci'],
      scope: '/work/project',
    })

    const hits = await ctx.memory.recall('deploy scripts', { scope: '/work/project' })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.id).toBe(stored.id)

    await expect(ctx.memory.forget(stored.id)).resolves.toBe(true)
    await expect(ctx.memory.recall('deploy scripts', { scope: '/work/project' })).resolves.toHaveLength(0)
    await expect(ctx.memory.forget(stored.id)).resolves.toBe(false)
  })

  it('matches every keyword case-insensitively and narrows by scope and tag conjunction', async () => {
    const ctx = await mountedContext(await tempRoot('narrowing'))
    const kept = await ctx.memory.remember({ text: 'The Build Server needs VPN', tags: ['infra'], scope: '/a' })
    await ctx.memory.remember({ text: 'the build server needs vpn', tags: ['other'], scope: '/b' })
    await ctx.memory.remember({ text: 'Unrelated fact about servers', tags: ['infra'], scope: '/a' })

    const bothKeywords = await ctx.memory.recall('build vpn', { scope: '/a' })
    expect(bothKeywords.map(hit => hit.id)).toEqual([kept.id])

    // Scope /b stores the same words; scope narrowing keeps them apart.
    const scoped = await ctx.memory.recall('build vpn', { scope: '/b' })
    expect(scoped).toHaveLength(1)
    expect(scoped[0]?.scope).toBe('/b')

    // Tag conjunction: only rows carrying EVERY requested tag survive.
    await ctx.memory.remember({ text: 'build vpn again', tags: ['infra', 'extra'], scope: '/a' })
    const tagged = await ctx.memory.recall('build vpn', { scope: '/a', tags: ['infra', 'extra'] })
    expect(tagged).toHaveLength(1)
  })

  it('orders recall results newest first with an empty query matching everything narrowed', async () => {
    const ctx = await mountedContext(await tempRoot('ordering'))
    const first = await ctx.memory.remember({ text: 'older fact', scope: '/w' })
    const second = await ctx.memory.remember({ text: 'newer fact', scope: '/w' })
    const hits = await ctx.memory.recall('', { scope: '/w' })
    expect(hits.map(hit => hit.id)).toEqual([second.id, first.id])
  })

  it('persists facts across a full context reopen of the same storage root', async () => {
    const root = await tempRoot('reopen')
    const writer = await mountedContext(root)
    const written = await writer.memory.remember({ text: 'Windows needs koffi for pty', tags: ['windows'], scope: '/repo' })
    // Closing the writer releases the JSON unit file before the reader opens it.
    await writer.fiber.dispose()
    const reader = await mountedContext(root)
    const hits = await reader.memory.recall('koffi windows', { scope: '/repo' })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ id: written.id, text: 'Windows needs koffi for pty', tags: ['windows'] })
    await reader.fiber.dispose()
  })

  it('rejects malformed stored rows at open instead of serving them', async () => {
    const { writeFile } = await import('node:fs/promises')
    const root = await tempRoot('corrupt')
    await writeFile(join(root, 'memory.json'), JSON.stringify({
      version: 1,
      global: null,
      tables: { facts: { 'bad-row': { scope: '', text: '', tags: 'not-an-array', createdAt: -1 } } },
    }))
    await expect(mountedContext(root)).rejects.toThrow()
  })

  it('keeps the pure matcher exact on tokens, tags, and scope', () => {
    const row = { scope: '/w', text: 'Alpha Beta gamma', tags: ['x', 'y'], createdAt: 1 }
    expect(matchesRow(row, queryTokensOf('alpha beta'), {})).toBe(true)
    expect(matchesRow(row, queryTokensOf('alpha delta'), {})).toBe(false)
    expect(matchesRow(row, [], { tags: ['x', 'z'] })).toBe(false)
    expect(matchesRow(row, [], { scope: '/other' })).toBe(false)
    expect(matchesRow(row, [], { scope: '/w', tags: ['y'] })).toBe(true)
  })
})

function queryTokensOf(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(token => token.length > 0)
}
