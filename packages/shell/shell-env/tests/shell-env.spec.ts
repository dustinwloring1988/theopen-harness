/**
 * Registry tests for `@buckeyestudio/toh-shell-env`: built-in facts, contributor
 * ownership and validation, collection ordering, effect-scoped disposal, and
 * the explicit disposer contract.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@buckeyestudio/cordis'
import { CallId } from '@buckeyestudio/toh-llm'
import type { Agent } from '@buckeyestudio/toh-agent'
import type { ToolExecution } from '@buckeyestudio/toh-tools'
import { ShellEnvRegistry } from '@buckeyestudio/toh-shell-env'
import * as BashEnvPlugin from '@buckeyestudio/toh-shell-env'

const testToolSignal = new AbortController().signal

afterEach(() => vi.unstubAllEnvs())

function execution(sessionId?: string): ToolExecution {
  return {
    signal: testToolSignal,
    token: Symbol('bash-env-test') as ToolExecution['token'],
    callId: CallId('bash-env-call'),
    rootCallId: CallId('bash-env-call'),
    name: 'bash',
    arguments: { command: 'true' },
    ...(sessionId === undefined
      ? {}
      : { agent: { session: { header: { version: 0, id: sessionId, createdAt: 0 } } } as Agent }),
  }
}

describe('ShellEnvRegistry', () => {
  it('collects unconditional shell facts and the current agent session id', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { tohHome: './test-toh-home' })

    expect(registry.collect(execution())).toEqual({
      TOH_HOME: resolve('./test-toh-home'),
      TOH_SHELL: '1',
    })
    expect(registry.collect(execution('session-a'))).toEqual({
      TOH_HOME: resolve('./test-toh-home'),
      TOH_SESSION_ID: 'session-a',
      TOH_SHELL: '1',
    })
  })

  it('resolves TOH_HOME from the ambient override or the user-home default', () => {
    vi.stubEnv('TOH_HOME', './ambient-toh-home')
    const fromEnvironment = new ShellEnvRegistry(new Context())
    expect(fromEnvironment.collect(execution()).TOH_HOME).toBe(resolve('./ambient-toh-home'))

    vi.stubEnv('TOH_HOME', undefined)
    const fromDefault = new ShellEnvRegistry(new Context())
    expect(fromDefault.collect(execution()).TOH_HOME).toBe(join(homedir(), '.toh'))
  })

  it('collects declared contributor variables and omits unavailable values', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { tohHome: './test-toh-home' })
    registry.register({
      name: 'optional-session-fact',
      variables: {
        TOH_SESSION_OPTIONAL: { description: 'Optional session-scoped test fact.' },
      },
      resolve: exec => exec.agent === undefined ? {} : { TOH_SESSION_OPTIONAL: exec.agent.session.header.id },
    })
    registry.register({
      name: 'always-available-fact',
      variables: {
        TOH_ALWAYS_AVAILABLE: { description: 'Always-available test fact.' },
      },
      resolve: () => ({ TOH_ALWAYS_AVAILABLE: 'yes' }),
    })

    expect(registry.collect(execution())).not.toHaveProperty('TOH_SESSION_OPTIONAL')
    expect(registry.collect(execution()).TOH_ALWAYS_AVAILABLE).toBe('yes')
    expect(registry.collect(execution('session-b')).TOH_SESSION_OPTIONAL).toBe('session-b')
    expect(registry.list()).toEqual([
      {
        contributor: 'always-available-fact',
        description: 'Always-available test fact.',
        key: 'TOH_ALWAYS_AVAILABLE',
      },
      {
        contributor: 'optional-session-fact',
        description: 'Optional session-scoped test fact.',
        key: 'TOH_SESSION_OPTIONAL',
      },
    ])
  })

  it('rejects duplicate variable ownership at registration time', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { tohHome: './test-toh-home' })
    registry.register({
      name: 'first',
      variables: { TOH_SHARED: { description: 'First owner.' } },
      resolve: () => ({ TOH_SHARED: 'first' }),
    })

    expect(() => registry.register({
      name: 'second',
      variables: { TOH_SHARED: { description: 'Second owner.' } },
      resolve: () => ({ TOH_SHARED: 'second' }),
    })).toThrow(/TOH_SHARED.*first.*second|TOH_SHARED.*second.*first/)
  })

  it('rejects duplicate contributor names and malformed declarations', () => {
    const registry = new ShellEnvRegistry(new Context(), { tohHome: './test-toh-home' })
    registry.register({
      name: 'declared',
      variables: { TOH_DECLARED: { description: 'Declared fact.' } },
      resolve: () => ({}),
    })

    expect(() => registry.register({
      name: 'declared',
      variables: { TOH_ANOTHER: { description: 'Another fact.' } },
      resolve: () => ({}),
    })).toThrow(/already registered/)
    expect(() => registry.register({
      name: ' ',
      variables: { TOH_BLANK_NAME: { description: 'Blank owner.' } },
      resolve: () => ({}),
    })).toThrow(/name must be non-empty/)
    expect(() => registry.register({
      name: 'invalid-key',
      variables: { toh_invalid: { description: 'Invalid key.' } } as unknown as Record<'TOH_INVALID', { description: string }>,
      resolve: () => ({}),
    })).toThrow(/invalid key/)
    expect(() => registry.register({
      name: 'reserved-key',
      variables: { TOH_HOME: { description: 'Reserved key.' } },
      resolve: () => ({}),
    })).toThrow(/reserved key/)
    expect(() => registry.register({
      name: 'blank-description',
      variables: { TOH_BLANK_DESCRIPTION: { description: ' ' } },
      resolve: () => ({}),
    })).toThrow(/must describe/)
  })

  it('rejects undeclared variables returned by a contributor', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { tohHome: './test-toh-home' })
    registry.register({
      name: 'drifted-provider',
      variables: { TOH_DECLARED: { description: 'Declared fact.' } },
      resolve: () => ({ TOH_UNDECLARED: 'bad' }),
    })

    expect(() => registry.collect(execution())).toThrow(/drifted-provider.*TOH_UNDECLARED/)
  })

  it('rejects non-string values returned by a contributor', () => {
    const registry = new ShellEnvRegistry(new Context(), { tohHome: './test-toh-home' })
    registry.register({
      name: 'wrong-value-type',
      variables: { TOH_STRING: { description: 'String fact.' } },
      resolve: () => ({ TOH_STRING: 42 }) as unknown as Record<'TOH_STRING', string>,
    })

    expect(() => registry.collect(execution())).toThrow(/wrong-value-type.*non-string.*TOH_STRING/)
  })

  it('removes an effect-scoped contributor when its plugin is disposed', async () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { tohHome: './test-toh-home' })
    const fiber = await ctx.plugin({
      inject: ['shellEnv'],
      apply(inner: Context) {
        inner.shellEnv.register({
          name: 'temporary',
          variables: { TOH_TEMPORARY: { description: 'Temporary fact.' } },
          resolve: () => ({ TOH_TEMPORARY: 'present' }),
        })
      },
    })

    expect(registry.collect(execution()).TOH_TEMPORARY).toBe('present')
    await fiber.dispose()
    expect(registry.collect(execution())).not.toHaveProperty('TOH_TEMPORARY')
  })

  it('returns an explicit contributor disposer', () => {
    const registry = new ShellEnvRegistry(new Context(), { tohHome: './test-toh-home' })
    const dispose = registry.register({
      name: 'explicit-disposal',
      variables: { TOH_EXPLICIT_DISPOSAL: { description: 'Explicitly disposed fact.' } },
      resolve: () => ({ TOH_EXPLICIT_DISPOSAL: 'present' }),
    })

    expect(registry.collect(execution()).TOH_EXPLICIT_DISPOSAL).toBe('present')
    dispose()
    expect(registry.collect(execution())).not.toHaveProperty('TOH_EXPLICIT_DISPOSAL')
  })

  it('the plugin registers the service and the persistence contributor on load', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    expect(ctx.shellEnv).toBeInstanceOf(ShellEnvRegistry)
    expect(ctx.shellEnv.list()).toEqual([
      {
        contributor: 'session-persistence',
        description: 'Absolute target path of the current session JSONL when the active persistence backend provides one.',
        key: 'TOH_SESSION_JSONL',
      },
    ])
  })

  it('the persistence contributor resolves TOH_SESSION_JSONL only for a jsonl backend', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    ctx.provide('sessionPersistence', {
      locate: () => ({ kind: 'jsonl' as const, path: 'C:\\sessions\\s.jsonl' }),
    })
    expect(ctx.shellEnv.collect(execution('sess-p')).TOH_SESSION_JSONL).toBe('C:\\sessions\\s.jsonl')
  })

  it('the persistence contributor omits the variable for a non-jsonl backend', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    ctx.provide('sessionPersistence', {
      locate: () => ({ kind: 'sqlite' as const, path: 'C:\\sessions\\s.db' }),
    })
    expect(ctx.shellEnv.collect(execution('sess-p'))).not.toHaveProperty('TOH_SESSION_JSONL')
  })

  it('the persistence contributor omits the variable without a persistence backend', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    expect(ctx.shellEnv.collect(execution('sess-p'))).not.toHaveProperty('TOH_SESSION_JSONL')
  })
})
