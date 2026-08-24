# @buckeyestudio/toh-turn-budget-policy

English | [中文](README.zh.md)

A runaway-turn budget policy, not a loop change: it rides exactly the documented `agent/turn-stopping` extension point and adds two behaviors — at a configured advisory step count it steers one wrap-up request so the model gets exactly one bounded chance to land its turn, and past a hard step or token limit it cancels the turn with a `hook` cause. Headless automation (`pnpm toh --profile headless`, the ACP server, SDK `run()` consumers, tool-ralph rounds) otherwise lets tool calls and steering continue a single turn indefinitely; this policy makes the ceiling a validated composition choice instead of an external kill switch. The agent-loop's own non-feature note ([agent-loop README](../../core/agent-loop/README.md)) names this extension point as the intended home for such a policy.

## Config

```yaml
- id: turn-budget-policy
  name: '@buckeyestudio/toh-turn-budget-policy'
  config:
    warnAtSteps: 20        # advisory: steer one wrap-up request at this step count
    maxStepsPerTurn: 24    # hard: cancel the turn at this step count
    maxTurnTokens: 200000  # hard: cancel when per-turn token spend reaches this
```

Configuration fails loud at plugin load: an empty config throws, every present value must be an integer >= 1, and `warnAtSteps` must stay strictly below `maxStepsPerTurn` when both are set (the advisory must precede the cancel). There are no defaults: every limit is a deployment choice, which is why the shipped bundle row is disabled by default. Per-agent overrides mount the plugin on the agent's scoped context with different limits — each registration owns its listeners and never observes another agent's.

## Enforcement point

`agent/turn-stopping` runs before an *otherwise completed* turn closes: the model made no live tool calls and no fresh steering waits. A turn whose steps all end in further tool calls never attempts to close, and therefore never reaches the boundary mid-run; enforcement lands on every closing attempt, which is where a runaway turn actually ends up — either the model finally tries to stop, or a Stop-hook bridge keeps forcing continuations through the same boundary. Bounding the closing attempts bounds the turn; the residual gap (a model that streams tool calls forever without ever attempting to close) is a known limitation.

- **Step counting folds the session log.** At each closing attempt the listener counts logged `step/start` records since the most recent `turn/start`, so the count reflects exactly what the durable log shows for the open turn — including steps forced by earlier steering.
- **Token spend sums each request's reported usage.** At each closing attempt the listener folds the open turn's logged `assistant/message` records and adds up every request's disjoint usage buckets (`inputTokens` plus cache-read, cache-write, and output), so repeated requests each contribute their full input and output cost rather than a shared-surface delta.
- **Hard limit → cancel.** `agent.cancel({ kind: 'hook', reason }, { keepInbox: true })` aborts the active turn while preserving queued and steering inbox items; the durable `turn/end` records reason `aborted`/`hook` with the observed numbers in the reason string.
- **Soft limit → one steer per turn.** At or past `warnAtSteps`, the policy calls `agent.steer(...)` once per turn; the machine re-reads its inbox and runs another step. A latch keyed by turn id guarantees the second closing attempt is never steered again, and closing attempts between the advisory and the hard limit still pass through un-steered — with `warnAtSteps: 3` and `maxStepsPerTurn: 6`, a later closing attempt at step 4 closes normally — until one lands at or past the hard limit.
- **Per-turn reset.** State is keyed by live agent object and turn number: a follow-up turn starts from zero steps and a cleared steer latch. A cancelled turn does not poison the next one.

## Reminder delivery

The wrap-up notice travels as ordinary steering: an injected `user/message` with source `{kind: 'plugin', plugin: 'turn-budget-policy', form: 'notice'}`, rendered as a plain synthetic user message — model-visible, source-attributed, and reconstructable from the session log with no new session event. The cancellation itself is not model-visible context: the turn simply closes as `aborted`.

## Model Experience

### Wrap-up advisory context message

#### What the model sees

At the first configured closing attempt at or past `warnAtSteps`, that agent receives the steering message below, naming the turn's actual step count. No tool schema or normal-request text is added.

##### Wrap-up notice

```markdown
Turn budget advisory: this turn has already run <steps> steps. Wrap the turn up now: give your best available answer instead of starting more tool calls. If the task genuinely cannot progress without more work, say what is blocking it and stop.
```

#### Token effect

Zero tokens before the advisory fires. The notice is retained history for that agent, capped by `<steps>` being a small integer; the cancellation adds nothing.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Closing attempts only** — a turn that never stops streaming tool calls never reaches `agent/turn-stopping`, so neither arm can fire until the model attempts to close; bounding those mid-run turns would require a loop change, which this policy deliberately avoids.
- **Unreported usage is invisible** — a request whose adapter reports no `usage` contributes nothing to `maxTurnTokens`, so a turn served entirely by such providers never trips the token arm (the step arm still bounds it when `maxStepsPerTurn` is configured; a token-only configuration leaves it unbounded).
- **No wall-clock limit** — a slow (as opposed to looping) model is out of scope; timeouts belong to the request/tool layers.
- **Advisory is skippable** — the wrap-up steer is a request, not a veto; a model may ignore it once, which is exactly what the hard limit then enforces.
