/**
 * Tests for the MCP Prompts -> skill-provider bridge: candidate mapping from
 * prompts/list (kebab-case slugs, descriptions, arguments), lazy prompts/get
 * body loading, invocation policy, and resync across reconnect generations.
 * Isolated file so vi.mock of the MCP SDK doesn't pollute other test suites.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@buckeyestudio/cordis'
import SystemPrompt from '@buckeyestudio/toh-system-prompt'
import ToolRuntime from '@buckeyestudio/toh-tools'
import SkillRegistry from '@buckeyestudio/toh-skill'
import { PromptListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Config } from '@buckeyestudio/toh-mcp-client'

// ---- Mock MCP SDK ----

// vi.mock factories are hoisted above every import/const, so the mock fns and
// class must be created inside vi.hoisted to exist when the factories run.
const {
  mockConnect,
  mockClose,
  mockListTools,
  mockCallTool,
  mockListPrompts,
  mockGetPrompt,
  mockSetNotificationHandler,
  MockClient,
  instances,
} = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockCallTool = vi.fn<(
    _params?: Record<string, unknown>, _compatibilitySchema?: unknown, _options?: unknown,
  ) => Promise<unknown>>()
  const mockListPrompts = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockGetPrompt = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockSetNotificationHandler = vi.fn()
  const mockRequest = vi.fn(async (
    request: { method: string; params?: Record<string, unknown> },
    _schema: unknown,
    options?: unknown,
  ): Promise<unknown> => {
    void options
    if (request.method === 'tools/list') return await mockListTools(request.params)
    if (request.method === 'tools/call') return await mockCallTool(request.params)
    if (request.method === 'prompts/list') return await mockListPrompts(request.params)
    if (request.method === 'prompts/get') return await mockGetPrompt(request.params)
    throw new Error(`unexpected MCP request: ${request.method}`)
  })
  class MockClient {
    onclose: (() => void) | undefined
    connect = mockConnect
    close = mockClose
    request = mockRequest
    setNotificationHandler = mockSetNotificationHandler
    constructor() { instances.push(this) }
  }
  const instances: MockClient[] = []
  return {
    mockConnect,
    mockClose,
    mockListTools,
    mockCallTool,
    mockListPrompts,
    mockGetPrompt,
    mockSetNotificationHandler,
    MockClient,
    instances,
  }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}))

// vi.mock is hoisted above static imports, so the modules under test see the
// mocked SDK even through a static import.
import { apply } from '@buckeyestudio/toh-mcp-client/src/index.ts'
import { PROMPTS_DEFAULTS, promptSkillSlug, resolvePromptsPolicy } from '@buckeyestudio/toh-mcp-client/src/prompts.ts'

// ---- Helpers ----

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  return ctx
}

function captureLogs(ctx: Context): { warns: string[]; errors: string[] } {
  const warns: string[] = []
  const errors: string[] = []
  ctx.logger.warn = ((message: unknown) => { warns.push(String(message)) }) as typeof ctx.logger.warn
  ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
  return { warns, errors }
}

interface PromptOverrides {
  readonly prompts?: Config['prompts']
}

function stdioConfig(overrides: PromptOverrides = {}): Config {
  return {
    transport: 'stdio',
    serverName: 'srv',
    command: 'echo',
    args: [],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    reconnect: { enabled: true, initialDelayMs: 5, maxDelayMs: 40, maxAttempts: 5 },
    ...overrides.prompts === undefined ? {} : { prompts: overrides.prompts },
  }
}

/** The tool list every mock generation advertises so tool sync always settles. */
function listingTools(): { tools: { name: string; inputSchema: { type: string } }[]; nextCursor: undefined } {
  return { tools: [{ name: 'remote', inputSchema: { type: 'object' } }], nextCursor: undefined }
}

function listingPrompts(...prompts: Record<string, unknown>[]): Record<string, unknown> {
  return { prompts, nextCursor: undefined }
}

async function skillNames(ctx: Context): Promise<string[]> {
  return (await ctx.skills.list()).map(skill => skill.name)
}

/** Extract the first notification handler registered for one exact SDK schema object. */
function handlerFor(schema: object): () => Promise<void> {
  for (const call of mockSetNotificationHandler.mock.calls as unknown[][]) {
    if (call[0] === schema) return call[1] as () => Promise<void>
  }
  throw new Error('notification handler not registered')
}

// ---- Policy resolution ----

