# Agent Note: The adapter ships provider routes beside the installed pi-ai catalog

Status: implemented

English | [中文](2026-08-21-shipped-local-provider-routes.zh.md)

## Problem

The configurable-provider directory offered exactly two kinds of route: one the installed pi-ai catalog describes, and one a settings document had already declared. A user running a local Ollama server had no first-class answer. The working path was declaring a custom route by hand — inventing a route id, typing the endpoint, protocol, and model list into the creation card — and the Models page treats picking a known provider and declaring an unknown one as different actions, so a common local setup lived entirely on the manual side of that split.

Nothing was broken: the hand-declared path serves Ollama today. But the picker listing thirty-seven catalog providers could not list the one local server many deployments already run, and which providers a build offers is product surface decided up front, not something a settings document was meant to invent for a well-known case.

## Decision

`SHIPPED_ROUTES` in `toh-llm-pi-ai` names the routes this adapter offers beyond the installed catalog. Today it holds one entry: `ollama`, displayed as "Ollama (Local)". `directoryEntries()` places shipped routes after the catalog ids and before profile-declared routes, carrying `declared: true`: pi-ai has no entry under the key, so the route keeps needing the facts only configuration can supply — protocol and models — through the editor card any hand-declared route gets, including endpoint interrogation, which lists a local server's models from `/v1/models` without a credential.

The entry also carries what a configuration surface prefills while nothing is stored: an endpoint suggestion (`http://host.docker.internal:11434/v1`, so both a browser served from this machine and one served from a container on the same host reach the server) riding the directory contract as an optional `baseURL` on `LlmConfigurableProvider`. The Models page's add card had a second gap this exposed: it never forwarded the directory's `declared` answer to its editor card, so adopting a declared route rendered the catalog-style card with no identity fields at all. The card now forwards it, and an adoption starts where the create card starts — declaration fields unfolded, first wire protocol preselected, suggested endpoint in place, every one of them editable.

Resolution participates in one half of the decision: a profile that stores no `displayName` defaults to the shipped label before falling back to the route key, so the option the picker offered stays "Ollama (Local)" after adoption instead of relapsing to the bare id. A key the installed catalog also describes never reaches the map's consumers — catalog membership remains the single answer for what pi-ai carries — and an explicit `displayName` in the profile wins over the shipped label everywhere. Adopted models default their displayed name to their id, on the card and in every selector, because a local listing discloses ids and nothing else; the name field shows that fallback rather than reading as missing.

No credential ships with the route. A local Ollama authenticates nothing, and the harness's own api-key method resolves to an unsigned request when no reference is configured — the same posture endpoint interrogation uses — so leaving the key field blank yields a working provider rather than a deferred failure.

## Alternatives considered

- **Adding Ollama to pi-ai's builtin providers upstream.** This would make it a true catalog route whose endpoint, protocol, and models all default from the installed entry. It lost because a catalog entry must carry a model catalog — ids, context windows, output caps — and a local-model roster changes with every pull, so the metadata would be stale on arrival and somebody would have to maintain it forever. This adapter needs only the offer and the settings address; the user's own server is the authoritative model list.
- **Defaulting the route's `baseURL` in resolution** so a profile could omit the field entirely. That would let a half-finished profile register a route aimed at whatever address the label suggested; instead the suggestion lives one layer up, prefilled but editable, and an adoption that skips it is still refused where it is written.
- **A generic hints mechanism on `LlmConfigurableProvider`** letting a directory entry carry arbitrary editor defaults. The optional `baseURL` is the one field with a consumer today; widening the contract further waits for a second one.
- **Storing `name: <id>` on adopted model rows.** The display fallback needs no storage: resolution already names an unnamed model by its id, so the card shows the fallback and the profile stays free of restated data.

## Consequences

The provider picker gains one dormant option that costs nothing while unused: no profile means no registered route, `providerUsable()` stays false, and the first-run postures other snapshots pin are unchanged. Adopting the option is now a short path — pick it, fetch the model list from the prefilled endpoint, adopt rows, apply — and saving is validated by the section schema like any other hand-declared route. The display-name default resolves profile → shipped label → route key, a three-step order any future shipped route inherits for free.

One vocabulary cost is accepted: `declared` now answers "pi-ai ships nothing under this key" for a route the *adapter* does offer, so the row shows the custom tag after adoption. That is accurate — the profile really does carry everything about the route — and the alternative would be a third flag for a distinction no consumer asked for.

## Testing

Package tests pin the directory entry (present, `declared: true`, shipped label, suggested endpoint), the label surviving a profile stored without `displayName`, and the resolution-level fallback beside the existing route-key default. Client tests drive the whole adoption from the picker — fold unfolded with protocol and endpoint prefilled, interrogation against the draft, keyless profile stored as three path ops — plus the folded stored-route posture and the id-as-display-name fallback on unnamed rows. The web e2e goldens record the assembled application: the two pickers list the option as "Ollama (Local)", and the declared-route editor golden shows an unnamed model row displaying its id.
