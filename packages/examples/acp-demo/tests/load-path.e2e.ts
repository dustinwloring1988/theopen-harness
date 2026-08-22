import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  client as makeClientApp, type ClientConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'

/**
 * Source-path Loader smoke through the package's own bin, covering the
 * automation server's initialize and fresh-session path across the
 * `unwrapExports` shape implicated by postmortem 0001. Session creation reaches
 * the factory but not the model, so a dummy key is sufficient.
 */

const binScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
// Repo root is four levels up from packages/examples/acp-demo/tests.
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

// A minimal opt-in leaf that loads this app + the two backends and the optional
// session-query consumer/policies, inlined so the package test owns its fixture.
const FLASH = process.env.DEEPSEEK_E2E_MODEL_FLASH ?? 'deepseek-v4-flash'

const CORDIS_YML = `
- id: llm-deepseek
  name: '@buckeyestudio/toh-llm-deepseek'
- id: subprocess
  name: '@buckeyestudio/toh-subprocess-local'
- id: bash
  name: '@buckeyestudio/toh-bash-local'
- id: acp-agent
  name: '@buckeyestudio/toh-acp-demo'
  config:
    provider: deepseek-official
    model: ${FLASH}
    persona: 'You are a test agent.'
    workspaceContext: false
- id: tool-session-query
  name: '@buckeyestudio/toh-tool-session-query'
- id: timeout-policy
  name: '@buckeyestudio/toh-tool-call-timeout-policy'
- id: spill-local
  name: '@buckeyestudio/toh-spill-local'
- id: spill-policy
  name: '@buckeyestudio/toh-spill-policy'
  config:
    maxInlineBytes: 50000
`

interface Spawned {
  child: ChildProcessWithoutNullStreams
  client: ClientConnection
  stderr: string[]
}

let spawned: Spawned | undefined
let workdir: string | undefined

afterEach(async () => {
  if (spawned !== undefined) {
    spawned.child.kill('SIGKILL')
    spawned = undefined
  }
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

async function boot(): Promise<Spawned & { cwd: string }> {
  workdir = await mkdtemp(join(tmpdir(), 'acp-agent-pkg-'))
  const cwd = workdir
  const configPath = join(cwd, 'cordis.yml')
  await writeFile(configPath, CORDIS_YML)
  const child = spawn(
    process.execPath,
    ['--import', tsxLoader, binScript, '--config', configPath],
    {
      cwd,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: repoTsconfig,
        // Key-present check only; no prompt is sent, so the model is never called.
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'keyless-acp-agent-smoke',
        TOH_HOME: join(cwd, '.toh'),
        TOH_AGENTS_HOME: join(cwd, '.agents'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const stderr: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => stderr.push(chunk))
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  )
  const client = makeClientApp({ name: 'toh-acp-demo-load-path' })
    .onNotification('session/update', () => Promise.resolve())
    .onRequest('session/request_permission', () => Promise.resolve({ outcome: { outcome: 'cancelled' } }))
    .connect(stream)
  spawned = { child, client, stderr }
  return { ...spawned, cwd }
}

describe('toh-acp-demo real-load-path smoke (bin + Loader, keyless)', () => {
  it('boots via its bin and exposes only fresh text sessions', async () => {
    const { client, cwd, stderr } = await boot()
    // initialize: a broken export shape (collapsed bridge plugin, dropped inject)
    // crashes the tree on the first service read here — see postmortem 0001.
    const init = await client.agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    expect(init.agentCapabilities).toEqual({
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
    })

    // session/new reaches the agent FACTORY (create) without the model.
    const { sessionId } = await client.agent.request('session/new', { cwd, mcpServers: [] })
    expect(sessionId).toBeTruthy()

    expect(stderr.join('')).not.toContain('without inject')
  }, 30_000)
})
