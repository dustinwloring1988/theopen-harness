/**
 * Host registration for the browser turn-notification preference. Pure UI
 * plugin: the node half exists so the plugin appears in the host cordis.yml /
 * Loader and can register its durable settings namespace; the browser half
 * ships via exports["./client"], discovered through the package.json
 * toh.client declaration.
 */

import type { Context } from '@buckeyestudio/cordis'
import { settingsNamespace } from '@buckeyestudio/toh-settings'
import {
  NOTIFY_SETTINGS_NAMESPACE, NotifySettingsSchema,
} from './notify-settings.ts'

export {
  DEFAULT_NOTIFY_MODE, DEFAULT_QUIET_TIME, NOTIFY_MODE_FIELD, NOTIFY_MODES,
  NOTIFY_SETTINGS_NAMESPACE, QUIET_FROM_FIELD, QUIET_TO_FIELD,
  type NotifyMode, type NotifySettings, type QuietTime,
} from './notify-settings.ts'

/**
 * Register the durable notify section when a settings provider is composed.
 * @param ctx - Host context whose optional settings service owns the section.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(
      settingsNamespace(NOTIFY_SETTINGS_NAMESPACE),
      NotifySettingsSchema,
    )
  })
}
