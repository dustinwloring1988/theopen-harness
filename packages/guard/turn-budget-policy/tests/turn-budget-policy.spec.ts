import { describe, expect, it } from 'vitest'
import { Context } from '@buckeyestudio/cordis'
import { CallId, createUserMessage } from '@buckeyestudio/toh-llm'
import type { StreamChunk } from '@buckeyestudio/toh-llm'
import { SessionId, type SessionEvent } from '@buckeyestudio/toh-session'
import { defineContentToolFixture } from '@buckeyestudio/toh-tools'
import type { Agent } from '@buckeyestudio/toh-agent'
import { agentEvents } from '@buckeyestudio/toh-agent'
import AgentLoop from '@buckeyestudio/toh-agent-loop'
import { mountAgentLoopTestDependencies } from '@buckeyestudio/toh-agent-loop-testkit'
import * as TurnBudgetPolicy from '@buckeyestudio/toh-turn-budget-policy'
import type { Config } from '@buckeyestudio/toh-turn-budget-policy'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Behavior suite for the turn-budget policy: hard step/token limits cancel
 * with a hook cause at an otherwise-completing stop boundary, the token limit
 * sums every request's reported usage across the open turn, the soft limit
 * steers exactly one wrap-up request per turn, state resets per turn, and
 * configuration fails loud — all driven through a real agent loop against a
 * scripted mock adapter (no network).
 */

/** Boot the core spine + the policy; the caller registers adapters and extra listeners. */
async function harness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TurnBudgetPolicy, config)
  ctx.tools.register(defineContentToolFixture({ name: 'probe', description: 'p', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => { const d = ctx.on('agent/status', ({ agent: s, status: st }) => { if (s === agent && st === 'idle') { d(); resolve() } }) })
}

async function run(ctx: Context, adapter: MockAdapter): Promise<Agent> {
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
  return agent
}

/** The turn/end reasons recorded in the agent's log. */
function turnEnds(agent: Agent): SessionEvent<'turn/end'>['data'][] {
  return [...agent.session.events]
    .filter((e): e is SessionEvent<'turn/end'> => e.type === 'turn/end')
    .map(e => e.data)
}

/** The policy's injected-context notices in the agent's log, flattened to joined text. */
function notices(agent: Agent): string[] {
  return [...agent.session.events]
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind === 'plugin' && e.data.source.plugin === 'turn-budget-policy')
    .map(e => e.data.content.map(block => block.type === 'text' ? block.text : '').join('|'))
}

