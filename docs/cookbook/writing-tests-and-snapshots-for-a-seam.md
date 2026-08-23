# Writing Tests And Snapshots For A Capability Seam

English | [中文](writing-tests-and-snapshots-for-a-seam.zh.md)

How to prove a new or changed [capability seam](../glossary.md#capability-seam) works as shipped: pick coverage tiers, boot real compositions, add the keyless snapshot scenario, run the lane locally, and review the diffs. Policy lives in [testing.md](../testing.md); this recipe is the walkthrough. `packages/shell` (Service Definition `toh-shell`, providers `toh-bash-local`/`toh-bash-sandbox`, Consumer `toh-tool-bash`) is the reference template.

## 1. Name the tiers before implementing

Every non-trivial model-, protocol-, or human-visible change plans its coverage up front; a seam typically needs all three tiers:

| Tier | Proves | Typical subject |
|---|---|---|
| Unit | contract logic, edge cases, event ordering | Service Definition vocabulary, provider behavior |
| Real composition | the plugin boots through the real Loader and answers over its service | test-only `cordis.yml` + app/process |
| Snapshot | the assembled transcript, wire output, or persisted log stays as intended | runnable example through the owning suite |

Registry contributions additionally require the HMR-safety proof: dispose the contributing fiber and observe removal.

## 2. Write the unit layer beside the code

Tests live in the owning package under `tests/`. Cover error paths, cancellation, concurrency races, and boundary values; mock only the expensive or nondeterministic boundary (model, network, clock) and keep everything downstream real. A guard or policy plugin only counts if a regression actually fails it: introduce the regression, watch red, revert.

## 3. Boot a real composition

Hand-built `ctx.plugin(...)` suites are insufficient for product-visible plugins. Mount a test-only `cordis.yml` through the Loader in an app or process, mock only external services, and assert model-visible request/log content, durable state, or user-visible output. Reuse the shared kits instead of rebuilding them: [`toh-acp-snapshot`](../../packages/test-support/acp-snapshot/README.md) (scenario factory), [`toh-loader-smoke`](../../packages/test-support/loader-smoke/README.md) (real-Loader smokes), and [`toh-agent-loop-testkit`](../../packages/test-support/agent-loop-testkit/README.md) (loop prerequisites).

## 4. Add the keyless snapshot scenario

Route the scenario to the suite that owns its surface:

| Surface | Owning snapshots |
|---|---|
| ACP automation scenarios | `examples/<name>/tests/snapshots/` over the [`toh-acp-snapshot`](../../packages/test-support/acp-snapshot/README.md) factory (`examples/acp-agent` primary) |
| Headless canonical-event transcripts | `examples/headless-agent` (JSONL driver + replay fixtures) |
| Completed interactive-terminal journeys | `apps/cli/tests/snapshots/` (JSONL-driven scenarios) |
| Browser-rendered Web GUI journeys | `apps/web/tests/snapshots/` |
| TypeScript SDK loop projection | `examples/jsonrpc-agent/tests/snapshots/` |
| Python SDK loop projection | `scripts/snapshots/python-sdk-single-exe/` (runs in the required `python-runtime` CI job) |

One ACP scenario (`text-turn`) pins full system-prompt/tool-schema content; other fixtures tokenize it so an edit churns one line. Transient presentation uses the package-local semantic matrix; add a PTY case whenever input handling, Loader selection, or terminal teardown changes. Both SDKs project the loop independently, so loop, session-lifecycle, and `SessionEventMap` changes update both suites in the same PR.

## 5. Run the lane locally, filtered

Snapshots are keyless — no API key needed. Filter to your scenario while iterating:

```sh
pnpm exec vitest run --config vitest.snapshot.config.ts -t <scenario-name>
pnpm run test:snapshot            # full lane before push
```

PowerShell has no env-prefix form; set the variable explicitly when calling vitest directly:

```powershell
$env:TOH_SNAPSHOT = 'record'
pnpm exec vitest run --config vitest.snapshot.config.ts -t <scenario-name> --update
Remove-Item Env:TOH_SNAPSHOT
```

Scenarios that need a real `pwsh` (such as `pwsh-tool-turn`) self-skip on hosts without one; CI enforces them.

## 6. Record and review

Use `pnpm run test:snapshot:record` when the model transcript intentionally changed and `pnpm run test:snapshot:refresh` when replay input remains valid but expected output moved. Review every JSONL and expected-output diff — the snapshot is the product contract. Fixtures must replay on macOS/Linux: fix fixtures, not normalizers.

## Verify checklist

1. Unit tests cover the contract edges and the HMR disposer.
2. A real composition test boots the seam through the Loader.
3. The keyless scenario exists in the surface's owning suite and replays green locally, filtered and full.
4. Recorded diffs were reviewed line by line, including re-persisted logs.
