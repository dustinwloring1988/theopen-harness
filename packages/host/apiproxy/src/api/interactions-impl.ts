/**
 * Interaction channel impl: the host-owned question and approval pending
 * registries, the `ctx.userQuestions` provider, the `approval/request`
 * listener, and POST `/api/respond` routing. The two registries share one id
 * space of UUIDs and one broadcast face; extracting them together keeps that
 * pairing in one module.
 */

// Value edge: mints the stable server-request ids both registries answer by.
import { randomUUID } from 'node:crypto'
import type { Context } from '@buckeyestudio/cordis'
import type { CallId } from '@buckeyestudio/toh-llm/brand'
import type { SessionEvent, SessionId } from '@buckeyestudio/toh-session'
import type { ApprovalOutcome, ApprovalRequestId } from '@buckeyestudio/toh-user-approval'
// Side-effect type import: resolves the `approval/request` waterfall and
// `ctx.get('approval')` without a value dependency on the seam (optional composition).
import type {} from '@buckeyestudio/toh-user-approval'
import type {
  AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionRequest,
} from '@buckeyestudio/toh-user-questions'
import { UserQuestionError } from '@buckeyestudio/toh-user-questions'
import { approvalResponsePayloadSchema } from './approvals.schema.ts'
import { questionResponsePayloadSchema } from './questions.schema.ts'
import type {
  ClientResponse, MuxFrame, QuestionResponsePayload, RpcReceipt, RpcRequest,
} from './index.ts'
import { RpcId } from './rpc.ts'
import type { FrameQueue } from './proxy-shared.ts'

/**
 * One outstanding approval question: the stable server-request id, the frame
 * material replayed to late mux subscribers, and the resolver that settles the
 * answerer's promise back into `ctx.approval`.
 */
export interface PendingApproval {
  rpcId: RpcId
  sessionId: SessionId
  approvalId: ApprovalRequestId
  toolName: string
  callId?: CallId
  reason?: string
  resolve(outcome: ApprovalOutcome): void
}

/** One host-owned question wait, addressed by the stable server-request id. */
export interface PendingQuestion {
  rpcId: RpcId
  sessionId: SessionId
  questions: AskUserQuestionItem[]
  resolve: (answer: AskUserQuestionAnswer) => void
  reject: (error: UserQuestionError) => void
  signal?: AbortSignal
  onAbort?: () => void
}

/** Project a pending entry into its answerable mux frame (initial push and mux-open replay share it). */
export function requestedFrame(pending: PendingApproval): RpcRequest<MuxFrame> {
  return {
    rpcId: pending.rpcId,
    payload: {
      type: 'approval/requested',
      sessionId: pending.sessionId,
      approvalId: pending.approvalId,
      toolName: pending.toolName,
      ...pending.callId === undefined ? {} : { callId: pending.callId },
      ...pending.reason === undefined ? {} : { reason: pending.reason },
    },
  }
}

/** Validate one answer batch against the exact question request it resolves. */
function matchesQuestions(payload: QuestionResponsePayload, pending: PendingQuestion): boolean {
  if (payload.sessionId !== pending.sessionId) return false
  const answers = payload.answer.answers
  if (answers.length !== pending.questions.length) return false
  return answers.every((answer, index) => {
    const question = pending.questions[index] as AskUserQuestionItem
    if (answer.id !== question.id) return false
    if (new Set(answer.selected).size !== answer.selected.length) return false
    const custom = answer.custom?.trim()
    if (custom !== undefined && custom === '') return false
    if (question.multiSelect !== true) {
      if (custom !== undefined && answer.selected.length > 0) return false
      if (answer.selected.length > 1) return false
    }
    const labels = new Set(question.options?.map(option => option.label) ?? [])
    return answer.selected.every(label => labels.has(label))
  })
}

/** Closure state and services the interaction channel needs from the gateway assembly. */
export interface InteractionsDeps {
  /** Send one transient frame to every connected mux consumer. */
  broadcast: (payload: MuxFrame) => void
  /** Every open mux subscription; answerable frames push here directly. */
  muxQueues: Set<FrameQueue<RpcRequest<MuxFrame>>>
}

/** The interaction channel's public face over the ApiProxy root. */
export interface InteractionsImpl {
  /** Route one client response into the pending registries. */
  respond: (message: ClientResponse) => Promise<RpcReceipt>
  /** Host-owned question waits, keyed by their stable server-request id. */
  pendingQuestions: Map<RpcId, PendingQuestion>
  /** Outstanding approval asks, keyed by their stable server-request id. */
  pendingApprovals: Map<RpcId, PendingApproval>
}

