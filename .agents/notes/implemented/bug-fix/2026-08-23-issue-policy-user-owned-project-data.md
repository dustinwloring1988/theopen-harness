# Agent Note: Issue policy reads Project data from user-owned repositories

Status: implemented

English | [中文](2026-08-23-issue-policy-user-owned-project-data.zh.md)

## Problem

The Issue policy and lifecycle scripts assumed an organization-owned repository. They read Priority from the `issue-field-values` REST endpoint, which exists only for organizations with the issue-fields feature, and addressed the Project through the GraphQL `organization(login:)` root. On dustinwloring1988/theopen-harness, a personal repository, both calls fail: every pull request whose body references an Issue crashed the Issue policy check on a 404 before any validation result was produced. Reference resolution also treated every API error as fatal, so a reference to a nonexistent Issue number aborted the whole check instead of reporting it.

## Decision

`policy.mjs` resolves the owner kind once per process through `GET /repos/{owner}/{repo}` (`owner.type`) and selects the Projects v2 container from it: `user(login:)` for user accounts, `organization(login:)` for organizations, while `repository(owner:)` accepts either login. Status and Priority are read exclusively from the project item's `fieldValueByName` selections, with Priority keyed by the configured `priorityField` name; the org-only REST endpoint is gone. `api()` attaches the HTTP status to its errors, and reference resolution tolerates exactly 404: an unresolvable number stays out of the resolved map yet remains in the parsed reference list, so `validatePullRequest` reports the standard `#N 不是同仓库 Issue` error while lifecycle transitions select only resolved Issues. Every other failure keeps failing loud.

## Alternatives considered

**Fall back to GraphQL only after the REST endpoint returns 404.** Rejected because the endpoint duplicates single-select values the project item already carries, so keeping it adds a request and a fallback branch to every snapshot for data one GraphQL query supplies.

**Select both GraphQL roots and pick the populated one.** Rejected because choosing between them still requires the owner type first; once it is known, interpolating the container keyword keeps one query shape instead of two roots with duplicated selections.

**Treat every reference-resolution error as unreadable.** Rejected because network or permission outages would surface as misleading `#N 不是同仓库 Issue` validation errors instead of failing the workflow loudly; only 404 establishes that the target does not resolve.

## Verification

`pnpm run test:issue-management` passes, including a new test pinning that unresolved reference numbers produce the `#N 不是同仓库 Issue` validation error through the snapshot-to-validation flow, and `node --check policy.mjs` passes. The user-container and owner-kind resolution paths run in the repository's own Issue policy workflow. The lifecycle script supports the same owner-aware Project access, but its workflow remains blocked until the GitHub App is installed on this repository with Issues and Projects write permission, or `TOH_ISSUE_APP_CLIENT_ID` is cleared so the gated steps keep skipping.

## Consequences

Issue policy checks work on this personal repository and organization deployments keep their previous behavior; lifecycle board automation starts once that App-installation prerequisite is met. Priority now reflects the Project board's single-select rather than the retired issue-fields feature, and each referenced Issue costs one shared GraphQL call instead of an extra REST call. Deployments relying on issue-field values diverging from Project values are no longer supported.
