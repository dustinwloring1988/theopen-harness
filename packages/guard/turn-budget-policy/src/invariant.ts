/**
 * Package-owned invariant companion for `@buckeyestudio/toh-turn-budget-policy`:
 * the durable log must show wrap-up notices preceding the cancels they warn
 * about — one notice per turn, always inside that turn's span.
 * @module @buckeyestudio/toh-turn-budget-policy/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@buckeyestudio/cordis'
import type { InvariantFailure, InvariantInstaller } from '@buckeyestudio/toh-invariants'
import type { MessageSource, UserMessage } from '@buckeyestudio/toh-llm'
import type { Session, SessionEvent } from '@buckeyestudio/toh-session'

const PACKAGE_NAME = '@buckeyestudio/toh-turn-budget-policy'

/** Cordis companion plugin name. */
export const name = 'turn-budget-policy-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Whether one message source is this policy's wrap-up notice. */
function isWrapUpNotice(source: MessageSource): boolean {
  return source.kind === 'plugin' && source.plugin === 'turn-budget-policy'
}

/** The still-open turn at the end of `events`, or `undefined` when the tail is closed. */
function openTurn(events: readonly SessionEvent[]): { readonly turn: number; readonly startIndex: number } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- contiguous log indices are in bounds by construction
    const event = events[index]!
    if (event.type === 'turn/end') return undefined
    if (event.type === 'turn/start') return { turn: event.data.turn, startIndex: index }
  }
  return undefined
}

/** This policy's wrap-up notices inside one open turn's span. */
function noticesIn(events: readonly SessionEvent[], open: { readonly startIndex: number }): UserMessage[] {
  const notices: UserMessage[] = []
  for (let index = open.startIndex + 1; index < events.length; index += 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- contiguous log indices are in bounds by construction
    const event = events[index]!
    if (event.type === 'user/message' && isWrapUpNotice(event.data.source)) notices.push(event.data)
  }
  return notices
}

/**
 * Validate one candidate event against its durable prefix: a wrap-up notice
 * must land inside an open turn and at most once per turn, so any later
 * hook-cancel of that turn is preceded by the advisory it follows. The
 * closing event itself needs no separate check — the ordering is inherent in
 * the span scan above.
 */
function validateEvent(
  prior: readonly SessionEvent[],
  event: SessionEvent,
  fail: InvariantFailure,
): void {
  if (event.type !== 'user/message') return
  if (!isWrapUpNotice(event.data.source)) return
  const open = openTurn(prior)
  if (open === undefined) {
    return fail('wrap-up notice recorded outside an open turn')
  }
  if (noticesIn(prior, open).length > 0) {
    return fail(`turn ${open.turn} already carries a wrap-up notice; the policy steers at most once per turn`)
  }
}

/** Check existing sessions and every candidate event before Session publishes it. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    const prior: SessionEvent[] = []
    for (const event of session.events) {
      validateEvent(prior, event, fail)
      prior.push(event)
    }
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    validateEvent(session.events, event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