/**
 * Create the interaction channel over a composed host context: register the
 * user-questions provider, wire the approval waterfall into answerable mux
 * frames, and expose `respond` as the answer route.
 * @param ctx - a context with the Host spine mounted; approvals optional.
 * @param deps - gateway push plumbing shared with the events domain.
 * @returns the respond route plus both pending registries (mux baselines read them).
 */
export function createInteractionsImpl(ctx: Context, deps: InteractionsDeps): InteractionsImpl {
  const { broadcast, muxQueues } = deps
  const pendingQuestions = new Map<RpcId, PendingQuestion>()
  const pendingApprovals = new Map<RpcId, PendingApproval>()

  /** Remove a wait before settling it: synchronous deletion makes the first claimant win. */
  function claimQuestion(pending: PendingQuestion, outcome: 'answered' | 'cancelled'): void {
    pendingQuestions.delete(pending.rpcId)
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
    broadcast({
      type: 'question/resolved', sessionId: pending.sessionId,
      questionRpcId: pending.rpcId, outcome,
    })
  }

  const disposeProvider = ctx.userQuestions.registerProvider({
    ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
      const sessionId = request.agent?.id
      if (sessionId === undefined) {
        return Promise.reject(new UserQuestionError(
          'web user interaction requires an agent-owned session', 'ASK_MISSING_AGENT'))
      }
      return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
        const rpcId = RpcId(randomUUID())
        const pending: PendingQuestion = {
          rpcId, sessionId, questions: request.questions, resolve, reject,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        }
        const onAbort = (): void => {
          claimQuestion(pending, 'cancelled')
          reject(new UserQuestionError(
            'ask_user_question was aborted before the user answered', 'ASK_ABORTED'))
        }
        pending.onAbort = onAbort
        pendingQuestions.set(rpcId, pending)
        request.signal?.addEventListener('abort', onAbort, { once: true })
        const envelope: RpcRequest<MuxFrame> = {
          rpcId,
          payload: { type: 'question/requested', sessionId, questions: request.questions },
        }
        for (const queue of muxQueues) queue.push(envelope)
      })
    },
  })
  ctx.effect(() => () => {
    disposeProvider()
    for (const pending of [...pendingQuestions.values()]) {
      claimQuestion(pending, 'cancelled')
      pending.reject(new UserQuestionError(
        'web user-questions provider was disposed', 'ASK_ABORTED'))
    }
  }, 'api-proxy: user-questions provider')

  // --- Approval pending registry ------------------------------------------
  // The proxy is the approval channel for every agent this host owns: an ask
  // through `ctx.approval` becomes an answerable server-request on the mux
  // stream (stable rpcId), settled by POST /api/respond. The entry survives
  // client disconnects — mux-open replays still-pending requested frames with
  // the same rpcId (the refresh-recovery baseline) — and withdraws on the
  // ask's own abort signal (turn cancel), pushing `cancelled` to subscribers.
  if (ctx.get('approval') !== undefined) {
    // Teardown parity with the question provider above: a gateway disposed
    // while approvals are pending settles every entry as 'cancelled' (the
    // service's fail-closed vocabulary), so no ask promise dangles past the
    // proxy's lifetime and subscribers see the withdrawal.
    ctx.effect(() => () => {
      for (const pending of [...pendingApprovals.values()]) pending.resolve('cancelled')
    }, 'api-proxy: approval registry teardown')
    ctx.on('approval/request', (req, next) => {
      // Dispatch rides a microtask behind the service's own signal check: an
      // abort landing in that window would register the abort listener AFTER
      // the signal fired — never invoked, entry pending forever, zombie frame
      // on every mux replay. Settle synchronously instead of publishing.
      if (req.signal?.aborted === true) return Promise.resolve<ApprovalOutcome>('cancelled')
      // The audit pair `approval/asked` is already appended by the service
      // before dispatch, but dispatch rides a microtask: parallel tool calls
      // can append several asked events before any answerer runs. THIS
      // request's event is therefore the newest asked event that is still
      // undecided, unclaimed by another pending entry, and — when the ask
      // names a call — carries the same callId.
      const events = req.agent.session.events
      const claimed = new Set<ApprovalRequestId>()
      for (const entry of pendingApprovals.values()) claimed.add(entry.approvalId)
      const decided = new Set<ApprovalRequestId>()
      let approvalId: ApprovalRequestId | undefined
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i] as SessionEvent
        if (event.type === 'approval/decided') {
          decided.add(event.data.id)
        } else if (event.type === 'approval/asked') {
          if (decided.has(event.data.id) || claimed.has(event.data.id)) continue
          // Symmetric pairing: a callId-bearing ask only takes its own call's
          // record, and a callId-less ask only takes a callId-less record —
          // so neither shape can steal the other's audit id under parallel
          // asks. (Today every producer — the tool executor — passes callId;
          // the callId-less arm guards any future non-tool asker.)
          if ((req.callId ?? null) !== (event.data.callId ?? null)) continue
          approvalId = event.data.id
          break
        }
      }
      // No asked event means the request bypassed the service's audit path —
      // not this channel's question; delegate to the fail-closed default.
      if (approvalId === undefined) return next()
      const id = approvalId
      return new Promise<ApprovalOutcome>((resolve) => {
        const settle = (outcome: ApprovalOutcome): void => {
          /* v8 ignore next 3 -- defensive double-settle guard: respond() routes
             through the pending table (a settled id is not-pending before it can
             re-settle) and the first settle removes the abort listener, so no
             reachable path settles twice; kept against future settle callers. */
          if (!pendingApprovals.delete(pending.rpcId)) return
          req.signal?.removeEventListener('abort', onAbort)
          broadcast({ type: 'approval/resolved', sessionId: pending.sessionId, approvalId: id, outcome })
          // A cancelled ask was already settled by the service's own signal
          // race, which discards this late resolution; resolving is a no-op
          // there and keeps this promise from dangling forever.
          resolve(outcome)
        }
        const onAbort = (): void => { settle('cancelled') }
        const pending: PendingApproval = {
          rpcId: RpcId(randomUUID()),
          sessionId: req.agent.session.id,
          approvalId: id,
          toolName: req.toolName,
          ...req.callId === undefined ? {} : { callId: req.callId },
          ...req.reason === undefined ? {} : { reason: req.reason },
          resolve: settle,
        }
        pendingApprovals.set(pending.rpcId, pending)
        req.signal?.addEventListener('abort', onAbort, { once: true })
        const envelope = requestedFrame(pending)
        for (const queue of muxQueues) queue.push(envelope)
      })
    })
  }

  function respond(message: ClientResponse): Promise<RpcReceipt> {
    // Route by the echoed rpcId (the wire correlation): approvals first,
    // then questions — the two registries share one id space of UUIDs.
    const approval = pendingApprovals.get(message.rpcId)
    if (approval !== undefined) {
      if (!message.result.ok) return Promise.resolve({ accepted: false, reason: 'bad-response' })
      const parsed = approvalResponsePayloadSchema.safeParse(message.result.value)
      // The payload's audit correlation must match the entry the rpcId routed
      // to — a mismatched answer is malformed, not merely late.
      if (!parsed.success || parsed.data.approvalId !== approval.approvalId || parsed.data.sessionId !== approval.sessionId) {
        return Promise.resolve({ accepted: false, reason: 'bad-response' })
      }
      approval.resolve(parsed.data.outcome)
      return Promise.resolve({ accepted: true })
    }
    const pending = pendingQuestions.get(message.rpcId)
    if (pending === undefined) return Promise.resolve({ accepted: false, reason: 'not-pending' })
    if (!message.result.ok) {
      if (message.result.error.code !== 'cancelled') {
        return Promise.resolve({ accepted: false, reason: 'bad-response' })
      }
      claimQuestion(pending, 'cancelled')
      pending.reject(new UserQuestionError(
        'the user cancelled ask_user_question', 'ASK_CANCELLED'))
      return Promise.resolve({ accepted: true })
    }
    const parsed = questionResponsePayloadSchema.safeParse(message.result.value)
    if (!parsed.success) {
      return Promise.resolve({ accepted: false, reason: 'bad-response' })
    }
    const payload: QuestionResponsePayload = {
      sessionId: parsed.data.sessionId,
      answer: {
        answers: parsed.data.answer.answers.map(answer => ({
          id: answer.id,
          selected: answer.selected,
          ...(answer.custom === undefined ? {} : { custom: answer.custom }),
        })),
      },
    }
    if (!matchesQuestions(payload, pending)) {
      return Promise.resolve({ accepted: false, reason: 'bad-response' })
    }
    claimQuestion(pending, 'answered')
    pending.resolve(payload.answer)
    return Promise.resolve({ accepted: true })
  }

  return { respond, pendingQuestions, pendingApprovals }
}
