# Agent Note: Issue checks degrade when board automation is unavailable

Status: implemented

English | [中文](2026-08-25-issue-checks-degrade-when-board-unavailable.zh.md)

## Problem

The Issue lifecycle and Issue policy workflows appear as checks on every pull request, and three deployment gaps turned all of them red regardless of the code under review:

- Runs triggered by Dependabot resolve repository secrets to empty values, so `actions/create-github-app-token` rejected the empty `private-key`.
- A GitHub App whose credentials are configured but which is not installed on the repository fails token minting with a 404 from the installation lookup.
- Issue policy's GraphQL reads require Projects v2 access. The workflow's explicit permission list omitted `repository-projects`, and a missing or mismatched Project raised `Could not resolve to a ProjectV2`; either way the check crashed whenever a pull request body referenced one real Issue.

The result was several failing checks per pull request caused by infrastructure state, not by the proposed change.

## Decision

Both checks stay green unless the validation itself fails; every board dependency degrades to a skip.

Issue lifecycle gates token minting off `dependabot[bot]` actors, marks the token step `continue-on-error` so an uninstalled or misconfigured App costs a skipped board update rather than a failed check, and gates the handler on a non-empty minted token.

Issue policy declares `repository-projects: read` so its token can see the Project when one exists. [policy.mjs](../../../../.github/issue-management/policy.mjs) wraps Project reads in `tryProjectContext`, which classifies a missing or mistitled Project, could-not-resolve responses, and missing Projects scope as `{available: false}`. An unreachable Project suspends the Status- and Priority-dependent Issue rules instead of failing every audit, and lifecycle status writes no-op without a reachable board. Title, label, Type, body, and reference rules keep applying.

## Verification

[Issue-management tests](../../../../.github/issue-management/policy.test.mjs) pin that an unavailable Project produces no Issue errors while title and label rules still reject violations, and that snapshots default to tracked. [Workflow tests](../../../../scripts/ci-workflow.spec.ts) pin the Dependabot gate, `continue-on-error`, the token-output gate on the handler, and the `repository-projects` grant.

## Alternatives considered

**Remove the workflows until the App is installed and the Project exists.** The checks disappear into gray skips and the pull-request tag rules stop being enforced, trading a working gate for silence.

**Delete the `TOH_ISSUE_APP_CLIENT_ID` variable.** Green today, but reinstalling the App later reintroduces the same failures until someone remembers this coupling; the workflow now tolerates both states.

**Fail loudly on missing infrastructure.** A red check per pull request is how this problem was found, but it blocks merges on repository configuration that code changes cannot fix.

## Consequences

With the App installed, the Project present, and the permission granted, behavior is unchanged. Until then, pull-request tag and reference validation still runs, Issue Status and Priority audits stay silent, and board transitions skip; the audit comment is not posted for issues it could not fully validate. A misconfigured token step leaves a failed step inside a green job plus an annotation on the run, so the gap stays visible without blocking anyone.
