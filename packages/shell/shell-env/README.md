# @buckeyestudio/toh-shell-env

English | [中文](README.zh.md)

The tool-independent shell environment plugin: owns the `ctx.shellEnv` registry of trusted, per-execution `TOH_*` variables that the model-facing shell tools (`toh-tool-bash`, `toh-tool-pwsh`) collect into every shell call's environment. Built-in shell facts (`TOH_HOME`, `TOH_SHELL=1`, `TOH_SESSION_ID`) are owned by the registry itself; other plugins register additional enumerable facts with effect-scoped disposal, and duplicate ownership or undeclared runtime keys fail loudly.

The package root exports the Cordis plugin contract (`name`, `inject`, `Config`, `apply`) plus the `ShellEnvRegistry` service class and its contributor types; consumers use `ctx.shellEnv` after loading this plugin.

## Config

```yaml
- id: shell-env
  name: '@buckeyestudio/toh-shell-env'
  config:
    tohHome: C:\Users\me\.toh   # default: $TOH_HOME, then ~/.toh
```

## Managed environment

Every foreground and background model shell call receives a newly collected trusted `TOH_*` environment. `TOH_HOME` is the absolute Harness home resolved by [`@buckeyestudio/toh-home-paths`](../../util/home-paths/README.md) (`tohHome` config, then ambient `$TOH_HOME`, then `~/.toh`) and `TOH_SHELL=1` identifies the managed child. Agent calls additionally receive `TOH_SESSION_ID=agent.session.header.id`; when the active persistence seam locates a JSONL artifact they also receive `TOH_SESSION_JSONL=<absolute target path>`. The JSONL path is a location hint: it may not exist before the first flush or contain the current buffered turn, and it is not an authorization credential.

`ctx.shellEnv` owns collection. Other plugins can register an effect-scoped contributor with a stable name, declared keys/descriptions, and `resolve(execution: ToolExecution)`; duplicate ownership and undeclared runtime keys fail loudly, while `list()` enumerates declarations without executing providers. Harness built-ins reserve `TOH_HOME`, `TOH_SHELL`, and `TOH_SESSION_ID`; this plugin's persistence translator owns `TOH_SESSION_JSONL` by reading the backend-neutral `sessionPersistence.locate()` seam.

```ts
import type { Context } from '@buckeyestudio/cordis'
import type {} from '@buckeyestudio/toh-shell-env'

export const inject = ['shellEnv']

export function apply(ctx: Context): void {
  ctx.shellEnv.register({
    name: 'deployment-region',
    variables: { TOH_DEPLOYMENT_REGION: { description: 'Current deployment region.' } },
    resolve: execution => execution.agent === undefined ? {} : { TOH_DEPLOYMENT_REGION: 'cn-north' },
  })
}
```

The overlay is computed from the current `ToolExecution` and passed through the dedicated `ShellExecRequest.tohEnv` channel. The local executors remove all inherited `TOH_*` before merging that snapshot, so nested harnesses and concurrent parent/child agents cannot leak stale identities. `process.env` is never modified. The shell tools' descriptions teach the generic `$TOH_*` convention rather than naming persistence-specific variables or adding a permanent system-prompt section.

## Model Experience

Indirectly, through the shell tools (`toh-tool-bash`, `toh-tool-pwsh`), which collect this registry's managed `TOH_*` snapshot into every shell-tool call.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **`list()` enumerates contributor-declared variables only** — registry-owned built-ins (`TOH_HOME`, `TOH_SHELL`, `TOH_SESSION_ID`) are not included, so diagnostics, prompt, or UI code must not treat `list()` as an exhaustive environment catalog.
