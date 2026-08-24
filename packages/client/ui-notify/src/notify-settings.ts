/** Turn-notification preferences stored in the Host user-settings document. */

import z from '@buckeyestudio/schemastery'

/** Settings namespace owned by the notify plugin. */
export const NOTIFY_SETTINGS_NAMESPACE = 'ui-notify'

/** Field carrying the notification mode. */
export const NOTIFY_MODE_FIELD = 'mode'

/** Quiet-window start field ("HH:MM", 24-hour; '' disables the window). */
export const QUIET_FROM_FIELD = 'quietFrom'

/** Quiet-window end field ("HH:MM", 24-hour; '' disables the window). */
export const QUIET_TO_FIELD = 'quietTo'

/** Notification modes accepted at settings and decision boundaries. */
export const NOTIFY_MODES = ['ask', 'on', 'off'] as const

/** Configurable notification mode. */
export type NotifyMode = typeof NOTIFY_MODES[number]

/**
 * Default mode: OS notifications stay off until the first qualifying event
 * triggers the browser's permission prompt, and stay on after a grant.
 */
export const DEFAULT_NOTIFY_MODE: NotifyMode = 'ask'

/** One "HH:MM" 24-hour clock time, or '' when the quiet window is disabled. */
export type QuietTime = string

/** Default quiet-window bound: no window. */
export const DEFAULT_QUIET_TIME: QuietTime = ''

/** Durable notify section shared by the Host schema and the browser scope. */
export interface NotifySettings {
  /** Notification mode. */
  mode: NotifyMode
  /** Quiet-window start ('' disables the window). */
  quietFrom: QuietTime
  /** Quiet-window end ('' disables the window). */
  quietTo: QuietTime
}

/** One "HH:MM" 24-hour clock time (an empty string means the window is off). */
const QUIET_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/

/** Durable notify schema; also the wire envelope the browser scope validates against. */
export const NotifySettingsSchema: z<NotifySettings> = z.object({
  [NOTIFY_MODE_FIELD]: z.union([...NOTIFY_MODES]).default(DEFAULT_NOTIFY_MODE),
  [QUIET_FROM_FIELD]: z.union([z.const(''), z.string().pattern(QUIET_TIME_PATTERN)])
    .default(DEFAULT_QUIET_TIME),
  [QUIET_TO_FIELD]: z.union([z.const(''), z.string().pattern(QUIET_TIME_PATTERN)])
    .default(DEFAULT_QUIET_TIME),
})
