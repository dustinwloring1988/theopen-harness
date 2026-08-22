import { createUserMessage } from '@buckeyestudio/toh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@buckeyestudio/cordis'
import LlmRuntime from '@buckeyestudio/toh-llm'
import * as LlmDeepSeek from '@buckeyestudio/toh-llm-deepseek'
import SessionStore, { SessionId } from '@buckeyestudio/toh-session'
import SessionTitleService from '@buckeyestudio/toh-session-title'
import * as FirstMessageTitleProvider from '@buckeyestudio/toh-session-title-first-prompt-llm'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

const FLASH = process.env.DEEPSEEK_E2E_MODEL_FLASH ?? 'deepseek-v4-flash'

// A gateway model may ignore `thinking: disabled` and reason before titling;
// give its output room so the 64-token smoke budget is not consumed by CoT.
const PUBLIC_BASE = 'https://api.deepseek.com'
const GATEWAY_MODE = (process.env.DEEPSEEK_BASE_URL ?? PUBLIC_BASE) !== PUBLIC_BASE

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('first-prompt title provider with real DeepSeek API', () => {
  it('replaces the fallback with a short model title', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, { thinking: 'disabled' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionTitleService, {
      fallbackMaxWords: 5,
      fallbackMaxBytes: 40,
      maxTitleBytes: 80,
    })
    await ctx.plugin(FirstMessageTitleProvider, {
      targetWords: 5,
      targetCjkCharacters: 10,
      maxInputBytes: 4_096,
      maxOutputTokens: GATEWAY_MODE ? 2_048 : 64,
      timeoutMs: 60_000,
      provider: 'deepseek-official',
      model: FLASH,
    })
    const session = ctx.sessions.create(SessionId('real-title-provider'))
    session.append('turn/start', {
      turn: 1,
    })
    const message = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Explain why append-only logs make session titles durable.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const title = await ctx.sessionTitle.refresh(session)

    expect(title).toMatchObject({
      messageSeqs: [message.seq],
      source: {
        kind: 'provider',
        provider: 'session-title-first-prompt-llm',
        model: { provider: 'deepseek-official', model: FLASH },
      },
    })
    expect(title?.title.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(title?.title ?? '', 'utf8')).toBeLessThanOrEqual(80)
  })
})
