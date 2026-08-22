# Agent Note: One harness home resolver

Status: implemented

English | [中文](2026-07-24-single-harness-home-resolver.zh.md)

## Problem

The harness had two inconsistent conventions for "where does TheOpen Harness user data live":

- `@buckeyestudio/toh-home` resolved `configured ?? $TOH_HOME ?? ~/.toh`.
- `@buckeyestudio/toh-home-paths` shipped a **second** `resolveDshHome` with the same precedence plus tilde expansion — a near-duplicate of `toh-home` that no gate flagged because the two lived in different packages and had already drifted (only one expanded tildes).

Two resolvers for the same cross-cutting fact meant there was no single home policy.

## Decision

One resolver owns the harness home, in `@buckeyestudio/toh-home-paths`, single-root:

```
explicit configured path  >  $TOH_HOME  >  ~/.toh
```

An empty or whitespace-only `$TOH_HOME` is treated as unset; otherwise `resolve('')` would silently place the home at the current working directory. The harness keeps all user data under one root; there is no XDG config/data/cache split. `tohHomePath(...segments)` joins deployment-owned children onto that root, and `toh-app-boot` exposes it to Loader `!!js` config expressions before mounting entries, so shipped compositions derive `sessions` and `storages` without copying the resolver. `tohHomeDisplay()` names a resolved root symbolically for user-facing paths — `~/.toh` for the default home, `$TOH_HOME` for any configured home — so the user-global `AGENTS.md` label never leaks an absolute machine path. It replaces agent-instructions's bespoke default-vs-`$TOH_HOME` check.

`@buckeyestudio/toh-home` is deleted. Its three importers (`toh-tool-bash`, `toh-skill-filesystem`, `toh-agent-spine-demo`) import `resolveDshHome` from `toh-home-paths`.

`toh-telemetry` and its separate home policy are absent under the [SDK project toolchain removal](../simplification/2026-08-11-remove-sdk-project-toolchain.md), leaving this resolver as the sole home policy.

## Alternatives considered

**Leave the two `resolveDshHome` copies in place.** They had already drifted (one expands tildes, one didn't) and encode the same cross-cutting fact twice. Consolidation is the point of the `util/` layer; a duplicate resolver is a latent divergence bug.

**Adopt XDG (honor `$XDG_CONFIG_HOME`, or split config/data/cache into separate trees).** Considered and dropped in favor of one obvious root. A single `$TOH_HOME || ~/.toh` ground truth matches `~/.claude` / `~/.aws`, needs no per-kind reclassification of every `~/.toh` consumer, and leaves no resolver asymmetry to reconcile.

## Consequences

- One home fact, one resolver. `toh-home-paths` is the sole owner; the `util/` group loses the `home` package.
