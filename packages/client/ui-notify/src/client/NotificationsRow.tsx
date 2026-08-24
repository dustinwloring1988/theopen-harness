/**
 * Desktop-notifications preference row registered into the General section
 * item slot: title/description, the mode selector (ask/on/off), and the
 * optional quiet-hours time pair. Registered by this package — the notify
 * feature owns its own settings surface.
 */
import { useState } from 'react'
import { IconChevronDownOutline14, Menu } from '@buckeyestudio/toh-client-ui-primitives'
import type {
  InjectFace, PropsLocale, PropsRuntime, PropsStore,
} from '@buckeyestudio/toh-client-ui-slots'
import type {} from '@buckeyestudio/toh-client-ui-settings/client'
import type { NotifyMode } from '../notify-settings.ts'
import type { NotifyKey } from './locales.ts'
import type { createNotifyRowStore, NotifyRowState } from './settings-store.ts'
import css from './NotificationsRow.module.css'

/** Injected business face: the preference writes (t rides the standard locale seat). */
export interface NotificationsRowInjected {
  /** Switch the notification mode. */
  setMode: (mode: NotifyMode) => void
  /** Set one quiet-window bound ('' clears it). */
  setQuiet: (field: 'quietFrom' | 'quietTo', value: string) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type NotificationsRowProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createNotifyRowStore>>
  & PropsLocale<'settings.notify'> & InjectFace<NotificationsRowInjected>

/** Mode options in selector order. */
const MODES: readonly { id: NotifyMode; labelKey: NotifyKey }[] = [
  { id: 'ask', labelKey: 'notify.mode.ask' },
  { id: 'on', labelKey: 'notify.mode.on' },
  { id: 'off', labelKey: 'notify.mode.off' },
]

/**
 * Render the desktop-notifications row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function NotificationsRow({ t, useStore, setMode, setQuiet }: NotificationsRowProps) {
  const mode = useStore(s => s.mode)
  const [open, setOpen] = useState(false)
  const selectedLabel = MODES.find(option => option.id === mode)?.labelKey ?? 'notify.mode.ask'
  return (
    <div>
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.title}>{t('notify.title')}</div>
          <div className={css.desc}>{t('notify.description')}</div>
        </div>
        <Menu
          open={open}
          onClose={() => { setOpen(false) }}
          items={MODES.map(option => ({ id: option.id, label: t(option.labelKey) }))}
          selectedId={mode}
          onSelect={(id) => {
            setOpen(false)
            if (id === 'ask' || id === 'on' || id === 'off') setMode(id)
          }}
          align="end"
          portal
          anchor={(
            <button
              type="button"
              className={css.selector}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => { setOpen(value => !value) }}
            >
              {t(selectedLabel)}
              <IconChevronDownOutline14 className={css.chevron} />
            </button>
          )}
        />
      </div>
      <div className={css.row}>
        <div className={css.rowText}>
          <div className={css.title}>{t('notify.quiet.title')}</div>
          <div className={css.desc}>{t('notify.quiet.description')}</div>
        </div>
        <label className={css.quiet}>
          {t('notify.quietFrom')}
          <TimeField field="quietFrom" t={t} useStore={useStore} setQuiet={setQuiet} />
        </label>
        <label className={css.quiet}>
          {t('notify.quietTo')}
          <TimeField field="quietTo" t={t} useStore={useStore} setQuiet={setQuiet} />
        </label>
      </div>
    </div>
  )
}

/** Quiet-window bound fields and their dictionary keys. */
const QUIET_FIELDS = {
  quietFrom: 'notify.quietFrom',
  quietTo: 'notify.quietTo',
} as const satisfies Record<'quietFrom' | 'quietTo', NotifyKey>

function TimeField({ field, t, useStore, setQuiet }: {
  field: 'quietFrom' | 'quietTo'
  t: (key: NotifyKey) => string
  useStore: <S>(sel: (s: NotifyRowState) => S) => S
  setQuiet: (field: 'quietFrom' | 'quietTo', value: string) => void
}) {
  const value = useStore(state => state[field])
  return (
    <input
      type="time"
      className={css.timeInput}
      aria-label={`${t(QUIET_FIELDS[field])} (${t('notify.quiet.title')})`}
      value={value}
      onChange={(e) => { setQuiet(field, e.target.value) }}
    />
  )
}
