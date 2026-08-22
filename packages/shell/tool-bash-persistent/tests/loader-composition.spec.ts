import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@buckeyestudio/cordis'
import Loader from '@buckeyestudio/cordis-plugin-loader'
import Include from '@buckeyestudio/cordis-plugin-include'
import { CallId } from '@buckeyestudio/toh-llm'
import { Session, SessionId } from '@buckeyestudio/toh-session'
import AgentRegistry, { Inbox } from '@buckeyestudio/toh-agent'
import type { Agent } from '@buckeyestudio/toh-agent'
import TerminalSessionService from '@buckeyestudio/toh-terminal'
import * as TerminalLocal from '@buckeyestudio/toh-terminal-bash'
import SandboxProvider from '@buckeyestudio/toh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@buckeyestudio/toh-sandbox'
import SandboxPolicyService from '@buckeyestudio/toh-sandbox-policy'
import LocalSubprocessRuntime from '@buckeyestudio/toh-subprocess-local'
import SystemPrompt from '@buckeyestudio/toh-system-prompt'
import ToolRuntime from '@buckeyestudio/toh-tools'
import * as ToolBashPersistent from '@buckeyestudio/toh-tool-bash-persistent'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

class PassthroughSandbox extends SandboxProvider {
  confine(argv: readonly string[], _policy: SandboxPolicy): ConfinedArgv {
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

function agent(ctx: Context, cwd: string): Agent {
  const id = SessionId('persistent-bash-loader-agent')
  const scope = ctx.plugin(() => {})
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd })
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

const suite = process.platform === 'linux' || process.platform === 'darwin' ? describe : describe.skip

suite('persistent Bash through a real cordis.yml Loader composition', () => {
  it('preserves cwd and environment across calls', async () => {
    root = await mkdtemp(join(tmpdir(), 'toh-persistent-bash-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@buckeyestudio/toh-agent'",
      "- name: '@buckeyestudio/toh-system-prompt'",
      "- name: '@buckeyestudio/toh-tools'",
      "- name: '@buckeyestudio/toh-terminal'",
      "- name: '@buckeyestudio/toh-test-sandbox'",
      "- name: '@buckeyestudio/toh-sandbox-policy'",
      '  config:',
      '    mode: danger-full-access',
      `    workspaceRoot: ${JSON.stringify(root)}`,
      "- name: '@buckeyestudio/toh-subprocess-local'",
      "- name: '@buckeyestudio/toh-terminal-bash'",
      '  config:',
      '    pollIntervalMs: 10',
      '    exactProbeAfterMs: 20',
      // The silence tier is pushed beyond the send bound, so no send below can
      // settle as inferred_idle: every case proves the controlled-prompt fast
      // path that the production defaults (3.5s silence) would otherwise mask.
      '    idleSilenceMs: 30000',
      '    handoffGraceMs: 100',
      '    scrollbackLines: 20000',
      '    timeoutMs: 2000',
      '    disposeGraceMs: 500',
      "- name: '@buckeyestudio/toh-tool-bash-persistent'",
      '  config:',
      '    timeoutMs: 5000',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@buckeyestudio/toh-agent', AgentRegistry],
      ['@buckeyestudio/toh-system-prompt', SystemPrompt],
      ['@buckeyestudio/toh-tools', ToolRuntime],
      ['@buckeyestudio/toh-terminal', TerminalSessionService],
      ['@buckeyestudio/toh-test-sandbox', PassthroughSandbox],
      ['@buckeyestudio/toh-sandbox-policy', SandboxPolicyService],
      ['@buckeyestudio/toh-subprocess-local', LocalSubprocessRuntime],
      ['@buckeyestudio/toh-terminal-bash', TerminalLocal],
      ['@buckeyestudio/toh-tool-bash-persistent', ToolBashPersistent],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const owner = agent(context, root)
    const signal = new AbortController().signal
    const execute = (id: string, command: string) => context!.tools.execute({
      signal,
      callId: CallId(id),
      name: 'bash',
      arguments: { command },
      agent: owner,
    })

    expect(context.tools.schemas().map(schema => schema.name)).toEqual(['bash'])
    await execute('state', 'export KEEP=loader; mkdir -p nested; cd nested')
    const observed = text(await execute('observe', 'printf "cwd=%s keep=%s\\n" "$PWD" "$KEEP"'))
    expect(observed).toContain(`cwd=${join(root, 'nested')} keep=loader`)
    expect(observed).not.toContain('TOH_PERSISTENT_BASH')

    const multiline = text(await execute(
      'multiline',
      'value="line one"\nprintf "%s:%s\\n" "$value" "it\'s fine"',
    ))
    expect(multiline).toBe("line one:it's fine")
    expect(multiline).not.toContain('TOH_PERSISTENT_BASH')

    const heredoc = text(await execute(
      'heredoc',
      "cat <<'EOF'\nalpha\nbeta\nEOF",
    ))
    expect(heredoc).toBe('alpha\nbeta')

    const large = text(await execute('large-output', 'seq 1 12050'))
    expect(large.startsWith('1\n2\n3\n')).toBe(true)
    expect(large).toContain('<response clipped>')
    expect(large).not.toContain('beginning of this command output was dropped')

    // `exec` replaces the wrapper before its end marker prints; the seam's
    // stdin_read readiness is what returns the replacement shell's prompt
    // instead of spinning until the tool deadline.
    const execed = text(await execute('exec-replacement', 'exec bash --noprofile --norc -i'))
    expect(execed).toBe('toh> ')

    const exited = text(await execute('exit', 'exit'))
    expect(exited).toContain('next bash call starts from the workspace')
    expect(text(await execute('after-exit', 'printf "%s\\n" "$PWD"'))).toBe(root)
  }, 20_000)
})
