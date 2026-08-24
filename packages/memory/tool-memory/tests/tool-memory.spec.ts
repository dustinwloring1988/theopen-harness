/**
 * Tests for the model-facing memory tools: registration, execute round-trips
 * through the real local provider, workspace-scope resolution from the
 * calling agent, bounded recall output, render intents, and the
 * system-prompt guidance section.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@buckeyestudio/cordis'
import { CallId } from '@buckeyestudio/toh-llm'
import { Inbox, type Agent } from '@buckeyestudio/toh-agent'
import { Session, SessionId } from '@buckeyestudio/toh-session'
import MemoryRegistry from '@buckeyestudio/toh-memory'
import * as MemoryLocal from '@buckeyestudio/toh-memory-local'
import SystemPrompt from '@buckeyestudio/toh-system-prompt'
import ToolRuntime from '@buckeyestudio/toh-tools'
import type { ToolExecutionFailure, ToolExecutionResult, ToolExecutionSuccess } from '@buckeyestudio/toh-tools'
import * as ToolMemory from '@buckeyestudio/toh-tool-memory'
import Storage from '@buckeyestudio/toh-storage'
import * as StorageDomain from '@buckeyestudio/toh-storage-domain'
import * as StorageJson from '@buckeyestudio/toh-storage-json'

const roots: string[] = []
const signal = new AbortController().signal

afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

async function setup(config: ToolMemory.Config = {}): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'toh-tool-memory-'))
  roots.push(root)
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(MemoryRegistry)
  await ctx.plugin(MemoryLocal)
  await ctx.plugin(ToolMemory, config)
  return ctx
}

/** A minimal calling agent whose session header carries the workspace cwd. */
function agentFor(cwd = '/work/project'): Agent {
  const id = SessionId('tool-memory-agent')
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd })
  return {
    ctx: new Context(),
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function assertSuccess(result: ToolExecutionResult): asserts result is ToolExecutionSuccess {
  if (result.isError) throw new Error(`expected success, got ${JSON.stringify(result.error)}`)
}

function assertFailure(result: ToolExecutionResult): asserts result is ToolExecutionFailure {
  if (!result.isError) throw new Error('expected failure')
}

async function execute(ctx: Context, name: string, args: Record<string, unknown>, agent?: Agent): Promise<ToolExecutionResult> {
  return await ctx.tools.execute({
    signal,
    callId: CallId(`call-${name}`),
    name,
    arguments: args,
    ...(agent !== undefined ? { agent } : {}),
  })
}

describe('memory tools', () => {
  it('registers all three tools and the prompt guidance section', async () => {
    const ctx = await setup()
    expect(ctx.tools.get('memory_remember')).toBeDefined()
    expect(ctx.tools.get('memory_recall')).toBeDefined()
    expect(ctx.tools.get('memory_forget')).toBeDefined()
    const prompt = await ctx.systemPrompt.assemble()
    const section = prompt.sections.find(candidate => candidate.name === 'tool:memory')
    expect(section?.text).toContain('memory_remember')
    expect(section?.text).toContain('Do not store secrets')
  })

  it('stores, recalls, and forgets through the calling agent workspace scope', async () => {
    const ctx = await setup()
    const stored = await execute(ctx, 'memory_remember', {
      fact: 'Release automation runs through pnpm',
      tags: ['release', 'pnpm'],
    }, agentFor('/work/one'))
    assertSuccess(stored)
    const storedValue = stored.value as { id: string; tags: string[] }
    expect(storedValue.tags).toEqual(['release', 'pnpm'])
    expect(stored.content[0]).toMatchObject({ type: 'text', text: `Stored memory ${storedValue.id}.` })

    const recalled = await execute(ctx, 'memory_recall', { query: 'release pnpm' }, agentFor('/work/one'))
    assertSuccess(recalled)
    expect(recalled.value).toMatchObject({ total: 1, returned: 1, truncated: false })

    // A different workspace does not see the fact.
    const elsewhere = await execute(ctx, 'memory_recall', { query: 'release' }, agentFor('/work/two'))
    assertSuccess(elsewhere)
    expect((elsewhere.value as { total: number }).total).toBe(0)
    expect(elsewhere.content[0]).toMatchObject({ type: 'text', text: 'No stored memories matched.' })

    const forgotten = await execute(ctx, 'memory_forget', { id: storedValue.id }, agentFor('/work/one'))
    assertSuccess(forgotten)
    expect(forgotten.value).toEqual({ id: storedValue.id, forgotten: true })
    expect(forgotten.content[0]).toMatchObject({ type: 'text', text: `Forgot memory ${storedValue.id}.` })

    const repeat = await execute(ctx, 'memory_forget', { id: storedValue.id }, agentFor('/work/one'))
    assertSuccess(repeat)
    expect(repeat.value).toEqual({ id: storedValue.id, forgotten: false })
    expect(repeat.content[0]).toMatchObject({ type: 'text', text: `No stored memory with id ${storedValue.id}.` })
  })

  it('caps recall output at the configured maximum and reports truncation', async () => {
    const ctx = await setup({ maxRecallResults: 2 })
    for (const suffix of ['alpha', 'beta', 'gamma']) {
      const result = await execute(ctx, 'memory_remember', { fact: `bounded fact ${suffix}` }, agentFor())
      assertSuccess(result)
    }
    const recalled = await execute(ctx, 'memory_recall', {}, agentFor())
    assertSuccess(recalled)
    expect(recalled.value).toMatchObject({ total: 3, returned: 2, truncated: true })
    const recalledText = (recalled.content[0] as { text: string }).text
    expect(recalledText).toContain('(showing first 2)')
  })

  it('fails loud without a calling agent cwd and on blank or empty inputs', async () => {
    const ctx = await setup()

    const noScope = await execute(ctx, 'memory_remember', { fact: 'orphan fact' })
    assertFailure(noScope)
    expect(noScope.error.message).toContain('workspace')

    const blankFact = await execute(ctx, 'memory_remember', { fact: '   ' }, agentFor())
    assertFailure(blankFact)
    expect(blankFact.error.message).toContain('non-empty')

    const badTag = await execute(ctx, 'memory_remember', { fact: 'ok fact', tags: ['  '] }, agentFor())
    assertFailure(badTag)
    expect(badTag.error.message).toContain('non-empty strings')
  })

  it('declares stable generic render intents per tool', async () => {
    const ctx = await setup()
    expect(ctx.tools.get('memory_remember')?.presentCall?.({ fact: 'f', tags: [] })).toEqual({
      card: 'generic',
      title: 'Remember fact',
      kind: 'execute',
      rawInput: 'f',
    })
    expect(ctx.tools.get('memory_recall')?.presentCall?.({ query: 'q' })).toEqual({
      card: 'generic',
      title: 'Search memories',
      kind: 'search',
      rawInput: 'q',
    })
    expect(ctx.tools.get('memory_forget')?.presentCall?.({ id: 'm1' })).toMatchObject({
      card: 'generic',
      kind: 'delete',
    })
  })
})
