/**
 * JSON-RPC methods and notifications for out-of-process harness SDKs.
 * The surrounding context owns plugins, persistence, and configured adapters.
 *
 * @module @buckeyestudio/toh-sdk-jsonrpc-server/server
 */

import type { Context } from '@buckeyestudio/cordis'
import { resolve } from 'node:path'
import type { Agent, AgentHandle } from '@buckeyestudio/toh-agent'
import { createUserMessage } from '@buckeyestudio/toh-llm'
import { carrierKeyOf, type Scoped } from '@buckeyestudio/toh-scope'
import { SessionId } from '@buckeyestudio/toh-session'
import type SubagentRuntime from '@buckeyestudio/toh-subagent'
import type { SubagentRunEndInfo } from '@buckeyestudio/toh-subagent'
import * as LlmDeepSeek from '@buckeyestudio/toh-llm-deepseek'
import type {
  InitializeParams,
  InitializeResult,
  JsonRpcTransportPeer,
  SessionEventNotification,
  SessionPromptParams,
  SessionPromptResult,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from '@buckeyestudio/toh-sdk-protocol'

interface SessionRecord {
  handle: AgentHandle
}

/** Recover the delegating parent from the service-owned scoped carrier. */
function subagentParentOf(carrier: Scoped<SubagentRuntime>): Agent {
  return carrierKeyOf(carrier) as Agent
}

/** Deployment-specific status mapping for SDK turn and subagent outcomes. */
export interface HarnessSdkJsonRpcServerOptions {
  /** Report max-token termination as an accepted result instead of an infrastructure error. */
  maxTokensAsSuccess?: boolean
}

function successStatus(reason: string, options: HarnessSdkJsonRpcServerOptions): 'ok' | 'error' {
  if (reason === 'completed') return 'ok'
  return reason === 'max-tokens' && options.maxTokensAsSuccess === true ? 'ok' : 'error'
}

/**
 * SDK server over one booted harness context and transport peer. Construction
 * subscribes to session, agent, and subagent lifecycle events until shutdown.
 * Repeated initialize calls queue in arrival order and replace the previously
 * server-mounted adapter; switching to another registered provider disposes
 * that adapter instead of mounting. Initialize during or after shutdown is
 * refused, and shutdown waits for handshakes accepted before it began.
 */
export class HarnessSdkJsonRpcServer {
  private cwd = process.cwd()
  private provider = 'deepseek-official'
  private model = 'deepseek-official'
  private maxTokens: number | undefined
  private llmFiber: { dispose(): Promise<void> } | undefined
  private llmFiberProvider: string | undefined
  private pendingLlmDisposal: Promise<void> | undefined
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionCreations = new Map<string, Promise<SessionRecord>>()
  private readonly disposers: (() => void)[] = []
  private initializeTail: Promise<void> | undefined
  private shutdownTask: Promise<Record<string, never>> | undefined
  private shuttingDown = false

  constructor(
    private readonly ctx: Context,
    private readonly transport: JsonRpcTransportPeer,
    private readonly options: HarnessSdkJsonRpcServerOptions = {},
  ) {
    const serverOptions = this.options
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const payload: SessionEventNotification = { sessionId: String(session.id), event }
      this.transport.notify('session.event', payload)
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      this.transport.notify('session.status', { sessionId: String(agent.session.id), status })
    }))
    this.disposers.push(ctx.on('session/created', (session) => {
      const parentSession = session.header.parentSession
      if (parentSession === undefined) return
      const payload: SubagentStartedNotification = {
        parentSessionId: String(parentSession),
        childSessionId: String(session.id),
      }
      this.transport.notify('subagent.started', payload)
    }))
    this.disposers.push(ctx.on('subagent/end', function (this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo) {
      const parent = subagentParentOf(this)
      // This protocol reports only in-process child sessions. The service
      // snapshots the provider name and local flag through child disposal;
      // matching ids or parent lineage alone never establishes locality.
      if (!info.local) return
      const payload: SubagentFinishedNotification = {
        provider: info.provider,
        agentId: String(info.id),
        parentSessionId: String(parent.session.id),
        childSessionId: String(info.id),
        status: successStatus(info.stopReason, serverOptions),
        stopReason: info.stopReason,
        ...(info.lastAssistantMessage === undefined ? {} : { lastAssistantMessage: info.lastAssistantMessage }),
      }
      transport.notify('subagent.finished', payload)
    }))
  }

  /**
   * Configure the SDK route, replacing any previously server-mounted adapter;
   * selecting another registered provider disposes that adapter without a
   * replacement mount. Concurrent calls queue in arrival order; a call that
   * overlaps shutdown is rejected and disposes the adapter it mounted, if any.
   * @param params - SDK handshake parameters.
   * @returns server identity for the handshake.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    const previous = this.initializeTail ?? Promise.resolve()
    const task = previous.then(() => this.performInitialize(params))
    this.initializeTail = task.then(() => undefined, () => undefined)
    return task
  }

  private async performInitialize(params: InitializeParams): Promise<InitializeResult> {
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    if (params.maxTokens !== undefined
      && (!Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0)) {
      throw new TypeError('initialize maxTokens must be a positive safe integer')
    }
    this.cwd = resolve(params.cwd)
    this.provider = params.provider
    this.model = params.model
    this.maxTokens = params.maxTokens
    if (!this.hasAdapterFor(this.provider)) {
      if (this.provider !== 'deepseek-official') throw new Error(`no adapter registered for provider "${this.provider}"`)
      await this.disposeServerMountedFiber()
      const mounted = await this.ctx.plugin(LlmDeepSeek, {})
      // A shutdown that started mid-mount sweeps only after this handshake
      // settles, so disposing the unstored mount here keeps its cleanup inside
      // the awaited initialization tail instead of racing the teardown sweep.
      if (this.shutdownStarted()) {
        await mounted.dispose()
        throw new Error('SDK server is shutting down')
      }
      this.llmFiber = mounted
      this.llmFiberProvider = this.provider
    } else if (this.llmFiber !== undefined && this.llmFiberProvider !== this.provider) {
      // The selected provider owns its adapter, so the server-mounted fallback
      // for the previous provider is obsolete even though no replacement mounts.
      await this.disposeServerMountedFiber()
    }
    return { serverInfo: { name: 'theopen-harness-sdk-runtime', version: '0.0.1' } }
  }

  /**
   * Dispose the current server-mounted adapter once, tracking the attempt so a
   * concurrent shutdown awaits it instead of issuing a second disposal.
   * Success releases ownership; failure leaves the fiber in {@linkcode llmFiber}
   * for shutdown to retry and report while the rejection propagates to the
   * initialize caller.
   */
  private async disposeServerMountedFiber(): Promise<void> {
    const superseded = this.llmFiber
    if (superseded === undefined) return
    const disposal = Promise.resolve().then(() => superseded.dispose())
    this.pendingLlmDisposal = disposal.then(() => undefined, () => undefined)
    await disposal
    if (this.llmFiber === superseded) {
      this.llmFiber = undefined
      this.llmFiberProvider = undefined
    }
  }

  /** Read after any await: concurrent shutdown flips the flag across suspension points. */
  private shutdownStarted(): boolean {
    return this.shuttingDown
  }

  /**
   * Queue one identified prompt without assigning later activity to it.
   * @param params - target session and user content.
   * @returns the durable message identity.
   */
  async prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    const rec = await this.getOrCreateSession(params.sessionId)
    // An agent-loop-only reload disposes the loop's agents while this record
    // survives; a retained agent accepts followup() silently, so validate the
    // record against the live registry before delivery (as the ACP bridge does).
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the server: ${params.sessionId}`)
    }
    const message = createUserMessage({ content: params.contentBlocks, source: { kind: 'user' } })
    rec.handle.agent.followup(message)
    return { messageId: message.id }
  }

  /**
   * Dispose server-owned agents, adapter, and subscriptions to quiescence.
   * Handshakes accepted before shutdown entry settle first. The surrounding
   * context remains running.
   * @returns empty JSON-RPC result.
   */
  shutdown(): Promise<Record<string, never>> {
    this.shutdownTask ??= this.performShutdown()
    return this.shutdownTask
  }

  private async performShutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true
    // Handshakes accepted before shutdown entry finish first: each mount
    // either lands in llmFiber for the sweep below or disposes itself, and a
    // superseded disposal settles before the teardown snapshot is taken. The
    // tail never rejects; its per-call errors already reached their callers.
    const initializationTail = this.initializeTail
    if (initializationTail !== undefined) await initializationTail
    const pendingDisposal = this.pendingLlmDisposal
    if (pendingDisposal !== undefined) await pendingDisposal
    this.pendingLlmDisposal = undefined
    const pendingCreations = [...this.sessionCreations.values()]
    await Promise.allSettled(pendingCreations)
    this.sessionCreations.clear()
    const records = [...this.sessions.values()]
    this.sessions.clear()
    const failures: unknown[] = []
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.()
      } catch (error) {
        failures.push(error)
      }
    }
    const teardownResults = await Promise.allSettled([
      ...records.map(rec => Promise.resolve().then(() => rec.handle.dispose())),
      ...(this.llmFiber === undefined ? [] : [Promise.resolve().then(() => this.llmFiber?.dispose())]),
    ])
    this.llmFiber = undefined
    this.llmFiberProvider = undefined
    failures.push(...teardownResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'SDK server teardown failed')
    return {}
  }

  /**
   * Dispatch one incoming JSON-RPC request to its typed handler. Throws (→ a
   * JSON-RPC error response) on an unknown method.
   * @param method - the JSON-RPC method name.
   * @param params - the raw params object from the wire.
   * @returns the handler's result, to be serialized as the response.
   */
  async handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params as unknown as InitializeParams)
      case 'session/prompt':
        return this.prompt(params as unknown as SessionPromptParams)
      case 'shutdown':
        return this.shutdown()
      default:
        throw new Error(`unknown TheOpen Harness SDK runtime method: ${method}`)
    }
  }

  private async getOrCreateSession(sessionId: string): Promise<SessionRecord> {
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const pending = this.sessionCreations.get(sessionId)
    if (pending) return pending
    const creation = this.createSession(sessionId)
    this.sessionCreations.set(sessionId, creation)
    void creation.then(
      () => { this.sessionCreations.delete(sessionId) },
      () => { this.sessionCreations.delete(sessionId) },
    )
    return creation
  }

  private async createSession(sessionId: string): Promise<SessionRecord> {
    // No preset composition: this server's compositions keep the model-facing
    // rows in the host plane, so this agent reads them from the global layer. A
    // deployment that configures a roster has to join one here first
    // (@buckeyestudio/toh-agent-presets README, "Composing a child agent").
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd: this.cwd },
      agentOptions: {
        provider: this.provider,
        model: this.model,
        ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
      },
    })
    const rec: SessionRecord = { handle }
    this.sessions.set(sessionId, rec)
    return rec
  }

  private hasAdapterFor(provider: string): boolean {
    return this.ctx.get('llm')?.listProviders().some(entry => entry.id === provider) ?? false
  }
}
