# Agent Note: Collapse the session-title model plugins into one cadence-configured package

Status: implemented

English | [中文](2026-08-23-collapse-session-title-model-plugins.zh.md)

## Problem

Two whole plugin packages implemented session-title LLM providers whose registrations differed only by one cadence literal and a trivial message selector: `@buckeyestudio/toh-session-title-first-prompt-llm` selected the first eligible human message at the `first-prompt` cadence, and `@buckeyestudio/toh-session-title-all-prompts-llm` passed every eligible message through at `all-prompts`. The split cost byte-identical `Config` blocks that each required a jscpd suppression, plus duplicate manifests, invariant companions, README pairs, and test suites.

The `all-prompts` twin also had zero consumers: no bundle, example, app, or Python runtime closure composed it — only its own manifest named it. Meanwhile the title service already owned the cadence vocabulary as a closed union (`SessionTitleAutomaticMode = 'first-prompt' | 'all-prompts'`), so the extra packages added surface without adding behavior any deployment could reach.

## Decision

One package, [`@buckeyestudio/toh-session-title-llm`](../../../../packages/session/session-title-llm), owns the model-backed title provider. It exports the standard plugin surface (`name`/`inject`/`Config`/`apply`) alongside the shared request policy it already carried, and both twin packages are deleted. Its required and validated `cadence: 'first-prompt' | 'all-prompts'` config field selects the message selector; an invalid value or unknown key fails loudly during loading. Both behaviors stay user-selectable from cordis.yml, and shipped composition (`bundle/base`) keeps the `first-prompt` cadence with unchanged limits.

The registered provider id stays derived from the configured cadence (`session-title-first-prompt-llm` / `session-title-all-prompts-llm`), so durable title sources, auxiliary request records, and recorded provenance keep naming the exact selection behavior that produced them across this repackaging. The jscpd suppressions die with the duplicated schema block; the remaining `Config` is the shared schema object itself.

This change updates the facts in the owning [log-backed session titles decision](../feature/2026-07-21-log-backed-session-titles.md) but does not alter that decision; the service, event vocabulary, fallback, and timing contracts are untouched.

## Verification

Package tests cover both cadences through the real provider registration (selection, provenance ids, seeded history, route inheritance), direct-construction validation rejects an invalid cadence, and a Loader composition test boots the plugin from cordis.yml and proves an unsupported cadence fails loudly during loading. The keyless assembled snapshots replay unchanged because the derived provenance ids are stable.

## Alternatives considered

**Delete only the unconsumed twin and keep first-prompt as-is.** Rejected because it removes the duplication but surrenders the `all-prompts` behavior entirely, contradicting the service's own closed cadence union, which would then name an unreachable mode.

**Keep two thin plugins over the shared helper.** Rejected because it preserves the identical Config blocks, twin manifests, invariant companions, and README/test suites whose only purpose was to carry one literal each.

**Rename the surviving twin to a neutral plugin name.** Rejected because the shared policy package already exists under the accurate name and would otherwise remain a helper with exactly one consumer; folding the plugin into it deletes a package instead of renaming two.

## Consequences

Deployments configure one plugin row (`cadence` plus the existing limits) instead of choosing between two package names; misconfigured cadences fail at load rather than resolving silently. The repository carries one fewer package family member, no jscpd suppressions in this area, and one invariant companion, README pair, and test suite where three existed. A future cadence joins as a new union member with its selector case rather than a new package.
