/**
 * Turn-notification controller: watches the sessions list snapshot, derives
 * turn-completion and approval-required edges, and raises OS notifications
 * through injectable ports. All decisions flow through the pure gate in
 * decide.ts; this class owns only edge detection, dedupe bookkeeping, and the
 * asynchronous permission handshake.
 * @module @buckeyestudio/toh-client-ui-notify/client/controller
 */

import type {
  ObservableSnapshot, PendingInteractionStatus, SessionId, SessionListState, SessionSummary,
} from '@buckeyestudio/toh-client-runtime/client'
import {
  shouldNotify, shouldRequestPermission,
  isWithinQuietHours, type NotifyEventKind, type NotifyPermissionState,
} from './decide.ts'

/** Localized toast titles, resolved per pass so locale switches follow. */
export interface NotifyTitles {
  /** Title for a completed turn ("Turn completed"). */
  completed: string
  /** Title for an approval-blocked agent ("Approval needed"). */
  approval: string
}

/** Environmental ports the controller needs from the browser. */
export interface NotifyPorts {
  /** Whether the document currently has focus. */
  focused(): boolean
  /** Current Notification permission state ('unsupported' without the API). */
  permission(): NotifyPermissionState
  /**
   * Run the browser permission request; resolves to the new state.
   * Implementations must only be called when the state is `'default'`.
   */
  requestPermission(): Promise<NotifyPermissionState>
  /** Minutes since local midnight (quiet-window clock). */
  nowMinutes(): number
  /**
   * Raise one OS notification; `tag` lets the OS replace same-arc toasts.
   * Implementations may throw when the environment refuses (the controller
   * warns and keeps its bookkeeping).
   */
  raise(notification: {
    kind: NotifyEventKind
    /** Localized toast title ("Approval needed" / "Turn completed"). */
    title: string
    /** Session display title as the toast body. */
    body: string
    tag: string
  }): void
}

/** The durable settings slice each pass reads. */
export interface NotifySettingsView {
  mode: 'ask' | 'on' | 'off'
  quietFrom: string
  quietTo: string
}

/** One pending fact per session as seen in the previous pass. */
interface SessionFacts {
  pending?: PendingInteractionStatus
  completed: boolean
}

/**
 * Edge detector over the sessions list. Dedupe keys are derived from live
 * state (`<session>:pending:<status>` / `<session>:completed`) and stay armed
 * while the state stands, so snapshot replays cannot re-fire an already-raised
 * toast. Three guards keep the edges honest:
 *
 * - The first ready snapshot only records standing facts (the
 *   SessionManager reminder precedent): a page that boots into an
 *   already-blocked or already-finished world neither notifies nor prompts at
 *   load, and the pre-baseline `pending` phase publishes no edges either.
 * - A key disarms only after its fact has been absent for two consecutive
 *   passes, so a reconnect generation — which clears and replays the same
 *   pending interactions — cannot manufacture a phantom repeat.
 * - The OS `tag` carries the same key, so the platform replaces same-arc
 *   toasts as a second layer.
 */
export class NotifyController {
  readonly #list: ObservableSnapshot<SessionListState>
  readonly #settings: () => NotifySettingsView
  readonly #ports: NotifyPorts
  readonly #titles: () => NotifyTitles
  /** Keys whose notification already fired or whose fact stood at priming. */
  readonly #armed = new Set<string>()
  /** Consecutive absences per armed key; two in a row disarms it. */
  readonly #missing = new Map<string, number>()
  /** Whether the first (recording-only) pass has run since start(). */
  #primed = false
  /**
   * Whether this page already ran the permission request; an unanswered result
   * still counts. The flag outlives stop()/start(): the browser prompts once
   * per page lifetime, so restarting the watcher must not re-ask.
   */
  #permissionAsked = false
  /** Serializes passes so async permission handshakes cannot interleave. */
  #chain: Promise<void> = Promise.resolve()
  /** The stable stop handle handed out by start(). */
  #stop: (() => void) | undefined

  /**
   * @param list - the sessions list snapshot source (ctx.sessions.list).
   * @param settings - reads the durable settings view per pass.
   * @param titles - localized toast titles, resolved per pass.
   * @param ports - browser ports (focus, permission, clock, raise).
   */
  constructor(
    list: ObservableSnapshot<SessionListState>,
    settings: () => NotifySettingsView,
    titles: () => NotifyTitles,
    ports: NotifyPorts,
  ) {
    this.#list = list
    this.#settings = settings
    this.#titles = titles
    this.#ports = ports
  }

