# @buckeyestudio/toh-client-ui-notify

English | [中文](README.zh.md)

Turn-notification plugin: OS notifications for the two states a user misses after switching tabs — a finished turn and an agent blocked on an approval — plus the preference row that governs them. The plugin is pure chrome: nothing here reaches a model request, session log, or token count.

The browser half subscribes to the sessions list snapshot (`ctx.sessions.list`), the same aggregated authority the sidebar rows render, instead of raw wire frames: each summary already carries `running`, `pendingInteraction`, and the finished-but-unviewed `completed` bit. A pass derives edges against the previous snapshot — a pending interaction appearing, or `completed` becoming true — and routes each candidate through a pure decision gate (`shouldNotify`) over four facts: durable mode, document focus, quiet window, and Notification permission. Because decisions read state rather than frames, reconnect baselines, snapshot replays, and multi-tab echoes cannot manufacture phantom events.

Deduplication keys are derived from live state (`<session>:pending:<status>` / `<session>:completed`) and stay armed while the fact stands: one arc raises at most one toast per page. A key disarms only after its fact has been absent for two consecutive passes — one absence is exactly what a reconnect generation looks like — so the next genuinely new approval or completion notifies again without snapshot replays re-firing the old arc. The OS `tag` carries the same key, so the platform also replaces same-arc toasts. While the document has focus, notifications are suppressed by default — the user is already looking at the product's own warning dots.

Permission follows an ask-on-first-event flow: the default mode is `ask`, and the browser prompt fires on the first qualifying event after load — never at boot, when no event has earned an interruption. After a grant the mode behaves as `on`; a denial degrades silently to the in-page indicators.

## Settings surface

The General-section row (id `notifications`) owns the durable `ui-notify` namespace: `mode` (`ask`/`on`/`off`, default `ask`), and the optional quiet window `quietFrom`/`quietTo` ("HH:MM" 24-hour, schema-validated; either bound empty disables it). Quiet hours suppress every notification — including approvals — following the device's local wall clock; windows may wrap midnight. The row publishes gestures to its store immediately, so memory-mode compositions still see the choice this session, while the Host document write settles underneath.

## Model Experience

None, as notifications are browser chrome; nothing here enters a model request.

#### KV Cache effect

None; no history-tail mutation.

## Known Limitations and Deferred Work

- **A denial is final until the site settings change** — browsers expose no in-product re-ask; after a denial the plugin stops prompting and the sidebar dots remain the only signal.
- **No per-session toggles** — suppression is global (mode + quiet hours); choosing which individual sessions may interrupt is deferred.
