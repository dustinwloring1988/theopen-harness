# Agent Note: The two provider selections a discovered .env may set

Status: implemented

English | [中文](2026-08-23-file-settable-provider-selections.zh.md)

## Problem

The [configuration-source-ownership decision](2026-08-04-configuration-source-ownership.md) denies the whole `TOH_*` namespace to discovered files, and a rejected launch is how the denial takes effect. The web seam documents `TOH_WEB_SEARCH_PROVIDER` / `TOH_WEB_FETCH_PROVIDER` as resolvable through the layered launch-environment snapshot with project/user `.env` participation ([issue #52](https://github.com/dustinwloring1988/theopen-harness/issues/52)), which places two documented names inside the denied namespace: following the documented path aborts the launch with a diagnostic naming the variable instead of selecting the requested provider.

## Decision

`loadLayeredEnv` accepts exactly those two names from either discovered file, case-insensitively; every other rule in the owning decision stands. They qualify because each selects among web providers the mounted composition already registered: a checkout may choose which registered search or fetch provider handles its calls, while remaining unable to add one, re-point its endpoint, alter approval policy, or change how the process launches, where instructions load from, or how the network is reached. The exception is exact-name, so a new `TOH_*` switch stays denied until a change argues its own case.

## Alternatives considered

**Keep the denial and document shell-export-only for these names.** Rejected: it abandons the issue #52 resolution, leaves the web package README's `.env` claim false, and keeps an operational selection out of the place users keep per-project preferences.

**Audit an allowlist of `TOH_*` switches generally.** Rejected for the owning note's reason: the list would need re-auditing on every new switch and forgetting fails silently. Two exact names tied to one consumer contract avoid both failure modes.

**Rank bootstrap-only names below the process layer instead of rejecting them.** Already rejected by the [owning decision](2026-08-04-configuration-source-ownership.md): a value the user believes applies must not be silently ignored.

## Consequences

- A project or Harness-home `.env` selecting `TOH_WEB_SEARCH_PROVIDER` / `TOH_WEB_FETCH_PROVIDER` resolves through the frozen snapshot with layer attribution, materializes into `process.env`, and ranks below explicit `searchProvider` / `fetchProvider` config.
- Any other `TOH_*`, `XDG_*`, `DYLD_*`, or `BASH_FUNC_*` name in either file still aborts the launch before anything is applied; tests pin acceptance with layer attribution and rejection of unrelated switches.