describe('resolvePromptsPolicy', () => {
  const path = 'mcp-client(srv): prompts'

  it('resolves omission to the defaults, frozen', () => {
    const policy = resolvePromptsPolicy(undefined, path)
    expect(policy).toEqual(PROMPTS_DEFAULTS)
    expect(policy.enabled).toBe(false)
    expect(Object.isFrozen(policy)).toBe(true)
  })

  it('keeps explicit values', () => {
    expect(resolvePromptsPolicy({ enabled: true, modelInvocable: false }, path))
      .toEqual({ enabled: true, modelInvocable: false })
  })

  it('rejects unknown keys', () => {
    expect(() => resolvePromptsPolicy({ userInvocable: false } as never, path))
      .toThrow(/prompts\.userInvocable is not a prompts option/)
  })
})

describe('promptSkillSlug', () => {
  it('maps raw names to lowercase kebab-case', () => {
    expect(promptSkillSlug('code_review')).toBe('code-review')
    expect(promptSkillSlug('Code Review!')).toBe('code-review')
    expect(promptSkillSlug('get-weather')).toBe('get-weather')
  })

  it('trims separator runs at the edges', () => {
    expect(promptSkillSlug('--deep__research--')).toBe('deep-research')
  })

  it('returns an empty slug when no alphanumeric characters survive', () => {
    expect(promptSkillSlug('???')).toBe('')
  })
})

// ---- Plugin wiring ----