describe('hard limits cancel the turn', () => {
  it('cancels with a hook cause when the closing attempt reaches maxStepsPerTurn', async () => {
    const ctx = await harness({ maxStepsPerTurn: 3 })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', {}),
      toolCallResponse('c2', 'probe', {}),
      textResponse('trying to stop'),
      textResponse('must not run'),
    ])
    const agent = await run(ctx, adapter)

    expect(notices(agent)).toHaveLength(0)
    expect(turnEnds(agent)).toEqual([{
      turn: 1,
      reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'turn budget exceeded: 3 steps reached maxStepsPerTurn 3' } },
    }])
    expect([...agent.session.events].filter(e => e.type === 'step/start')).toHaveLength(3)
  })

  it('keeps running below the limit and completes normally', async () => {
    const ctx = await harness({ maxStepsPerTurn: 5 })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', {}),
      toolCallResponse('c2', 'probe', {}),
      textResponse('done'),
    ])
    const agent = await run(ctx, adapter)

    expect(turnEnds(agent)).toEqual([{ turn: 1, reason: { kind: 'completed' } }])
    expect(notices(agent)).toHaveLength(0)
  })

  it('keeps running below the token limit and completes normally', async () => {
    const ctx = await harness({ maxTurnTokens: 1_000_000 })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', {}),
      toolCallResponse('c2', 'probe', {}),
      textResponse('done'),
    ])
    const agent = await run(ctx, adapter)

    expect(turnEnds(agent)).toEqual([{ turn: 1, reason: { kind: 'completed' } }])
  })

  it('sums every request across multiple steps and cancels at the closing attempt that crosses the limit', async () => {
    const ctx = await harness({ maxTurnTokens: 40 })
    // Each request reports disjoint input+output usage (15 + 15 + 24), so the
    // cumulative spend crosses 40 exactly at the third closing attempt; a
    // shared-surface delta would see only the accumulated outputs (24).
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', {}),
      toolCallResponse('c2', 'probe', {}),
      textResponse('trying to stop'),
      textResponse('must not run'),
    ])
    const agent = await run(ctx, adapter)

    expect(notices(agent)).toHaveLength(0)
    expect([...agent.session.events].filter(e => e.type === 'step/start')).toHaveLength(3)
    expect(turnEnds(agent)).toEqual([{
      turn: 1,
      reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'turn budget exceeded: 54 tokens reached maxTurnTokens 40' } },
    }])
  })

  it('cancels on the first closing attempt when a single request reaches the limit exactly', async () => {
    const ctx = await harness({ maxTurnTokens: 14 })
    const adapter = new MockAdapter([
      textResponse('stop'),
      textResponse('must not run'),
    ])
    const agent = await run(ctx, adapter)

    expect(turnEnds(agent)).toEqual([{
      turn: 1,
      reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'turn budget exceeded: 14 tokens reached maxTurnTokens 14' } },
    }])
    expect([...agent.session.events].filter(e => e.type === 'step/start')).toHaveLength(1)
  })

  it('skips requests without provider-reported usage and cancels on the reported ones', async () => {
    const ctx = await harness({ maxTurnTokens: 10 })
    const adapter = new MockAdapter([
      [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: CallId('n1'), name: 'probe', argumentsDelta: '{}' },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('n1'), name: 'probe', arguments: '{}' } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ] satisfies StreamChunk[],
      textResponse('closing attempt'),
      textResponse('must not run'),
    ])
    const agent = await run(ctx, adapter)

    expect(turnEnds(agent)).toEqual([{
      turn: 1,
      reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'turn budget exceeded: 25 tokens reached maxTurnTokens 10' } },
    }])
    expect([...agent.session.events].filter(e => e.type === 'step/start')).toHaveLength(2)
  })
})

describe('soft limit steers once before the hard limit', () => {
  it('steers one wrap-up notice; the model lands the turn inside the budget', async () => {
    const ctx = await harness({ warnAtSteps: 3, maxStepsPerTurn: 6 })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', {}),
      toolCallResponse('c2', 'probe', {}),
      textResponse('not done yet'),
      textResponse('wrapped up'),
    ])
    const agent = await run(ctx, adapter)

    const found = notices(agent)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('has already run 3 steps')
    expect(found[0]).toContain('Wrap the turn up now')
    expect(turnEnds(agent)).toEqual([{ turn: 1, reason: { kind: 'completed' } }])
  })

  it('steers unchanged when a token limit is configured but never reached', async () => {
    const ctx = await harness({ warnAtSteps: 3, maxStepsPerTurn: 6, maxTurnTokens: 1_000_000 })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', {}),
      toolCallResponse('c2', 'probe', {}),
      textResponse('not done yet'),
      textResponse('wrapped up'),
    ])
    const agent = await run(ctx, adapter)

    expect(notices(agent)).toHaveLength(1)
    expect(turnEnds(agent)).toEqual([{ turn: 1, reason: { kind: 'completed' } }])
  })

  it('hard-cancels on the next closing attempt after the single steer was ignored', async () => {
    const ctx = await harness({ warnAtSteps: 3, maxStepsPerTurn: 5 })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', {}),
      toolCallResponse('c2', 'probe', {}),
      textResponse('first closing attempt'),
      toolCallResponse('c3', 'probe', {}),
      textResponse('second closing attempt'),
    ])
    const agent = await run(ctx, adapter)

    expect(notices(agent)).toHaveLength(1)
    expect(turnEnds(agent)).toEqual([{
      turn: 1,
      reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'turn budget exceeded: 5 steps reached maxStepsPerTurn 5' } },
    }])
  })

  it('warnAtSteps alone advises without ever cancelling', async () => {
    const ctx = await harness({ warnAtSteps: 2 })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', {}),
      textResponse('closing attempt'),
      textResponse('wrapped up'),
    ])
    const agent = await run(ctx, adapter)

    expect(notices(agent)).toHaveLength(1)
    expect(turnEnds(agent)).toEqual([{ turn: 1, reason: { kind: 'completed' } }])
  })
})

