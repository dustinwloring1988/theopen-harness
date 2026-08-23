# Agent Note: Dormant official DeepSeek provider

Status: implemented

English | [中文](2026-08-21-dormant-official-deepseek-provider.zh.md)

## Problem

The Models page treated the official DeepSeek adapter as permanently pinned: its whole-section profile always counted as configured, the row could never be deleted, and a first-run user with no usable provider was taken over by a credential popup for it. The adapter is shipped composition, but which providers a user runs should be the settings document's business — the same rule the dormant `llm-pi-ai` mount already follows. The popup also duplicated an add flow the page already has.

## Decision

**A stock mount contributes no base content.** `llm-deepseek` registers its settings base as the composition entry minus every field equal to the schema default (`compositionBase` in `src/index.ts`). A field equal to its default resolves identically when omitted, so resolution and adapter behavior are unchanged while the descriptor can distinguish "dormant" from "pinned".

**Presence and removal follow the layers for whole-section providers.** The Models join now computes `configured` for an empty-path entry as "user or base layer carries content", and `removable` as "user layer alone carries it". A route provider's path-based rules are unchanged. Deleting the whole-section provider unsets the section root (the empty path) and, when the page can name the target — for a whole-section provider, whatever its one profile names — the configured writable credential with it.

**Creating the provider materializes the section.** The add flow's deepseek create records the profile's resolved `apiKeyEnv` reference even when only the key is typed, because the write is what turns the dormant directory entry into a row; pi-ai's reference-free native-auth create is unchanged.

**The first-run DeepSeek credential step is removed.** `ui-settings-models` mounts only the internal-testing welcome notice in `settings.onboarding`; `DeepSeekOnboardingDialog`, its readiness projection (`onboardingReadiness`), and the `ProviderEditor` credential-only props had no other consumer and are deleted. This supersedes the credential-step decisions in [shared-modal product onboarding](2026-08-13-shared-modal-product-onboarding.md) and retires [deepseek onboarding credential setup](../../archived/feature/2026-07-30-deepseek-onboarding-credential-setup.md) and [onboarding reads every provider](../../archived/bug-fix/2026-08-12-onboarding-reads-every-provider.md).

## Alternatives considered

**Keep the row always present and only make Delete work.** Rejected: the user asked for the provider not to be pre-added, and a row whose only fact is schema defaults presents nothing actionable.

**Restructure the `llm-deepseek` settings shape to route-keyed profiles.** Rejected for this change: the flat whole-section shape is the adapter's own contract, and layer-content presence achieves the same page semantics without a format break.

**Gate the adapter route registration on configuration.** Rejected: the CLI serves requests from an environment key with zero configuration, and the web picker reads the same live routes; dormancy is a configuration-surface presentation, not a route-liveness fact.

## Consequences

A fresh deployment shows no provider rows on Models; the official DeepSeek route waits in the add select next to the dormant pi-ai catalog, and a stored configuration deletes back to that state. A `cordis.yml` entry that pins a non-default value still renders a pinned, non-removable row. Environment-key users see the adapter only in the add select until a settings write materializes the section — the page manages the settings document and page-stored credentials, not the launch environment. The CLI's out-of-the-box `DEEPSEEK_API_KEY` flow is unaffected: the route registers whenever the plugin mounts.
