import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@buckeyestudio/cordis'
import Include from '@buckeyestudio/cordis-plugin-include'
import Loader from '@buckeyestudio/cordis-plugin-loader'
import type { Agent } from '@buckeyestudio/toh-agent'
import { SessionId } from '@buckeyestudio/toh-session'
import SystemPrompt from '@buckeyestudio/toh-system-prompt'
import ToolRuntime from '@buckeyestudio/toh-tools'
import DynamicCordisRunnerService from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A host half that registers one invoke handler and provides a service. */
const HOST_CODE = `
  harness.handle('double', async (args) => args.value * 2)
  return {
    name: 'doubler',
    apply(ctx) {
      ctx.provide('dynDoubler', { ok: true })
    },
  }
`

describe('cordis-host-runner through a real cordis.yml Loader composition', () => {
  it('runs and removes a host-only package through the public verbs', async () => {
    root = await mkdtemp(join(tmpdir(), 'toh-cordis-host-runner-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@buckeyestudio/toh-system-prompt'",
      "- name: '@buckeyestudio/toh-tools'",
      "- name: '@buckeyestudio/toh-cordis-host-runner'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@buckeyestudio/toh-system-prompt', SystemPrompt],
      ['@buckeyestudio/toh-tools', ToolRuntime],
      ['@buckeyestudio/toh-cordis-host-runner', DynamicCordisRunnerService],
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

    const runner = context.dynamicCordisRunner
    expect(runner).toBeInstanceOf(DynamicCordisRunnerService)

    const events: string[] = []
    context.on('cordis/dynamic-package', () => events.push('package'))
    context.on('cordis/dynamic-retract', () => events.push('retract'))

    const sessionId = SessionId('loader-runner-agent')
    const agent = { id: sessionId, steer() {}, inject() {} } as unknown as Agent
    const receipt = runner.define({
      sessionId,
      plugin: { kind: 'new', idPrefix: 'dyn' },
      name: 'doubler',
      purpose: 'composition fixture',
      code: { host: HOST_CODE },
    })

    const started = await runner.run(agent, receipt.pluginId, receipt.packageId, 'run')
    if (!started.ok) throw new Error(started.message)
    expect(started.status).toBe('running')
    // The host half mounted in this same Loader-built tree, not a parallel one.
    expect(context.get('dynDoubler')).toEqual({ ok: true })
    await expect(runner.invoke(receipt.pluginId, started.pluginRunId, 'double', { value: 21 }))
      .resolves.toEqual({ ok: true, value: 42 })

    await expect(runner.undefine(agent, receipt.pluginId)).resolves.toEqual({ ok: true, wasRunning: true })
    expect(context.get('dynDoubler')).toBeUndefined()
    expect(events).toEqual(['package', 'retract'])
    await expect(runner.run(agent, receipt.pluginId, receipt.packageId, 'run'))
      .resolves.toMatchObject({ ok: false, reason: 'plugin-missing' })
  })
})
