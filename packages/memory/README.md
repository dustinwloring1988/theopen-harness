# memory/ — cross-session fact memory capability family

English | [中文](README.zh.md)

This family lets an agent record and recall facts across sessions within one workspace: a provider-registry seam, a storage-domain-backed local provider, and the model-facing memory tools.

| Package | Role | ctx key |
|---|---|---|
| [`memory/`](memory/README.md) | Defines the fact-memory registry and provider contract | `ctx.memory` |
| [`memory-local/`](memory-local/README.md) | Persists facts as workspace-scoped rows over the domain storage facility | registers on `ctx.memory` |
| [`tool-memory/`](tool-memory/README.md) | Exposes `memory_remember` / `memory_recall` / `memory_forget` to the model | consumes `ctx.tools`, `ctx.systemPrompt`, `ctx.memory` |

Memory is an **optional capability**: no shipped bundle mounts it by default. Compose all three packages from your profile or overlay patch (or replace `memory-local` with another provider); see each package README for the intended composition rows.

The subsystem reference for this seam is [docs/subsystems/memory.md](../../docs/subsystems/memory.md).
