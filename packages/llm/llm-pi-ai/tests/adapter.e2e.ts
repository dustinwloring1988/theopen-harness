import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@buckeyestudio/cordis'
import LlmRuntime, { createUserMessage, CallId, ReasoningEffortId  } from '@buckeyestudio/toh-llm'
import type { Message, ToolSchema } from '@buckeyestudio/toh-llm'
import * as LlmPiAi from '@buckeyestudio/toh-llm-pi-ai'
import type { PiAiProviderProfile } from '@buckeyestudio/toh-llm-pi-ai'
import * as LlmDeepSeek from '@buckeyestudio/toh-llm-deepseek'
import { assemble, type AssembledResult } from './assemble.ts'

/**
 * Real-API e2e for the pi-ai-backed adapter: the resolved Flash + Pro slots
 * with provider defaults, plus representative off/high/max reasoning and a
 * replayed tool follow-up on the public endpoint. Mirrors the native adapter's
 * StreamChunk contract. Key-gated; like every real-API suite, the model slots
 * resolve from DEEPSEEK_E2E_MODEL_FLASH / _PRO so any completions gateway
 * serves the plain-text lane.
 */

const FLASH = process.env.DEEPSEEK_E2E_MODEL_FLASH ?? 'deepseek-v4-flash'
const PRO = process.env.DEEPSEEK_E2E_MODEL_PRO ?? 'deepseek-v4-pro'
// A base-URL override away from the public endpoint fronts a completions
// gateway whose models the installed pi-ai catalog does not describe: such
// slots resolve as non-reasoning and the request path refuses every named
// effort, so named-effort scenarios and the wire-shape parity check stay on
// the pinned public endpoint. CI exports the public URL verbatim for the
// DeepSeek lane, so gateway mode keys on the value, not the variable;
// trailing slashes are stripped so a decorated public URL stays official.
const GATEWAY_MODE = (process.env.DEEPSEEK_BASE_URL ?? LlmDeepSeek.PUBLIC_BASE_URL)
  .replace(/\/+$/, '') !== LlmDeepSeek.PUBLIC_BASE_URL
const contexts: Context[] = []

async function harness(_model: string, config: Partial<PiAiProviderProfile> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {
    providers: {
      deepseek: {
        ...process.env.DEEPSEEK_API_KEY === undefined ? {} : { apiKey: process.env.DEEPSEEK_API_KEY },
        ...process.env.DEEPSEEK_BASE_URL === undefined ? {} : { baseURL: process.env.DEEPSEEK_BASE_URL },
        // Gateway slots are ids the installed catalog does not describe, so
        // they must be declared to be routable; a bare id yields serviceable
        // defaults. Public-endpoint runs keep the installed catalog, whose
        // entries carry the reasoning metadata the provider-native scenarios
        // assert.
        ...(GATEWAY_MODE ? { models: [{ id: FLASH }, { id: PRO }] } : {}),
        ...config,
      },
    },
  })
  return ctx
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function ask(text: string): Message[] {
  return [createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'test' },
  })]
}

