/** ui-notify apply wiring: service edges, dictionaries, General-section row
 *  registration, scope adoption into the row store, gesture writes back to
 *  the Host document, and HMR-safe teardown. Node-env with service stubs. */
import { Context } from '@buckeyestudio/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { ObservableSnapshot, SessionListState } from '@buckeyestudio/toh-client-runtime/client'
import { SlotRegistry } from '@buckeyestudio/toh-client-runtime/client'
import { LocaleRuntime } from '@buckeyestudio/toh-client-locale/client'
import { stubSettingsScope, TestRemote } from '@buckeyestudio/toh-client-test-runtime'
import {
  DEFAULT_NOTIFY_MODE, NOTIFY_MODE_FIELD,
} from '../src/notify-settings.ts'
import { NotificationsRow } from '../src/client/NotificationsRow.tsx'
import type { NotificationsRowInjected } from '../src/client/NotificationsRow.tsx'
import type { createNotifyRowStore } from '../src/client/settings-store.ts'
import { apply, inject } from '../src/client/index.ts'

const SLOT = 'settings.general.item'
const NS = 'settings.notify'

function emptyListSnapshot(): ObservableSnapshot<SessionListState> {
  const empty: SessionListState = {
    ids: [], byId: {}, current: undefined, phase: 'ready',
    subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
  return { getSnapshot: () => empty, subscribe: () => () => {} }
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  ctx.provide('connection', {} as never)
  new TestRemote(ctx)
  const stub = stubSettingsScope<{ mode: string; quietFrom: string; quietTo: string }>()
  ctx.provide('settingsScope', { bind: () => stub.scope } as never)
  ctx.provide('sessions', { list: emptyListSnapshot() } as never)
  // Stand in for the settings shell: declare the General item slot.
  const slots = ctx.get('slots') as SlotRegistry
  slots.register(
    { name: 'root', children: { [SLOT]: { kind: 'list', scope: 'root' } } } as never,
    () => null,
  )
  return { ctx, stub, locale, slots }
}

describe('ui-notify apply', () => {
  it('declares its service edges', () => {
    expect(inject).toEqual(['slots', 'sessions', 'locale', 'connection', 'remote', 'settingsScope'])
  })

  it('registers localized copy and the General-section row', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.locale.bind(NS)('notify.title')).toBe('桌面通知')
    b.locale.setLocale('en')
    expect(b.locale.bind(NS)('notify.title')).toBe('Desktop notifications')
    b.locale.setLocale('zh')
    const entry = b.slots.entries(SLOT).find(e => e.component === NotificationsRow)!
    expect(entry.options).toMatchObject({ id: 'notifications', order: 30 })
    expect(entry.locale).toBe(NS)
  })

  it('adopts the durable section into the row store and routes gestures to the document', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.stub.publish({
      status: 'ready',
      value: { mode: 'on', quietFrom: '', quietTo: '' },
      revision: 3,
      writable: true,
    })
    const entry = b.slots.entries(SLOT).find(e => e.component === NotificationsRow)!
    const handle = entry.store as ReturnType<typeof createNotifyRowStore>
    const instance = handle.create()
    // The inject-time re-publish seals the window between adoption and mount.
    const face = (entry.inject as unknown as (a: typeof instance.actions) => NotificationsRowInjected)(
      instance.actions,
    )
    expect(instance.getSnapshot()).toMatchObject({ mode: 'on' })

    face.setMode('off')
    expect(instance.getSnapshot().mode).toBe('off')
    await vi.waitFor(() => {
      expect(b.stub.set).toHaveBeenCalledWith(NOTIFY_MODE_FIELD, 'off')
    })
    face.setQuiet('quietFrom', '22:00')
    expect(instance.getSnapshot().quietFrom).toBe('22:00')
    await vi.waitFor(() => {
      expect(b.stub.set).toHaveBeenCalledWith('quietFrom', '22:00')
    })

    // A Host acceptance overwrites local gestures.
    b.stub.publish({
      value: { mode: DEFAULT_NOTIFY_MODE, quietFrom: '', quietTo: '' },
      revision: 4,
    })
    expect(instance.getSnapshot().mode).toBe(DEFAULT_NOTIFY_MODE)
  })

  it('teardown removes the row and the dictionaries fall back to bare keys', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries(SLOT)).toHaveLength(1)
    await fiber.dispose()
    expect(b.slots.entries(SLOT)).toHaveLength(0)
    expect(b.locale.bind(NS)('notify.title')).toBe('notify.title')
  })
})