  /** Begin watching the list; the returned disposer stops watching. */
  start(): () => void {
    if (this.#stop !== undefined) return this.#stop
    const unsubscribe = this.#list.subscribe(() => { void this.pass() })
    this.#stop = () => {
      unsubscribe()
      this.#stop = undefined
      this.#armed.clear()
      this.#missing.clear()
      this.#primed = false
      // #permissionAsked deliberately survives: the prompt is once per page,
      // so a restart within this page never re-asks an unanswered permission.
    }
    return this.#stop
  }

  /** Run one detection pass; passes serialize through one promise chain. */
  pass(): Promise<void> {
    const run = this.#chain.then(() => this.#runOnce(), () => this.#runOnce())
    this.#chain = run
    return run
  }

  async #runOnce(): Promise<void> {
    const snapshot = this.#list.getSnapshot()
    // The list publishes an empty `pending` phase before the first successful
    // pull; priming there would arm nothing and then treat the ready baseline
    // as new events. Wait for the first ready snapshot and prime from it.
    if (!this.#primed && snapshot.phase !== 'ready') return
    const standing = new Set<string>()
    for (const summary of Object.values(snapshot.byId)) {
      for (const { key } of keysOf(summary.id, factsOf(summary))) standing.add(key)
    }
    if (!this.#primed) {
      this.#primed = true
      for (const key of standing) this.#armed.add(key)
      return
    }
    // Candidates first: keys standing now but not armed, i.e. genuinely new
    // arcs relative to everything this page has already observed. Each key
    // carries its own kind so a summary reporting both facts labels the
    // pending candidate as approval-required, not as turn-completed.
    const candidates: { key: string; kind: NotifyEventKind; body: string }[] = []
    for (const summary of Object.values(snapshot.byId)) {
      for (const { key, kind } of keysOf(summary.id, factsOf(summary))) {
        if (!this.#armed.has(key)) {
          candidates.push({ key, kind, body: summary.displayTitle })
        }
      }
    }
    let mode = this.#settings().mode
    let permission = this.#ports.permission()
    // A pass carrying a genuinely new event triggers the single per-page
    // permission attempt — never at load: priming waits for the first ready
    // snapshot and produces no candidates.
    if (candidates.length > 0 && shouldRequestPermission(mode, permission, this.#permissionAsked)) {
      this.#permissionAsked = true
      permission = await this.#ports.requestPermission()
      mode = this.#settings().mode
    }
    const quiet = isWithinQuietHours(
      this.#ports.nowMinutes(),
      this.#settings().quietFrom,
      this.#settings().quietTo,
    )
    const focused = this.#ports.focused()
    for (const candidate of candidates) {
      this.#armed.add(candidate.key)
      this.#missing.delete(candidate.key)
      // Arm regardless of the gate outcome: a denied or suppressed arc has
      // been "delivered" to the surfaces that remain (dots, sidebar); the
      // next real event arms a fresh key.
      if (!shouldNotify({ mode, focused, quiet, permission, duplicate: false })) continue
      const titles = this.#titles()
      try {
        this.#ports.raise({
          kind: candidate.kind,
          title: candidate.kind === 'approval-required' ? titles.approval : titles.completed,
          body: candidate.body,
          tag: candidate.key,
        })
      } catch (error) {
        // A rejected constructor means the environment withdrew the
        // Notification API mid-session; nothing else can reach it.
        console.warn('ui-notify: OS notification failed:', error)
      }
    }
    for (const key of this.#armed) {
      if (standing.has(key)) {
        this.#missing.delete(key)
        continue
      }
      const absences = (this.#missing.get(key) ?? 0) + 1
      if (absences >= 2) {
        this.#armed.delete(key)
        this.#missing.delete(key)
      } else {
        this.#missing.set(key, absences)
      }
    }
  }
}

function factsOf(summary: SessionSummary): SessionFacts {
  return {
    ...(summary.pendingInteraction === undefined ? {} : { pending: summary.pendingInteraction }),
    completed: summary.completed === true,
  }
}

/** One dedupe key plus the notification kind that key announces. */
interface KeyedFact {
  key: string
  kind: NotifyEventKind
}

function keysOf(id: SessionId, facts: SessionFacts): KeyedFact[] {
  const keys: KeyedFact[] = []
  if (facts.pending !== undefined) {
    keys.push({ key: `${id}:pending:${facts.pending}`, kind: 'approval-required' })
  }
  if (facts.completed) keys.push({ key: `${id}:completed`, kind: 'turn-completed' })
  return keys
}
