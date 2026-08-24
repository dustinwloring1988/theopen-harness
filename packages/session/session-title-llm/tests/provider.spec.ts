import { Context } from '@buckeyestudio/cordis'
import { describe, expect, it, vi } from 'vitest'
import LlmRuntime, { createUserMessage, LlmAdapter  } from '@buckeyestudio/toh-llm'
import type { GenerateOptions, StreamChunk } from '@buckeyestudio/toh-llm'
import SessionStore, { Session, SessionId } from '@buckeyestudio/toh-session'
import SessionTitleService, { type SessionTitleProvider } from '@buckeyestudio/toh-session-title'
import * as providerPlugin from '@buckeyestudio/toh-session-title-llm'

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'text-delta', index: 0, text: 'Model title' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const TITLE_CONFIG = { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 } as const
const FIRST_PROMPT_CONFIG = {
  cadence: 'first-prompt',
  targetWords: 5,
  targetCjkCharacters: 10,
  maxInputBytes: 1_000,
  maxOutputTokens: 32,
  timeoutMs: 1_000,
  provider: 'title-route',
  model: 'title-model',
} as const
const ALL_PROMPTS_CONFIG = {
  cadence: 'all-prompts',
  targetWords: 5,
  targetCjkCharacters: 10,
  maxInputBytes: 1_000,
  maxOutputTokens: 32,
  timeoutMs: 1_000,
} as const

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('first-prompt cadence', () => {
  it('rejects an impossible empty provider request at its own boundary', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, TITLE_CONFIG)
    let registered: SessionTitleProvider | undefined
    vi.spyOn(ctx.sessionTitle, 'register').mockImplementation((provider) => {
      registered = provider
      return async () => undefined
    })
    providerPlugin.apply(ctx, FIRST_PROMPT_CONFIG)

    await expect(registered!.generate({
      session: Session.create(SessionId('empty-first-provider')),
      messages: [],
      signal: new AbortController().signal,
    })).rejects.toThrow(/requires one human message/)
  })

  it('always selects only the first eligible human message under its provenance id', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, TITLE_CONFIG)
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['title-route'], adapter)
    await ctx.plugin(providerPlugin, FIRST_PROMPT_CONFIG)
    const session = ctx.sessions.create(SessionId('first-plugin'))
    session.append('turn/start', { turn: 1 })
    const first = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'first input' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await settle()
    session.append('request/header', {
      header: { config: { provider: 'main', model: 'main-model' } }, reason: 'initial',
    })
    await settle()
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'second input must be ignored' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await ctx.sessionTitle.refresh(session)

    expect(adapter.requests).toHaveLength(2)
    for (const options of adapter.requests) {
      const content = options.messages[0]?.content[0]
      expect(content?.type === 'text' && content.text).toContain('first input')
      expect(content?.type === 'text' && content.text).not.toContain('second input must be ignored')
    }
    expect(ctx.sessionTitle.get(session)).toMatchObject({
      messageSeqs: [first.seq],
      source: {
        kind: 'provider',
        provider: 'session-title-first-prompt-llm',
        model: { provider: 'title-route', model: 'title-model' },
      },
    })
  })
})

describe('all-prompts cadence', () => {
  it('includes seeded history and the latest prompt while inheriting the logged request route', async () => {
    const seeded = Session.create(SessionId('seed-source'))
    seeded.append('turn/start', { turn: 1 })
    const inherited = seeded.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'inherited prompt' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    seeded.append('session/title', {
      title: 'Inherited fallback', messageSeqs: [inherited.seq], source: { kind: 'fallback' },
    })
    seeded.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, TITLE_CONFIG)
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['current-route'], adapter)
    await ctx.plugin(providerPlugin, ALL_PROMPTS_CONFIG)
    const session = ctx.sessions.create(SessionId('all-plugin'), {
      seed: seeded.events,
      meta: { parentSession: seeded.id, seedLength: seeded.seq },
    })
    session.append('turn/start', { turn: 2 })
    const latest = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'latest prompt' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await settle()
    session.append('request/header', {
      header: { config: { provider: 'current-route', model: 'current-model' } }, reason: 'resume',
    })
    await settle()

    expect(adapter.requests[0]).toMatchObject({ provider: 'current-route', model: 'current-model' })
    const content = adapter.requests[0]?.messages[0]?.content[0]
    expect(content?.type === 'text' && content.text).toContain('inherited prompt')
    expect(content?.type === 'text' && content.text).toContain('latest prompt')
    expect(ctx.sessionTitle.get(session)).toMatchObject({
      messageSeqs: [inherited.seq, latest.seq],
      source: {
        kind: 'provider',
        provider: 'session-title-all-prompts-llm',
      },
    })
  })
})

describe('cadence dispatch', () => {
  it.each([
    ['first-prompt', FIRST_PROMPT_CONFIG],
    ['all-prompts', ALL_PROMPTS_CONFIG],
  ] as const)('direct application registers exactly one %s provider under its derived identity', async (_cadence, config) => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, TITLE_CONFIG)
    const registered: SessionTitleProvider[] = []
    vi.spyOn(ctx.sessionTitle, 'register').mockImplementation((provider) => {
      registered.push(provider)
      return async () => undefined
    })

    expect(() => {
      providerPlugin.apply(ctx, config)
    }).not.toThrow()

    expect(registered).toHaveLength(1)
    expect(registered[0]!.automatic).toBe(config.cadence)
    expect(registered[0]!.id).toBe(`session-title-${config.cadence}-llm`)
  })

  it('rejects an unsupported cadence before registering any provider', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, TITLE_CONFIG)
    const register = vi.spyOn(ctx.sessionTitle, 'register')

    expect(() => {
      providerPlugin.apply(ctx, { ...FIRST_PROMPT_CONFIG, cadence: 'sometimes' } as never)
    }).toThrow(/cadence must be "first-prompt" or "all-prompts"/)
    expect(register).not.toHaveBeenCalled()
  })
})
