# Agent Note: Serialize cordis-host-runner stop/undefine against in-flight activation

Status: implemented

English | [中文](2026-08-23-cordis-host-runner-stop-undefine-vs-in-flight-activation.zh.md)

## Problem

In `cordis-host-runner`, neither `undefine` nor `stop` consulted the in-flight activation map (`starting`). A removal landing while a host half was still evaluating left the race to `startFresh`, which assigned `plugin.run` unconditionally after its multi-await window: a live fiber mounted under a registry record that no longer existed. The plugin's tools stayed model-visible and executable while every control surface answered `plugin-missing`, no `cordis/dynamic-retract` was ever emitted, and the only disposal path was killing the process. A symmetric stop variant answered `not-running` during the window and then let the activation mount anyway.

## Decision

Removal verbs now participate in the same transition protocol new runs already follow (`resolvePlan` refusing while starting, `activate` deduplicating through `starting`):

- Every `stop` and `undefine` bumps a per-plugin stop generation; `stop` then joins the in-flight activation promise before retracting the active run.
- `undefine` deletes the registry record before joining, so concurrent verbs observe the removal immediately and an invalidated activation can name removal accurately in its failure.
- `stop` treats an in-flight activation as stoppable rather than answering `not-running`, and scopes teardown to its own generation: a run published after that generation was assigned belongs to its newer activation and survives untouched, so a stop parked inside a slow fiber disposal can neither retract nor mark stopped a run that started meanwhile.
- `startFresh` captures the generation at entry and re-validates ownership after every await before publication. On loss it drops handlers, disposes the host-half fiber, and returns a failure naming what happened ("removed/stopped during activation") instead of publishing.

The public method set, receipts, and wire shapes are unchanged.

## Alternatives considered

**Chain every mutation through a per-plugin FIFO queue.** Rejected: generation capture plus joins provide the same serialization with less machinery; a queue would also park unrelated verbs behind a slow activation.

**Reject the in-flight promise at removal time.** Rejected: aborting mid-evaluation leaks vm and fiber state instead of letting `startHost` settle; one settlement point per run keeps disposal owned by `startFresh`.

**Join without revalidating ownership.** Rejected as the sole guard: a fresh activation can slip into the awaits of a concurrent retract window, so publication needs its own post-await check to close every await window.

## Verification

`tests/runner.spec.ts` parks a gated host half on `tools/change` (arming observed through the package-tagged console) and races it against `undefine` and against `stop`. Both assert the provided service unwound with the discarded fiber, empty inventory, zero announcements, the accurate failure message, and — for stop — that a subsequent normal run still succeeds. A third race parks `stop` inside the old run's async fiber disposal while a second Package of the same plugin runs to completion: the newer run keeps its service, its attempt status, and its handler, and only the old run is retracted. All three fail against the pre-fix source. `tests/loader-composition.spec.ts` boots the runner through a real `cordis.yml` Loader composition with the tool registry and exercises the public run and removal flow end to end. The package suite passes; oxlint and `tsc -b` are clean.

## Consequences

An activation racing a removal can never publish onto a removed or stopped record, so the orphaned-mount dead end is gone and the model sees one actionable failure instead of a phantom running plugin. Stopping during a starting activation now reports success where it previously claimed nothing was running. The cost is O(1) bookkeeping per plugin id for the generation map, reclaimed when the plugin is undefined.
