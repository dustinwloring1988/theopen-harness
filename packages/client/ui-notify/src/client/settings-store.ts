/**
 * Notifications row slot store: mirrors the durable settings scope. Both the
 * plugin's scope subscription and the row's own gesture writes go through one
 * action; values are absolute, so every apply just republishes.
 */
import { defineStore, type EngineStoreHandle } from '@buckeyestudio/toh-client-runtime/client'
import { DEFAULT_NOTIFY_MODE, DEFAULT_QUIET_TIME, type NotifyMode, type QuietTime } from '../notify-settings.ts'

/** Store state mirrored from the settings scope. */
export interface NotifyRowState {
  /** Durable notification mode. */
  mode: NotifyMode
  /** Quiet-window start ('' disables the window). */
  quietFrom: QuietTime
  /** Quiet-window end ('' disables the window). */
  quietTo: QuietTime
  /** Monotonic apply counter; the selector engine publishes on each bump. */
  seq: number
}

/** Declared action shape giving the exported factory a stable return type. */
type NotifyRowActions = {
  apply: (
    draft: NotifyRowState,
    mode: NotifyMode,
    quietFrom: QuietTime,
    quietTo: QuietTime,
  ) => void
}

/**
 * Declares the Notifications row state and write surface.
 * @returns the store handle.
 */
export function createNotifyRowStore(): EngineStoreHandle<NotifyRowState, NotifyRowActions> {
  return defineStore({
    init: (): NotifyRowState => ({
      mode: DEFAULT_NOTIFY_MODE,
      quietFrom: DEFAULT_QUIET_TIME,
      quietTo: DEFAULT_QUIET_TIME,
      seq: 0,
    }),
    actions: {
      apply: (d, mode, quietFrom, quietTo) => {
        d.mode = mode
        d.quietFrom = quietFrom
        d.quietTo = quietTo
        d.seq += 1
      },
    },
  })
}
