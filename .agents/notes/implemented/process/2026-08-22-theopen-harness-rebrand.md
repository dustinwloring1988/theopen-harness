# Agent Note: Rebrand DeepSeek Harness to TheOpen Harness

Status: implemented

English | [中文](2026-08-22-theopen-harness-rebrand.zh.md)

## Problem

The project carried DeepSeek product branding everywhere while shipping more than one LLM provider: the npm scope `@deepseek-ai`, the `dsh` CLI/bin prefix, ~250 `DSH_*` environment variables, the `~/.dsh` home directory, Python distribution names, and thousands of prose mentions. The name described the original model vendor, not the product, and blocked a neutral home for the harness now that the DeepSeek provider is one option among several.

## Decision

Rebrand to TheOpen Harness in one atomic change. The mapping:

- Product name "DeepSeek Harness" → "TheOpen Harness"; repo slug → `dustinwloring1988/theopen-harness`.
- npm scope `@deepseek-ai/*` → `@buckeyestudio/*`; package prefix `dsh-*` → `toh-*`; first-party manifests declare `"author": "buckeyestudio"` (vendored packages keep upstream authorship).
- CLI bin and root script `dsh` → `toh`; env prefix `DSH_*` → `TOH_*`; home directory `~/.dsh` → `~/.toh`; release family id `toh`.
- Python distributions `theopen-harness-sdk` / `theopen-harness-runtime-bin`, import modules `theopen_harness` / `theopen_harness_runtime`, wire identity `theopen-harness-sdk-runtime`.

The DeepSeek provider stays under its own names: `@buckeyestudio/toh-llm-deepseek`, `web-search-deepseek`, `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, and DeepSeek model ids are unchanged. Archived Agent Notes stay frozen with their original filenames, including `dsh-*` paths.

## Alternatives considered

Keeping the DeepSeek brand was rejected because it names a vendor, not the product, and misleads once other providers are first-class. A compatibility shim (dual env prefixes, old-package aliases) was rejected under the pre-release stance: no external consumers exist, and every shim becomes permanent surface to test and document. Renaming only the display name while keeping the `dsh`/`DSH_` identifiers was rejected as the worst split — code, docs, and registry names would disagree about what the product is called.

## Consequences

The pre-release stance absorbs the breakage: existing `~/.dsh` data, `DSH_*` environments, and installed `@deepseek-ai/*` tarballs are not migrated. Publication requires the `@buckeyestudio` npm organization and PyPI names to exist before release workflows run. The wire `serverInfo.name` changed from its earlier protocol-stable spelling; any client pinned to the old value must update in lockstep.