describe('prompts bridging lifecycle', () => {
  let ctx: Context

  beforeEach(async () => {
    vi.clearAllMocks()
    instances.length = 0
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue(listingTools())
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    mockListPrompts.mockResolvedValue(listingPrompts({
      name: 'code_review',
      description: 'Review a source file',
      arguments: [
        { name: 'path', description: 'File to review', required: true },
        { name: 'style' },
      ],
    }))
    mockGetPrompt.mockResolvedValue({
      messages: [
        { role: 'user', content: { type: 'text', text: 'Review the file.' } },
        { role: 'assistant', content: { type: 'text', text: 'Understood.' } },
      ],
    })
    ctx = await mountRegistry()
  })

  it('publishes prompts/list entries as kebab-case skill candidates with argument metadata', async () => {
    await apply(ctx, stdioConfig({ prompts: { enabled: true } }))

    const summary = (await ctx.skills.list()).find(skill => skill.name === 'code-review')
    expect(summary).toBeDefined()
    expect(summary?.description).toBe('Review a source file')
    expect(summary?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(summary?.source).toBe('mcp')
    expect(summary?.provider).toBe('mcp:srv')

    // Lazy load: the raw name rides the wire, never the slug.
    const definition = await ctx.skills.get('code-review')
    expect(definition?.content).toBe([
      'Supply these arguments when applying this skill:',
      '- path (required): File to review',
      '- style (optional)',
      '',
      '[user]',
      'Review the file.',
      '',
      '[assistant]',
      'Understood.',
    ].join('\n'))
    expect(mockGetPrompt).toHaveBeenCalledWith({ name: 'code_review' })
  })

  it('drains paginated prompts/list responses', async () => {
    mockListPrompts.mockReset()
    mockListPrompts.mockResolvedValueOnce({ prompts: [{ name: 'page_one' }], nextCursor: 'cursor-1' })
    mockListPrompts.mockResolvedValueOnce({ prompts: [{ name: 'page_two' }], nextCursor: undefined })

    await apply(ctx, stdioConfig({ prompts: { enabled: true } }))

    const names = await skillNames(ctx)
    expect(names).toContain('page-one')
    expect(names).toContain('page-two')
  })

  it('falls back to a generated description when the server omits one', async () => {
    mockListPrompts.mockResolvedValue(listingPrompts({ name: 'bare_prompt' }))
    await apply(ctx, stdioConfig({ prompts: { enabled: true } }))

    const summary = (await ctx.skills.list()).find(skill => skill.name === 'bare-prompt')
    expect(summary?.description).toBe('MCP prompt provided by server "srv".')
  })

  it('propagates modelInvocable: false into the candidate invocation policy', async () => {
    await apply(ctx, stdioConfig({ prompts: { enabled: true, modelInvocable: false } }))

    const summary = (await ctx.skills.list()).find(skill => skill.name === 'code-review')
    expect(summary?.invocation).toEqual({ modelInvocable: false, userInvocable: true })
  })

  it('reports an unloadable body as undefined when prompts/get fails', async () => {
    mockGetPrompt.mockRejectedValue(new Error('prompt vanished'))
    await apply(ctx, stdioConfig({ prompts: { enabled: true } }))

    await expect(ctx.skills.get('code-review')).resolves.toBeUndefined()
  })

  it('keeps tools alive and recovers on the next notification when a prompt slug collides', async () => {
    const { warns } = captureLogs(ctx)
    mockListPrompts.mockResolvedValue(listingPrompts(
      { name: 'code_review' },
      { name: 'code.review', description: 'Colliding slug' },
    ))
    await apply(ctx, stdioConfig({ prompts: { enabled: true } }))

    // Fetch-phase failure is contained: no candidates serve, the failure is
    // logged, and tools stay registered.
    expect(warns.some(line => line.includes('"code.review" whose skill slug "code-review" collides'))).toBe(true)
    await expect(ctx.skills.list()).resolves.toEqual([])
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()

    mockListPrompts.mockResolvedValue(listingPrompts({ name: 'fixed_only' }))
    const promptsChanged = handlerFor(PromptListChangedNotificationSchema)
    await promptsChanged()
    expect(await skillNames(ctx)).toEqual(['fixed-only'])
  })

  it('re-syncs the catalog when the server notifies a prompt list change', async () => {
    await apply(ctx, stdioConfig({ prompts: { enabled: true } }))
    expect(await skillNames(ctx)).toEqual(['code-review'])

    mockListPrompts.mockResolvedValue(listingPrompts({ name: 'fresh_prompt' }))
    await handlerFor(PromptListChangedNotificationSchema)()

    expect(await skillNames(ctx)).toEqual(['fresh-prompt'])
  })

  it('re-syncs prompts through the reconnect generation that also re-syncs tools', async () => {
    await apply(ctx, stdioConfig({ prompts: { enabled: true } }))
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    expect(instances).toHaveLength(1)

    // The recovered generation advertises a different prompt set; the swap
    // replaces the old candidates without duplicating or leaking them.
    mockListPrompts.mockResolvedValue(listingPrompts({ name: 'revived_prompt' }))
    instances[0]!.onclose?.()

    await vi.waitFor(async () => {
      await expect(skillNames(ctx)).resolves.toEqual(['revived-prompt'])
    })
    expect(instances).toHaveLength(2)
    expect(mockConnect).toHaveBeenCalledTimes(2)

    // A notification from the replaced generation is ignored.
    const callsAfterRecovery = mockListPrompts.mock.calls.length
    await handlerFor(PromptListChangedNotificationSchema)()
    expect(mockListPrompts.mock.calls.length).toBe(callsAfterRecovery)
    await vi.waitFor(async () => {
      await expect(skillNames(ctx)).resolves.toEqual(['revived-prompt'])
    })
  })

  it('empties the catalog when the reconnect budget is exhausted', async () => {
    const { errors } = captureLogs(ctx)
    await apply(ctx, stdioConfig({ prompts: { enabled: true } }))
    await vi.waitFor(async () => {
      await expect(skillNames(ctx)).resolves.toEqual(['code-review'])
    })

    mockConnect.mockRejectedValue(new Error('server gone'))
    instances[0]!.onclose?.()

    await vi.waitFor(() => {
      expect(errors.some(line => line.includes('giving up after 5 consecutive failed reconnect attempts'))).toBe(true)
    })
    await vi.waitFor(async () => {
      await expect(skillNames(ctx)).resolves.toEqual([])
    })
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
  })

  it('leaves prompts unbridged by default', async () => {
    await apply(ctx, stdioConfig())

    expect(mockListPrompts).not.toHaveBeenCalled()
    await expect(ctx.skills.list()).resolves.toEqual([])
    // Only the tool list-changed handler was registered.
    expect(mockSetNotificationHandler).toHaveBeenCalledTimes(1)
  })

  it('fails loud at load when prompts are enabled without a skill registry', async () => {
    const bare = new Context()
    await bare.plugin(SystemPrompt)
    await bare.plugin(ToolRuntime)

    await expect(apply(bare, stdioConfig({ prompts: { enabled: true } })))
      .rejects.toThrow(/prompts\.enabled requires the skill registry/)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('unregisters the provider on disposal', async () => {
    const fiber = ctx.plugin({
      name: 'mcp-prompts-spec',
      inject: ['tools'],
      apply,
    }, stdioConfig({ prompts: { enabled: true } }))
    await vi.waitFor(async () => {
      await expect(skillNames(ctx)).resolves.toEqual(['code-review'])
    })

    await fiber.dispose()

    await expect(ctx.skills.list()).resolves.toEqual([])
  })
})
