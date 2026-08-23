/**
 * Pure notification gate: decides whether one candidate event may raise an OS
 * notification. No DOM, no clocks, no subscriptions — every environmental
 * fact (focus, permission, quiet window) arrives as an argument so the whole
 * file tests headlessly.
 * @module @buckeyestudio/toh-client-ui-notify/client/decide
 */

import type { NotifyMode } from '../notify-settings.ts'

/** The user-relevant events this plugin can announce. */
export type NotifyEventKind = 'turn-completed' | 'approval-required'

/**
 * Permission state the Notification API reports. `'unsupported'` covers both
 * a missing constructor and a thrown constructor probe; the gate treats it as
 * permanently denied without ever attempting a request.
 */
export type NotifyPermissionState = 'granted' | 'denied' | 'default' | 'unsupported'

/** Environmental facts one decision needs. */
export interface NotifyGate {
  /** Durable mode from the settings scope. */
  mode: NotifyMode
  /** Whether the document currently has focus (focused tabs stay silent). */
  focused: boolean
  /** Whether the current time is inside the configured quiet window. */
  quiet: boolean
  /** Current Notification permission state. */
  permission: NotifyPermissionState
  /**
   * Whether this exact event arc already raised a notification (completion
   * arc per session, or the still-open interaction). Deduplication keeps
   * snapshot replays and reconnect baselines from re-notifying.
   */
  duplicate: boolean
}

/**
 * Decide whether one candidate event raises an OS notification.
 *
 * Disabled mode never notifies. A duplicate arc never notifies again until
 * its state clears. Quiet hours suppress everything — including approvals —
 * because the in-page warning dots remain the escalation path there. A
 * focused tab suppresses by default: the user is already looking at the
 * product. Otherwise only an existing grant notifies; `'default'` waits for
 * the separate permission gesture so the browser prompt is never triggered
 * from a decision function.
 * @param gate - the environmental facts for this candidate.
 * @returns whether to raise the OS notification now.
 */
export function shouldNotify(gate: NotifyGate): boolean {
  if (gate.mode === 'off') return false
  if (gate.duplicate) return false
  if (gate.quiet) return false
  if (gate.focused) return false
  return gate.permission === 'granted'
}

/**
 * Decide whether this candidate should trigger the browser's permission
 * request: exactly once per page load, on a real qualifying event while the
 * durable mode is `ask` and no answer exists yet. Never called at load, so a
 * fresh page stays silent until the harness actually has something to say.
 * @param mode - the durable mode.
 * @param permission - the current permission state.
 * @returns whether to call {@link requestPermission} before deciding again.
 */
export function shouldRequestPermission(
  mode: NotifyMode,
  permission: NotifyPermissionState,
): boolean {
  return mode !== 'off' && permission === 'default'
}

/** Minutes since midnight parsed from one "HH:MM" string. */
function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number) as [number, number]
  return h * 60 + m
}

/**
 * Parse one quiet-window bound.
 * @param value - "HH:MM" 24-hour clock time, or '' when unconfigured.
 * @returns minutes since midnight, or undefined when disabled/malformed.
 */
export function parseQuietTime(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? minutesOf(value) : undefined
}

/**
 * Whether `nowMinutes` falls inside the quiet window. An empty or malformed
 * bound disables the window entirely; a window whose start equals its end is
 * likewise disabled (a zero-length window would otherwise be always-quiet).
 * Windows may wrap midnight (`22:00`–`07:00`).
 * @param nowMinutes - minutes since local midnight.
 * @param from - window start ("HH:MM" or '').
 * @param to - window end ("HH:MM" or '').
 * @returns whether notifications are silenced right now.
 */
export function isWithinQuietHours(
  nowMinutes: number,
  from: string | undefined,
  to: string | undefined,
): boolean {
  const start = parseQuietTime(from)
  const end = parseQuietTime(to)
  if (start === undefined || end === undefined || start === end) return false
  if (start < end) return nowMinutes >= start && nowMinutes < end
  return nowMinutes >= start || nowMinutes < end
}
