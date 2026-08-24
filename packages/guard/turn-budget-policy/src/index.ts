/**
 * Turn-budget policy guard: bounds how long a single agent turn may run. A
 * serial `agent/turn-stopping` listener folds the session log for the open
 * turn's step count and summed request usage; past the soft limit it steers
 * exactly one wrap-up request, past a hard limit it cancels the turn.
 * Configuration and chain semantics live in the package README; rationale
 * lives in the turn-budget-policy Agent Note.
 * @module @buckeyestudio/toh-turn-budget-policy
 */

import type { Context } from '@buckeyestudio/cordis'
import z from '@buckeyestudio/schemastery'
import type { Agent, PreStepDecision } from '@buckeyestudio/toh-agent'
import { createUserMessage } from '@buckeyestudio/toh-llm'
import type { TokenUsage, UserMessage } from '@buckeyestudio/toh-llm'
import type { SessionEvent } from '@buckeyestudio/toh-session'

export const name = 'turn-budget-policy'

/**
 * Plugin config, re-checked by the load-time validation in `apply`
 * (misconfiguration fails loud). Every limit is opt-in: omitting all three
 * throws at plugin load, never a silent unbounded policy.
 */
export interface Config {
  /**
   * Step count that hard-cancels the turn. A turn reaching this many logged
   * `step/start` records at its stop boundary is cancelled with a `hook`
   * cause and `keepInbox`.
   */
  maxStepsPerTurn?: number
  /**
   * Per-turn token spend that hard-cancels the turn, measured as the sum of
   * every request's reported usage across the open turn's logged
   * `assistant/message` records. Requests whose adapter reported no usage
   * contribute nothing to the sum.
   */
  maxTurnTokens?: number
  /**
   * Step count that delivers one advisory wrap-up steer. Must stay strictly
   * below `maxStepsPerTurn` when both are set, so the model's single bounded
   * chance to land the turn precedes the hard cancel.
   */
  warnAtSteps?: number
}

export const Config: z<Config> = z.object({
  maxStepsPerTurn: z.number(),
  maxTurnTokens: z.number(),
  warnAtSteps: z.number(),
})

/** Validate one optional positive-integer limit, returning it normalized to `undefined` when absent. */
function validateLimit(field: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`turn-budget-policy: invalid ${field} ${value} — must be an integer >= 1`)
  }
  return value
}

/**
 * The soft-limit wrap-up instruction. Keyed to the observed step count so the
 * model sees how long its turn has already run.
 */
function wrapUpNotice(steps: number): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: `Turn budget advisory: this turn has already run ${steps} steps. `
        + 'Wrap the turn up now: give your best available answer instead of '
        + 'starting more tool calls. If the task genuinely cannot progress '
        + 'without more work, say what is blocking it and stop.',
    }],
    source: {
      kind: 'plugin',
      plugin: 'turn-budget-policy',
      form: 'notice',
      summary: `turn budget: ${steps} steps`,
    },
  })
}

/** Count `step/start` records after the most recent `turn/start` record. */
function stepsThisTurn(events: readonly SessionEvent[]): number {
  let steps = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- contiguous log indices are in bounds by construction
    const event = events[index]!
    if (event.type === 'turn/start') break
    if (event.type === 'step/start') steps += 1
  }
  return steps
}

/** Sum one usage record's disjoint provider buckets; reasoning output stays inside `outputTokens`. */
function usageTokens(usage: TokenUsage): number {
  return usage.inputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
    + usage.outputTokens
}

/**
 * Sum every request's reported usage after the most recent `turn/start`
 * record, so repeated requests each contribute their full input and output
 * cost instead of a shared-surface delta.
 */
function tokensThisTurn(events: readonly SessionEvent[]): number {
  let tokens = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- contiguous log indices are in bounds by construction
    const event = events[index]!
    if (event.type === 'turn/start') break
    if (event.type === 'assistant/message' && event.data.usage !== undefined) tokens += usageTokens(event.data.usage)
  }
  return tokens
}

/** One agent's live-turn accounting: tracked turn id and the turn last steered. */
interface TurnState {
  turn: number
  steeredTurn: number
}

/**
 * Install the guard's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; limits are re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  const maxStepsPerTurn = validateLimit('maxStepsPerTurn', config.maxStepsPerTurn)
  const maxTurnTokens = validateLimit('maxTurnTokens', config.maxTurnTokens)
  const warnAtSteps = validateLimit('warnAtSteps', config.warnAtSteps)
  if (maxStepsPerTurn === undefined && maxTurnTokens === undefined && warnAtSteps === undefined) {
    throw new Error(
      'turn-budget-policy: configure at least one of `maxStepsPerTurn`, `maxTurnTokens`, or `warnAtSteps`',
    )
  }
  if (warnAtSteps !== undefined && maxStepsPerTurn !== undefined && warnAtSteps >= maxStepsPerTurn) {
    throw new Error(
      `turn-budget-policy: invalid warnAtSteps ${warnAtSteps} — must stay below maxStepsPerTurn ${maxStepsPerTurn}`
        + ' so the advisory precedes the cancel',
    )
  }

  const states = new WeakMap<Agent, TurnState>()

  // Turn-boundary bookkeeping: the first pre-step of a turn registers the
  // tracked turn and resets the once-per-turn steer latch. Pure delegate:
  // never rewrites the decision.
  ctx.on('agent/pre-step', ({ agent, turn }, next): Promise<PreStepDecision> => {
    const state = states.get(agent)
    if (state === undefined || state.turn !== turn) {
      states.set(agent, { turn, steeredTurn: 0 })
    }
    return next()
  })

  // Serial enforcement at the stop boundary: data decides before the turn
  // closes. Hard limits cancel (the machine aborts the turn instead of
  // closing it); the soft limit steers at most once per turn, which makes the
  // machine observe pending input and run another step.
  ctx.on('agent/turn-stopping', ({ agent, turn }): void => {
    const state = states.get(agent)
    /* v8 ignore next -- every dispatched stop boundary follows this turn's pre-step registration */
    if (state === undefined || state.turn !== turn) return
    const steps = stepsThisTurn(agent.session.events)
    if (maxStepsPerTurn !== undefined && steps >= maxStepsPerTurn) {
      agent.cancel(
        { kind: 'hook', reason: `turn budget exceeded: ${steps} steps reached maxStepsPerTurn ${maxStepsPerTurn}` },
        { keepInbox: true },
      )
      return
    }
    if (maxTurnTokens !== undefined) {
      const spent = tokensThisTurn(agent.session.events)
      if (spent >= maxTurnTokens) {
        agent.cancel(
          { kind: 'hook', reason: `turn budget exceeded: ${spent} tokens reached maxTurnTokens ${maxTurnTokens}` },
          { keepInbox: true },
        )
        return
      }
    }
    if (warnAtSteps !== undefined && steps >= warnAtSteps && state.steeredTurn !== turn) {
      state.steeredTurn = turn
      agent.steer(wrapUpNotice(steps))
    }
  })
}
