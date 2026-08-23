# Agent Note: A turn-budget policy on the existing stop boundary

Status: implemented

English | [中文](2026-08-23-turn-budget-policy.zh.md)

## Problem

Nothing bounds a single agent turn. Tool calls and steering continue the current turn indefinitely, and the agent loop documents this as a known non-feature: a policy that bounds runaway turns must cancel from an existing lifecycle extension point. The exposure concentrates headless — `pnpm toh --profile headless` one-shots, the ACP server, SDK `run()` consumers, and tool-ralph rounds run unattended, so one stuck turn burns tokens until something external kills the process. The one behavioral guard in this space, repeat-tool-reminder, escalates only on *identical* consecutive calls and resets on user interjection; a model that varies its loop evades it entirely. Repo-wide, only the Claude Code and Codex hook bridges listen on `agent/turn-stopping`, and neither bounds anything.

## Decision

- **A new opt-in guard package, `@buckeyestudio/toh-turn-budget-policy`, owns turn budgets.** It registers one serial `agent/turn-stopping` listener plus one delegating `agent/pre-step` bookkeeping listener, and changes nothing inside `packages/core/agent-loop`. The shipped base bundle mounts it disabled (`disabled: true`, following skill-badge); enabling it is an explicit overlay row with limits.
- **Two-stage escalation, advisory-first like the guard family.** Past `warnAtSteps` at a closing attempt, the policy steers exactly one wrap-up request per turn (`agent.steer(...)` with a `notice`-form plugin source), giving the model one bounded chance to land the turn. At a hard limit — `maxStepsPerTurn` or `maxTurnTokens` — it calls `agent.cancel({ kind: 'hook', reason }, { keepInbox: true })`, preserving queued inbox work for later turns.
- **State derives from authoritative sources only.** Step counts fold logged `step/start` records since the last `turn/start`; token spend is the `ctx.tokenMeter.measure(session).totalTokens` delta from a baseline snapshotted at the turn's first pre-step. State lives in a per-agent `WeakMap` keyed by turn number, so every new turn starts from zero and disposal cleans up without listeners.
- **Configuration fails loud at load**: no limits configured, a non-positive or fractional value, `warnAtSteps >= maxStepsPerTurn`, or `maxTurnTokens` without the token-meter service all throw during plugin load.
- **The durable log proves the ordering contract.** The package invariant companion asserts, over the session-event stream, that wrap-up notices appear at most once per open turn and never outside one — so any hook-cancelled close of that turn was preceded by its advisory.

## Alternatives considered

- **A max-step counter inside the agent loop** — enforcement would also cover turns that never attempt to close, but it edits the loop's state machine for what a guard can express; the loop README names `agent/turn-stopping` as the intended home, and loop changes additionally require architecture-doc surgery and both SDKs' projected outputs. Rejected to keep the loop unchanged.
- **Cancelling from a tools/post-execute listener** — fires mid-run even without closing attempts, but it confuses per-call hygiene with turn lifecycle, cannot see total turn spend cleanly, and races the tool waterfall's decision semantics. Rejected.
- **Wall-clock budgets** — a slow model is not a looping model; request- and tool-level timeouts already own latency. Rejected as a separate axis this policy should not duplicate.

## Consequences

Enforcement happens at closing attempts only: a turn whose every step ends in further tool calls reaches no boundary mid-run, so a model streaming tool calls forever without ever attempting to close stays unbounded until the provider or transport fails. This residual gap is accepted because bounding it requires loop changes, and real runaway exposure (hook-forced continuations, wrap-up-dodging models) funnels through exactly those closing attempts. Token deltas inherit the meter's heuristic anchor when providers omit usage reports, so `maxTurnTokens` can drift from exact billing in either direction. What was bought: headless deployments get a validated, composition-owned ceiling; the model keeps one genuine chance to finish; queued work survives hard cancels; and the session log alone proves notices preceded cancels.

## Testing

Package unit tests drive the policy through a real agent loop against a scripted mock adapter: cancel ordering, single-steer latch, per-turn reset, mocked-meter token trips, and loud config validation; the invariant suite rejects double and orphaned notices through `Session.append`. The keyless ACP snapshot scenario `turn-budget-policy` replays a scripted five-step transcript through the assembled example composition and pins the advisory notice, the forced step, and the `aborted`/`hook` close in transcript and log.