function textOf(result: AssembledResult): string {
  return result.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function blockKinds(result: AssembledResult): string[] {
  return result.message.content.map(block => block.type)
}

const weatherTool: ToolSchema = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('llm-pi-ai e2e (real API)', () => {
  it.each([FLASH, PRO])('%s + provider-default reasoning: plain text generation', async (model) => {
    const ctx = await harness(model)
    const result = await assemble(ctx,{
      model,
      messages: ask('Reply with exactly the word: pong'),
      maxTokens: 50,
    })
    expect(result.finish.kind).toBe('stop')
    expect(textOf(result).toLowerCase()).toContain('pong')
  })
})

/**
 * Reasoning-control scenarios assume the endpoint IS the installed DeepSeek
 * API, where thinking-mode and effort fields are honored provider extensions:
 * a gateway slot the catalog does not describe resolves as non-reasoning, and
 * naming any effort there — including `off`, which has nothing to disable —
 * fails with `UNSUPPORTED_REASONING_EFFORT` before provider I/O. So these run
 * only against the pinned public endpoint.
 */
describe.skipIf(!process.env.DEEPSEEK_API_KEY || GATEWAY_MODE)('llm-pi-ai e2e (real API, provider-native reasoning)', () => {
  it('flash + reasoning off: plain text without reasoning blocks', async () => {
    const ctx = await harness(FLASH)
    const result = await assemble(ctx,{
      model: FLASH,
      reasoningEffort: ReasoningEffortId('off'),
      messages: ask('Reply with exactly the word: pong'),
      maxTokens: 50,
    })
    expect(result.finish.kind).toBe('stop')
    expect(result.message.content.some(block => block.type === 'reasoning')).toBe(false)
    expect(textOf(result).toLowerCase()).toContain('pong')
  })

  it.each([FLASH, PRO])('%s + reasoning high: reasoning blocks present', async (model) => {
    const ctx = await harness(model)
    const result = await assemble(ctx,{
      model,
      reasoningEffort: ReasoningEffortId('high'),
      messages: ask('Which is larger, 9.11 or 9.8? Answer with just the number.'),
      maxTokens: 2000,
    })
    expect(result.finish.kind).toBe('stop')
    expect(result.message.content.some(block => block.type === 'reasoning')).toBe(true)
    expect(textOf(result)).toContain('9.8')
  })

  it('pro + reasoning max: tool-call round trip', async () => {
    const ctx = await harness(PRO)

    const first = await assemble(ctx,{
      model: PRO,
      reasoningEffort: ReasoningEffortId('max'),
      messages: ask('What is the weather in Paris right now? Use the get_weather tool.'),
      tools: [weatherTool],
      maxTokens: 2000,
    })
    expect(first.finish.kind).toBe('tool-calls')
    const call = first.message.content.find(block => block.type === 'tool-call')
    expect(call).toBeDefined()
    expect(call!.name).toBe('get_weather')
    expect(JSON.parse(call!.arguments)).toMatchObject({ city: expect.stringMatching(/paris/i) as string })

    const second = await assemble(ctx,{
      model: PRO,
      reasoningEffort: ReasoningEffortId('max'),
      messages: [
        ...ask('What is the weather in Paris right now? Use the get_weather tool.'),
        first.message,
        createUserMessage({
          content: [{
            type: 'tool-result',
            toolCallId: CallId(call!.id),
            content: [{ type: 'text', text: 'Sunny, 22°C' }],
          }],
          source: { kind: 'plugin', plugin: 'test' },
        }),
      ],
      tools: [weatherTool],
      maxTokens: 2000,
    })
    expect(second.finish.kind).toBe('stop')
    expect(textOf(second).toLowerCase()).toMatch(/sunny|22/)
  })

  it('produces the same block structure as llm-deepseek for the same prompt', async () => {
    // Loose structural equivalence between the two independent adapters:
    // same block KINDS in the same order for a deterministic prompt — the
    // cross-implementation check that the StreamChunk design holds. Gateway
    // reasoning fields reach one adapter and not the other, so parity is a
    // same-endpoint property.
    const deepseekCtx = new Context()
    contexts.push(deepseekCtx)
    await deepseekCtx.plugin(LlmRuntime)
    await deepseekCtx.plugin(LlmDeepSeek, { thinking: 'disabled' })

    const piCtx = await harness(FLASH)

    const prompt = ask('Reply with exactly the word: pong')
    const [fromDeepSeek, fromPiAi] = await Promise.all([
      assemble(deepseekCtx, { provider: 'deepseek-official', model: FLASH, messages: prompt, maxTokens: 50 }),
      assemble(piCtx, { model: FLASH, messages: prompt, maxTokens: 50 }),
    ])
    expect(blockKinds(fromPiAi)).toEqual(blockKinds(fromDeepSeek))
    expect(fromPiAi.finish.kind).toBe(fromDeepSeek.finish.kind)
  })
})
