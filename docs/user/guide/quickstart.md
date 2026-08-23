# Quickstart

English | [中文](quickstart.zh.md)

This guide takes you from nothing to a completed task. The Web UI is the interactive path; the headless CLI runs one task and exits.

## Prerequisites

- Node.js `^22.19 || >=24` (`node --version` to check)
- A [DeepSeek API key](https://platform.deepseek.com/) (or any OpenAI-compatible endpoint). Commands read it from the environment or a gitignored `.env` at the working directory; the Web UI can also store it in **Settings → Models**.
- An isolated workspace directory the agent may modify

## Start the Web UI

```sh
npx @buckeyestudio/toh web
```

The command starts the server at `http://127.0.0.1:3080` and opens it in your browser; pass `--no-open` to skip that. Then:

1. Enter your key under **Settings → Models** and save; other providers are covered by the [model configuration guide](./providers.md).
2. Click **Choose workspace**, add your project directory, and select it — the composer stays unavailable until one is selected.
3. Start a session and send: *Summarize this repository and identify its main packages.*

The agent can read and edit workspace files, run commands, delegate work, and maintain a plan, asking first when the active permission policy requires approval.

## Or run from source

```sh
git clone https://github.com/dustinwloring1988/theopen-harness.git
cd theopen-harness
pnpm install
pnpm run build
pnpm toh web
```

## One-shot headless run

From a source checkout with `DEEPSEEK_API_KEY` in the environment or repo-root `.env`:

```sh
pnpm toh --profile headless "summarize this workspace"
```

It creates and persists a fresh session, prints the final assistant text, and exits. [Other CLI modes](../../../apps/cli/README.md) include the desktop app and the ACP automation server.

## Continue

- [Cordis tutorial](../../cordis-tutorial/index.md) — hands-on plugin walkthroughs, no API key needed
- [Use the Python SDK](./python-sdk.md) — its bundled runtime supports Linux x64/arm64 and macOS arm64 only, not Windows
- [Configure models](./providers.md)
- [Develop a plugin](../develop/basic/index.md)
