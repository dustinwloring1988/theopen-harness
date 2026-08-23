# Agent Note: Turn completion and blocked approvals as OS notifications

Status: implemented

English | [中文](2026-08-23-turn-notifications.zh.md)

## Problem

Long agent turns are the norm, and a user who switches tabs or windows learns that a turn finished — or worse, that the agent has been blocked waiting on an approval — only by coming back and spotting a small sidebar dot. A blocked agent silently burns wall-clock time while the human does something else. The wire already carried every fact needed (whole-agent `running`/`idle` transitions, pending approval/question requests), the client runtime already aggregated them into the sessions list, but nothing raised them outside the page; the Web Notifications API was unused anywhere in `packages/client`.

## Decision

`packages/client/ui-notify` (`@buckeyestudio/toh-client-ui-notify`) is a pure-chrome client plugin composed as the `ui-notify` row of the web-app bundle. Its browser half watches `ctx.sessions.list` — the same aggregated snapshot the sidebar rows render — and raises OS notifications for two edges: a session's `completed` reminder appearing (turn finished while unviewed) and a `pendingInteraction` appearing (approval / plan review / question blocking an agent). It works unchanged in the Electron renderer because the renderer is an ordinary browser over HTTP+SSE.

Three rules govern when a toast actually fires, all decided by one pure gate (`shouldNotify`) so the logic tests headlessly:

- **Ask-on-first-event permission flow.** The default durable mode is `ask`. The browser permission prompt fires on the first pass carrying a genuinely new event after load — never at boot, and never from a baseline world the page opened into. A grant behaves like `on`; a denial degrades silently to the in-page dots.
- **State-derived dedupe with reconnect hysteresis.** Dedupe keys are derived from live state (`<session>:pending:<status>`, `<session>:completed`) and stay armed while the fact stands, so snapshot replays cannot re-fire. A key disarms only after its fact has been absent for two consecutive passes: one absence is exactly what a reconnect generation looks like (the manager clears and replays still-pending interactions), so a replayed wait never produces a phantom repeat toast. The OS `tag` carries the same key.
- **Focus and quiet-hour suppression.** A focused document suppresses by default (the user is looking at the product's own warning dots). Quiet hours (`quietFrom`/`quietTo`, "HH:MM", schema-validated, midnight-wrapping) suppress everything, approvals included, following local wall-clock time.

The first pass of any watcher records standing facts without notifying (the SessionManager completed-reminder precedent): a page reloading into an already-blocked world neither prompts nor toasts. Settings live in the `ui-notify` namespace registered by the plugin's node half, edited through the General-section row this package also registers (`settings.general.item`, id `notifications`). The row publishes gestures locally before the durable write settles, so memory-mode compositions see the choice this session. Nothing here reaches a model request or the session log.

The same change fixes the in-page companion gap: ui-workspace group headers now carry a warning dot with a localized waiting-count while folded, counted across every visible member regardless of expansion.

## Alternatives considered

- **Subscribing to forwarded remote events via `ctx.remote.$on`, as the issue suggested** — rejected: no idle-transition or pending-interaction signal exists in the forwarded-event allowlist; status flips ride `host/session-status` frames and approvals ride answerable mux frames, both owned by the runtime's connection loop ("no consumer reads a frame"). The sessions list snapshot is the sanctioned aggregate of exactly these facts, needs zero runtime changes, and keeps the plugin read-only.
- **Requesting `Notification.permission` at plugin load** — rejected: it interrupts every fresh visit before the harness has anything to say, and browsers increasingly dismiss prompts not tied to a meaningful moment.
- **Per-session notification toggles** — deferred: suppression is global (mode + quiet hours); per-session choice needs its own settings-surface design and was not required to unblock the wall-clock waste this note addresses.
- **Raising approval toasts even inside quiet hours** — rejected for symmetry: the sidebar dots remain the escalation path while quiet, and users who want always-on approvals can set mode `on` outside their window.

## Consequences

- Turn completion and blocked approvals are now visible outside the tab, closing the silent wall-clock burn; the collapsed-group indicator closes the in-page half of the same gap, and ui-workspace's README drops the limitation.
- A denied permission is final until site settings change; there is no in-product re-ask, by browser contract.
- The cold-boot RPC budget is untouched: the scope derives from ui-settings' shared describe mirror, adding no wire reads.
- Verification: pure-gate and controller specs cover the decision matrix, edges, dedupe arcs, hysteresis, and the permission handshake; the apply spec pins registration/adoption/gesture wiring; `apps/web/tests/settings-chrome.e2e.ts` goldens cover the new General row on the assembled surface.