describe('per-turn reset', () => {
  it('steers once per turn: a follow-up turn warns again from zero', async () => {
    const ctx = await harness({ warnAtSteps: 2, maxStepsPerTurn: 10 })
    const adapter = new MockAdapter([
      toolCallResponse('t1c1', 'probe', {}),
      textResponse('t1 closing attempt'),
      textResponse('t1 wrapped up'),
      toolCallResponse('t2c1', 'probe', {}),
      textResponse('t2 closing attempt'),
      textResponse('t2 wrapped up'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(notices(agent)).toHaveLength(1)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(notices(agent)).toHaveLength(2)
    expect(turnEnds(agent).map(end => end.reason.kind)).toEqual(['completed', 'completed'])
  })

  it('resets the step count on a fresh turn: a cancelled turn does not poison the next one', async () => {
    const ctx = await harness({ maxStepsPerTurn: 2 })
    const adapter = new MockAdapter([
      toolCallResponse('t1c1', 'probe', {}),
      textResponse('t1 closing attempt'),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(turnEnds(agent)[0]!.reason.kind).toBe('aborted')

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(turnEnds(agent).map(end => end.reason.kind)).toEqual(['aborted', 'completed'])
  })
})

describe('stop-boundary state guard', () => {
  it('ignores a dispatched stop boundary for a turn it never observed', async () => {
    const ctx = await harness({ maxStepsPerTurn: 2 })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    // Direct scoped dispatch without any pre-step: no state, no action.
    await expect(agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 7, signal: new AbortController().signal })).resolves.toBeUndefined()
    expect(turnEnds(agent)).toEqual([])
    expect(notices(agent)).toHaveLength(0)
  })
})

describe('config validation fails loud', () => {
  async function spine(): Promise<Context> {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    return ctx
  }

  it('rejects an empty config', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(TurnBudgetPolicy, {})).rejects.toThrow(/at least one of/)
  })

  it('rejects non-integer or non-positive limits', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(TurnBudgetPolicy, { maxStepsPerTurn: 2.5 })).rejects.toThrow(/maxStepsPerTurn.*integer >= 1/s)
    const ctx2 = await spine()
    await expect(ctx2.plugin(TurnBudgetPolicy, { maxTurnTokens: 0 })).rejects.toThrow(/maxTurnTokens.*integer >= 1/s)
    const ctx3 = await spine()
    await expect(ctx3.plugin(TurnBudgetPolicy, { warnAtSteps: -1 })).rejects.toThrow(/warnAtSteps.*integer >= 1/s)
  })

  it('rejects warnAtSteps at or above maxStepsPerTurn', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(TurnBudgetPolicy, { warnAtSteps: 4, maxStepsPerTurn: 4 })).rejects.toThrow(/must stay below maxStepsPerTurn 4/)
    const ctx2 = await spine()
    await expect(ctx2.plugin(TurnBudgetPolicy, { warnAtSteps: 5, maxStepsPerTurn: 4 })).rejects.toThrow(/must stay below maxStepsPerTurn 4/)
  })

  it('accepts a valid config without any optional services', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(TurnBudgetPolicy, { maxTurnTokens: 100, warnAtSteps: 2, maxStepsPerTurn: 4 })).resolves.toBeDefined()
  })
})
