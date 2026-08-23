import { describe, expect, it } from 'vitest'
import { Context } from '@buckeyestudio/cordis'
import { createUserMessage } from '@buckeyestudio/toh-llm'
import InvariantService, { InvariantError } from '@buckeyestudio/toh-invariants'
import SessionStore, { SessionId } from '@buckeyestudio/toh-session'
import * as TurnBudgetInvariant from '../src/invariant.ts'

/**
 * Package invariant suite: the durable log must carry at most one wrap-up
 * notice per turn, always inside an open turn's span, so a later
 * hook-cancelled close of that turn is preceded by its advisory.
 */

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(TurnBudgetInvariant)
  return ctx
}

function wrapUpNotice(summary: string) {
  return createUserMessage({
    content: [{ type: 'text', text: 'Turn budget advisory.' }],
    source: { kind: 'plugin', plugin: 'turn-budget-policy', form: 'notice', summary },
  })
}

describe('turn-budget-policy stream invariant', () => {
  it('accepts one notice inside a turn that later closes hook-cancelled', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('budget-ok'))
    expect(() => {
      session.append('turn/start', { turn: 1 })
      session.append('user/message', wrapUpNotice('turn budget: 2 steps'), { surfaceOp: 'append' })
      session.append('step/start', { turn: 1, step: 3 })
      session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'turn budget exceeded' } } })
    }).not.toThrow()
  })

  it('rejects a second wrap-up notice inside the same open turn', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('budget-double'))
    expect(() => {
      session.append('turn/start', { turn: 1 })
      session.append('user/message', wrapUpNotice('turn budget: 2 steps'), { surfaceOp: 'append' })
    }).not.toThrow()
    expect(() => {
      session.append('user/message', wrapUpNotice('turn budget: 3 steps'), { surfaceOp: 'append' })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@buckeyestudio/toh-turn-budget-policy',
    }))
  })

  it('rejects a wrap-up notice recorded outside any open turn', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('budget-orphan'))
    expect(() => {
      session.append('user/message', wrapUpNotice('turn budget: 2 steps'), { surfaceOp: 'append' })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@buckeyestudio/toh-turn-budget-policy',
    }))
    expect(session.events).toEqual([])
  })

  it('accepts turns with no notice and notices in distinct turns', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('budget-multi'))
    expect(() => {
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      session.append('turn/start', { turn: 2 })
      session.append('user/message', wrapUpNotice('turn budget: 2 steps'), { surfaceOp: 'append' })
      session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    }).not.toThrow()
  })

  it('accepts a hook-cancelled close with no open-turn record to match', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('budget-headless-close'))
    expect(() => {
      session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'turn budget exceeded' } } })
    }).not.toThrow()
  })

  it('rejects a wrap-up notice after its turn already closed', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('budget-closed-tail'))
    expect(() => {
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }).not.toThrow()
    expect(() => {
      session.append('user/message', wrapUpNotice('turn budget: 2 steps'), { surfaceOp: 'append' })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@buckeyestudio/toh-turn-budget-policy',
    }))
  })

  it('sweeps pre-existing sessions at install and accepts a clean notice-bearing log', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const seeded = ctx.sessions.create(SessionId('budget-seeded'), {
      seed: [
        { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: 0, data: wrapUpNotice('turn budget: 3 steps'), surfaceOp: 'append' },
        { type: 'turn/end', seq: 2, time: 0, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'turn budget exceeded' } } } },
      ],
    })
    await ctx.plugin(InvariantService, { enabled: true })
    await ctx.plugin(TurnBudgetInvariant)
    expect(seeded.events.some(event => event.type === 'user/message')).toBe(true)
  })
})
