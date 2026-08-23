// Real-composition coverage required by packages/AGENTS.md: the prompts bridge
// boots through the real Loader from test-only cordis.yml (Schemastery Config
// normalization, named-export plugin contract, effect-scoped registration),
// with only the external MCP boundary mocked. Asserts the model-visible skill
// catalog entry, the loaded body, and provider removal on disposal.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@buckeyestudio/cordis'
import Loader from '@buckeyestudio/cordis-plugin-loader'
import Include from '@buckeyestudio/cordis-plugin-include'
import SystemPrompt from '@buckeyestudio/toh-system-prompt'
import ToolRuntime from '@buckeyestudio/toh-tools'
import SkillRegistry from '@buckeyestudio/toh-skill'
import * as mcpClient from '@buckeyestudio/toh-mcp-client'

// ---- Mock MCP SDK (the only external boundary) ----

const {
  mockConnect,
  mockClose,
  mockListTools,
  mockListPrompts,
  mockGetPrompt,
  MockClient,
} = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockListPrompts = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockGetPrompt = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockRequest = vi.fn(async (
    request: { method: string; params?: Record<string, unknown> },
    _schema: unknown,
    options?: unknown,
  ): Promise<unknown> => {
    void options
    if (request.method === 'tools/list') return await mockListTools(request.params)
    if (request.method === 'prompts/list') return await mockListPrompts(request.params)
    if (request.method === 'prompts/get') return await mockGetPrompt(request.params)
    throw new Error(`unexpected MCP request: ${request.method}`)
  })
  class MockClient {
    onclose: (() => void) | undefined
    connect = mockConnect
    close = mockClose
    request = mockRequest
    setNotificationHandler = vi.fn()
  }
  return { mockConnect, mockClose, mockListTools, mockListPrompts, mockGetPrompt, MockClient }
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

// ---- Composition harness ----

let root: string | undefined
let context: Context | undefined

beforeEach(() => {
  mockConnect.mockResolvedValue(undefined)
  mockClose.mockImplementation(function (this: { onclose?: () => void }) {
    this.onclose?.()
    return Promise.resolve()
  })
  mockListTools.mockResolvedValue({
    tools: [{ name: 'remote', inputSchema: { type: 'object' } }],
    nextCursor: undefined,
  })
  mockListPrompts.mockResolvedValue({
    prompts: [{
      name: 'review_pull_request',
      description: 'Review the open pull request',
    }],
    nextCursor: undefined,
  })
  mockGetPrompt.mockResolvedValue({
    messages: [
      { role: 'user', content: { type: 'text', text: 'Summarize the diff.' } },
      { role: 'assistant', content: { type: 'text', text: 'I will summarize the diff.' } },
    ],
  })
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot one cordis.yml carrying an opt-in prompts-enabled mcp-client instance. */
async function bootComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'toh-mcp-prompts-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@buckeyestudio/toh-system-prompt'",
    "- name: '@buckeyestudio/toh-tools'",
    "- name: '@buckeyestudio/toh-skill'",
    "- name: '@buckeyestudio/toh-mcp-client'",
    '  config:',
    '    transport: stdio',
    '    serverName: composed',
    '    command: echo',
    '    args: []',
    '    env: {}',
    "    cwd: ''",
    '    failOnStartupError: false',
    '    reconnect:',
    '      enabled: true',
    '      initialDelayMs: 5',
    '      maxDelayMs: 40',
    '      maxAttempts: 5',
    '    prompts:',
    '      enabled: true',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@buckeyestudio/toh-system-prompt', SystemPrompt],
    ['@buckeyestudio/toh-tools', ToolRuntime],
    ['@buckeyestudio/toh-skill', SkillRegistry],
    ['@buckeyestudio/toh-mcp-client', mcpClient],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('mcp-client prompts bridge real Loader composition through cordis.yml', () => {
  it('publishes the server prompt into the model-visible skill catalog and loads its body', async () => {
    const ctx = await bootComposition()

    const summary = (await ctx.skills.list()).find(skill => skill.name === 'review-pull-request')
    expect(summary).toBeDefined()
    expect(summary?.description).toBe('Review the open pull request')
    expect(summary?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(summary?.source).toBe('mcp')
    expect(summary?.provider).toBe('mcp:composed')

    // Model-visible body pinned verbatim; the raw name rides the wire.
    const definition = await ctx.skills.get('review-pull-request')
    expect(definition?.content).toBe([
      '[user]',
      'Summarize the diff.',
      '',
      '[assistant]',
      'I will summarize the diff.',
    ].join('\n'))
    expect(mockGetPrompt).toHaveBeenCalledWith({ name: 'review_pull_request' })

    // Registry contributions prove disposal through the composed fiber: the
    // supervised connection closes with it (the unit suite owns the
    // registry-level unregister assertions).
    await ctx.fiber.dispose()
    context = undefined
    expect(mockClose).toHaveBeenCalled()
  }, 30_000)
})
