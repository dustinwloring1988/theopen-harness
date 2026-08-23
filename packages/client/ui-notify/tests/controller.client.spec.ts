/** NotifyController edge detection: completion and approval edges, dedupe
 *  arcs, focus/quiet suppression, the ask-on-first-event permission flow, and
 *  disposal. Node-env with fake ports and a controllable snapshot source. */
import { describe, expect, it, vi } from 'vitest'
import type {
  ObservableSnapshot, SessionId, SessionListState, SessionSummary,
} from '@buckeyestudio/toh-client-runtime/client'
import { NotifyController, type NotifyPorts, type NotifySettingsView } from '../src/client/controller.ts'

const sid = (id: string) => id as SessionId

/** Controllable sessions-list double: publish() replaces the snapshot. */
function listSource(initial: SessionListState): {
  list: ObservableSnapshot<SessionListState>
  publish(next: SessionListState): void
} {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    list: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    publish: (next) => {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function summary(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: sid(id), displayTitle: `Session ${id}`, running: false,
    blank: false, updatedAt: 0, ...extra,
  }
}

function list(items: readonly SessionSummary[]): SessionListState {
  return {
    ids: items.map(item => item.id),
    byId: Object.fromEntries(items.map(item => [item.id as string, item])),
    current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {},
    currentAddress: undefined,
  }
}

interface Bench {
  controller: NotifyController
  publish(next: SessionListState): void
  raised(): { kind: string; body: string; tag: string }[]
  requests(): number
  setFocus(focused: boolean): void
  setQuiet(active: boolean): void
}

function bench(mode: NotifySettingsView['mode']): Bench {
  const source = listSource(list([]))
  let focused = false
  const view: NotifySettingsView = mode === 'off'
    ? { mode: 'off', quietFrom: '', quietTo: '' }
    : { mode, quietFrom: '', quietTo: '' }
  let permission: ReturnType<NotifyPorts['permission']> = mode === 'on' ? 'granted' : 'default'
  const requestPermission = vi.fn(() => {
    permission = 'granted'
    return Promise.resolve(permission)
  })
  const raised: { kind: string; body: string; tag: string }[] = []
  const controller = new NotifyController(
    source.list,
    () => view,
    () => ({ completed: 'notify.completed.title', approval: 'notify.approval.title' }),
    {
      focused: () => focused,
      permission: () => permission,
      requestPermission,
      nowMinutes: () => 12 * 60,
      raise: (notification) => { raised.push(notification) },
    },
  )
  return {
    controller,
    publish: (next) => { source.publish(next) },
    raised: () => raised,
    requests: () => requestPermission.mock.calls.length,
    setFocus: (value) => { focused = value },
    // An all-day window is the cheapest way to make "quiet" a live fact.
    setQuiet: (active) => {
      view.quietFrom = active ? '00:00' : ''
      view.quietTo = active ? '23:59' : ''
    },
  }
}

describe('NotifyController', () => {
  it('raises one turn-completed toast per finished-but-unviewed arc', async () => {
    const b = bench('on')
    b.publish(list([summary('a', { running: true })]))
    await b.controller.pass()

    b.publish(list([summary('a', { completed: true })]))
    await b.controller.pass()
    expect(b.raised()).toEqual([
      { kind: 'turn-completed', title: 'notify.completed.title', body: 'Session a', tag: `${sid('a')}:completed` },
    ])

    // A replayed identical snapshot must not re-fire.
    b.publish(list([summary('a', { completed: true })]))
    await b.controller.pass()
    expect(b.raised()).toHaveLength(1)

    // Opening the session clears the reminder; the next finish notifies
    // again. Two consecutive idle passes disarm the consumed arc.
    b.publish(list([summary('a')]))
    await b.controller.pass()
    b.publish(list([summary('a')]))
    await b.controller.pass()
    b.publish(list([summary('a', { completed: true })]))
    await b.controller.pass()
    expect(b.raised()).toHaveLength(2)
    expect(b.requests()).toBe(0)
  })

  it('raises an approval-required toast when a pending interaction appears', async () => {
    const b = bench('on')
    b.publish(list([summary('a')]))
    await b.controller.pass()

    b.publish(list([summary('a', { pendingInteraction: 'approval' })]))
    await b.controller.pass()
    expect(b.raised()).toEqual([
      { kind: 'approval-required', title: 'notify.approval.title', body: 'Session a', tag: `${sid('a')}:pending:approval` },
    ])
  })

  it('labels each candidate by its own fact when one summary carries both', async () => {
    const b = bench('on')
    b.publish(list([summary('a')]))
    await b.controller.pass()

    // Both facts standing on one summary: the pending key must announce the
    // approval title, the completed key the completion title.
    b.publish(list([summary('a', { pendingInteraction: 'approval', completed: true })]))
    await b.controller.pass()
    expect(b.raised()).toEqual([
      { kind: 'approval-required', title: 'notify.approval.title', body: 'Session a', tag: `${sid('a')}:pending:approval` },
      { kind: 'turn-completed', title: 'notify.completed.title', body: 'Session a', tag: `${sid('a')}:completed` },
    ])
  })

  it('primes from the first ready snapshot, never from the pending phase', async () => {
    const source = listSource({ ...list([]), phase: 'pending' })
    const focused = false
    const permission: ReturnType<NotifyPorts['permission']> = 'granted'
    const raised: { kind: string; tag: string }[] = []
    const controller = new NotifyController(
      source.list,
      () => ({ mode: 'on', quietFrom: '', quietTo: '' }),
      () => ({ completed: 'notify.completed.title', approval: 'notify.approval.title' }),
      {
        focused: () => focused,
        permission: () => permission,
        requestPermission: () => Promise.resolve(permission),
        nowMinutes: () => 12 * 60,
        raise: (n) => { raised.push({ kind: n.kind, tag: n.tag }) },
      },
    )

    // A pre-baseline publish arms nothing and raises nothing.
    source.publish({ ...list([]), phase: 'pending' })
    await controller.pass()

    // The ready baseline carrying standing facts primes silently.
    source.publish(list([summary('booted', { completed: true })]))
    await controller.pass()
    expect(raised).toEqual([])

    // A genuinely new arc afterwards still notifies.
    source.publish(list([
      summary('booted', { completed: true }),
      summary('fresh', { completed: true }),
    ]))
    await controller.pass()
    expect(raised).toEqual([{ kind: 'turn-completed', tag: `${sid('fresh')}:completed` }])
  })

  it('asks at most once per page even when an answer stays default', async () => {
    const source = listSource(list([]))
    const requestPermission = vi.fn(() => Promise.resolve('default' as const))
    const controller = new NotifyController(
      source.list,
      () => ({ mode: 'ask', quietFrom: '', quietTo: '' }),
      () => ({ completed: 'c', approval: 'a' }),
      {
        focused: () => false,
        permission: () => 'default',
        requestPermission,
        nowMinutes: () => 0,
        raise: () => {},
      },
    )
    await controller.pass()
    source.publish(list([summary('a', { completed: true })]))
    await controller.pass()
    expect(requestPermission).toHaveBeenCalledTimes(1)

    // The next event must not re-prompt the unanswered page.
    source.publish(list([summary('a', { completed: true }), summary('b', { completed: true })]))
    await controller.pass()
    expect(requestPermission).toHaveBeenCalledTimes(1)
  })

  it('re-notifies only after the interaction has been gone for two passes', async () => {
    const b = bench('on')
    b.publish(list([summary('a')]))
    await b.controller.pass()

    b.publish(list([summary('a', { pendingInteraction: 'plan-review' })]))
    await b.controller.pass()
    b.publish(list([summary('a', { pendingInteraction: 'plan-review' })]))
    await b.controller.pass()
    expect(b.raised()).toHaveLength(1)

    // One absent pass is not enough to re-arm: this is exactly what a
    // reconnect generation looks like (clear, then replay the same wait).
    b.publish(list([summary('a')]))
    await b.controller.pass()
    b.publish(list([summary('a', { pendingInteraction: 'plan-review' })]))
    await b.controller.pass()
    expect(b.raised()).toHaveLength(1)

    // Two consecutive absent passes mean the wait truly resolved.
    b.publish(list([summary('a')]))
    await b.controller.pass()
    await b.controller.pass()
    b.publish(list([summary('a', { pendingInteraction: 'question' })]))
    await b.controller.pass()
    expect(b.raised()).toHaveLength(2)
    expect(b.raised()[1]!.tag).toBe(`${sid('a')}:pending:question`)
  })

  it('treats facts standing since the first pass as baseline, not edges', async () => {
    const b = bench('ask')
    // Boot straight into a world where a session is already blocked: no
    // prompt, no toast — the page just opened and its dots say it too.
    b.publish(list([summary('blocked', { pendingInteraction: 'approval' })]))
    await b.controller.pass()
    expect(b.requests()).toBe(0)
    expect(b.raised()).toEqual([])

    // A genuinely new arc afterwards still asks once and notifies.
    b.publish(list([summary('later', { completed: true })]))
    await b.controller.pass()
    expect(b.requests()).toBe(1)
    expect(b.raised().map(n => n.tag)).toEqual([`${sid('later')}:completed`])
  })

  it('suppresses while focused but still consumes the arc', async () => {
    const b = bench('on')
    await b.controller.pass()
    b.setFocus(true)
    b.publish(list([summary('a', { completed: true })]))
    await b.controller.pass()
    expect(b.raised()).toEqual([])

    // Switching away later does not retroactively notify the stale arc.
    b.setFocus(false)
    b.publish(list([summary('a', { completed: true })]))
    await b.controller.pass()
    expect(b.raised()).toEqual([])
  })

  it('suppresses inside quiet hours without disarming the fact', async () => {
    const b = bench('on')
    await b.controller.pass()
    b.setQuiet(true)
    b.publish(list([summary('a', { pendingInteraction: 'approval' })]))
    await b.controller.pass()
    expect(b.raised()).toEqual([])

    // Quiet hours lifting mid-arc stays silent; only a new arc may fire.
    b.setQuiet(false)
    b.publish(list([summary('a', { pendingInteraction: 'approval' })]))
    await b.controller.pass()
    expect(b.raised()).toEqual([])
  })

  it('asks once on the first qualifying event in ask mode and raises after the grant', async () => {
    const b = bench('ask')
    // An all-idle world produces no keys — and no prompt.
    await b.controller.pass()
    expect(b.requests()).toBe(0)
    expect(b.raised()).toEqual([])

    b.publish(list([summary('a', { completed: true })]))
    await b.controller.pass()
    expect(b.requests()).toBe(1)
    expect(b.raised()).toEqual([
      { kind: 'turn-completed', title: 'notify.completed.title', body: 'Session a', tag: `${sid('a')}:completed` },
    ])
    // Answered pages never ask again.
    b.publish(list([summary('b', { completed: true })]))
    await b.controller.pass()
    expect(b.requests()).toBe(1)
  })

  it('never asks in off mode even on real events', async () => {
    const off = bench('off')
    off.publish(list([summary('a', { completed: true })]))
    await off.controller.pass()
    expect(off.requests()).toBe(0)
    expect(off.raised()).toEqual([])

    // Switching to on later revives notification for fresh events only.
    const revived = bench('ask')
    await revived.controller.pass()
    revived.publish(list([summary('a', { pendingInteraction: 'approval' })]))
    await revived.controller.pass()
    expect(revived.requests()).toBe(1)
    expect(revived.raised()).toHaveLength(1)
  })

  it('keeps bookkeeping when the environment refuses to raise', async () => {
    const source = listSource(list([]))
    const raise = vi.fn(() => { throw new Error('withdrawn') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const controller = new NotifyController(
        source.list,
        () => ({ mode: 'on', quietFrom: '', quietTo: '' }),
        () => ({ completed: 'c', approval: 'a' }),
        {
          focused: () => false,
          permission: () => 'granted',
          requestPermission: () => Promise.resolve('granted'),
          nowMinutes: () => 0,
          raise,
        },
      )
      await controller.pass()
      source.publish(list([summary('a', { completed: true })]))
      await controller.pass()
      expect(raise).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalled()

      // The failed arc is consumed: replays stay silent.
      source.publish(list([summary('a', { completed: true })]))
      await controller.pass()
      expect(raise).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('start() watches the list; stop() detaches and resets priming', async () => {
    const b = bench('on')
    await b.controller.pass()
    const dispose = b.controller.start()
    b.publish(list([summary('a', { completed: true })]))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(b.raised()).toHaveLength(1)

    // After disposal nothing watches the list.
    dispose()
    b.publish(list([summary('a', { completed: true }), summary('c', { completed: true })]))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(b.raised()).toHaveLength(1)

    // A fresh watcher re-primes silently even on a standing fact.
    const fresh = bench('on')
    await fresh.controller.pass()
    fresh.publish(list([summary('a', { completed: true })]))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fresh.raised()).toHaveLength(0)
  })

  it('start() is idempotent', () => {
    const b = bench('on')
    const first = b.controller.start()
    expect(b.controller.start()).toBe(first)
    first()
  })

  it('serializes passes so a slow permission handshake cannot interleave edges', async () => {
    const source = listSource(list([]))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const requestPermission = vi.fn(() => gate.then(() => 'granted' as const))
    const raised: string[] = []
    const controller = new NotifyController(
      source.list,
      () => ({ mode: 'ask', quietFrom: '', quietTo: '' }),
      () => ({ completed: 'notify.completed.title', approval: 'notify.approval.title' }),
      {
        focused: () => false,
        permission: () => 'default',
        requestPermission,
        nowMinutes: () => 0,
        raise: (n) => { raised.push(n.tag) },
      },
    )
    source.publish(list([]))
    await controller.pass()
    source.publish(list([summary('a', { completed: true })]))
    const first = controller.pass()
    const second = controller.pass()
    release()
    await Promise.all([first, second])
    expect(raised).toEqual([`${sid('a')}:completed`])
    expect(requestPermission).toHaveBeenCalledTimes(1)
  })
})
