/**
 * Turn-notification plugin, browser half: watches the sessions list snapshot
 * and raises OS notifications when a turn completes or an agent is blocked on
 * an approval — the two states a user misses after switching tabs. The Web
 * Notifications API works unchanged inside the Electron renderer over plain
 * HTTP+SSE. The permission prompt fires only on the first qualifying event,
 * never at load; the durable mode lives in the `ui-notify` settings namespace
 * with its General-section row, which this package also owns.
 * @module @buckeyestudio/toh-client-ui-notify/client
 */

import type { BoundActions } from '@buckeyestudio/toh-client-ui-slots'
import type { ClientContext, SettingsScope } from '@buckeyestudio/toh-client-runtime/client'
// Type-only: the ctx.settingsScope Context merge and the settings slot types.
import type {} from '@buckeyestudio/toh-client-ui-settings/client'
// Type-only: pulls ctx.locale into this program.
import type {} from '@buckeyestudio/toh-client-locale/client'
import type { NotifyPermissionState } from './decide.ts'
import { NotifyController, type NotifySettingsView } from './controller.ts'
import { NotificationsRow, type NotificationsRowInjected } from './NotificationsRow.tsx'
import { createNotifyRowStore } from './settings-store.ts'
import { en, zh, type NotifyKey } from './locales.ts'
import {
  DEFAULT_NOTIFY_MODE, DEFAULT_QUIET_TIME, NOTIFY_MODE_FIELD, NOTIFY_SETTINGS_NAMESPACE,
  QUIET_FROM_FIELD, QUIET_TO_FIELD, type NotifyMode, type NotifySettings,
} from '../notify-settings.ts'

export type { NotificationsRowInjected } from './NotificationsRow.tsx'
export type { NotifyKey } from './locales.ts'
export type { NotifyRowState } from './settings-store.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.notify'

/** Row order inside the General section (after composer-enter's 20). */
const ROW_ORDER = 30

declare module '@buckeyestudio/toh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop-notification copy: the settings row plus toast titles. */
    'settings.notify': NotifyKey
  }
}

/**
 * Required services. `sessions` carries the list snapshot the watcher edges
 * over; `settingsScope` transitively pins ui-settings (which binds connection
 * + remote for its shared mirror); slots/locale carry the General-section row
 * registration and its copy.
 */
export const inject = ['slots', 'sessions', 'locale', 'connection', 'remote', 'settingsScope']

/** Current Notification permission state without assuming the API exists. */
function currentPermission(): NotifyPermissionState {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

/**
 * Run the browser permission request once. A rejecting environment resolves
 * denied instead of throwing into the pass chain.
 */
async function requestOsPermission(): Promise<NotifyPermissionState> {
  if (typeof Notification === 'undefined') return 'unsupported'
  try {
    return await Notification.requestPermission()
  } catch {
    return 'denied'
  }
}

/** Minutes since local midnight (the quiet window follows wall-clock local time). */
function nowMinutes(): number {
  const now = new Date()
  return now.getHours() * 60 + now.getMinutes()
}

/** Settings view each controller pass reads off the live scope snapshot. */
function settingsView(scope: SettingsScope<NotifySettings>): NotifySettingsView {
  const section = scope.getSnapshot().value
  if (section === undefined) {
    return { mode: DEFAULT_NOTIFY_MODE, quietFrom: DEFAULT_QUIET_TIME, quietTo: DEFAULT_QUIET_TIME }
  }
  return { mode: section.mode, quietFrom: section.quietFrom, quietTo: section.quietTo }
}

/**
 * Client plugin body: the notifications preference row in the General
 * settings section and the headless edge watcher behind it.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-notify: dictionaries')

  const host = ctx.settingsScope.bind<NotifySettings>({ namespace: NOTIFY_SETTINGS_NAMESPACE })
  const store = createNotifyRowStore()

  // Live view of the durable section plus the row mirror. The scope stays
  // authoritative; a gesture publishes locally before the durable write so
  // memory-mode compositions still see the choice this session.
  let view = settingsView(host)
  let bound: BoundActions<typeof store> | undefined
  const publish = (): void => {
    bound?.apply(view.mode, view.quietFrom, view.quietTo)
  }
  const adopt = (): void => {
    const next = settingsView(host)
    if (next.mode === view.mode && next.quietFrom === view.quietFrom && next.quietTo === view.quietTo) return
    view = next
    publish()
  }

  // One controller per page: edges over the whole session list.
  const t = ctx.locale.bind(NS)
  const controller = new NotifyController(
    ctx.sessions.list,
    () => view,
    () => ({
      completed: t('notify.completed.title'),
      approval: t('notify.approval.title'),
    }),
    {
      focused: () => document.hasFocus(),
      permission: currentPermission,
      requestPermission: requestOsPermission,
      nowMinutes,
      raise: ({ title, body, tag }) => {
        new Notification(title, { body, tag })
      },
    },
  )
  ctx.effect(() => {
    const disposeWatch = controller.start()
    const disposeAdopt = host.subscribe(adopt)
    adopt()
    return () => {
      disposeAdopt()
      disposeWatch()
    }
  }, 'ui-notify: notification watcher')

  const injected = (actions: BoundActions<typeof store>): NotificationsRowInjected => {
    bound = actions
    publish()
    return {
      setMode: (mode: NotifyMode) => {
        view = { ...view, mode }
        publish()
        void host.set(NOTIFY_MODE_FIELD, mode)
      },
      setQuiet: (field, value) => {
        view = field === 'quietFrom' ? { ...view, quietFrom: value } : { ...view, quietTo: value }
        publish()
        void host.set(field === 'quietFrom' ? QUIET_FROM_FIELD : QUIET_TO_FIELD, value)
      },
    }
  }
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'notifications',
    order: ROW_ORDER,
    store,
    locale: NS,
    inject: injected,
  }, NotificationsRow))
}
