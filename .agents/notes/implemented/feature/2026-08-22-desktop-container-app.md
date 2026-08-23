# Agent Note: Desktop container app — one Electron window over the spawned web backend

Status: implemented

English | [中文](2026-08-22-desktop-container-app.zh.md)

## Problem

The harness shipped two ways to reach the agent: a browser tab against a manually started `toh web` server, and the headless one-shot CLI. A user who wants "the app" had to open a terminal, start a server, note its port, and point a browser at it; closing the browser left the server running, and no single window owned the product.

## Decision

`apps/desktop` (`@buckeyestudio/toh-desktop`) is an Electron container whose main process owns the full stack: it picks a free 127.0.0.1 port, spawns `apps/cli`'s built `lib/bin.js` with `--profile web --port <port> --no-open`, waits until that port answers HTTP, and loads it in one window. Closing the window kills the backend's whole process tree (`taskkill /T` on Windows, `SIGTERM` elsewhere). A second launch focuses the existing window through the single-instance lock instead of starting a second backend against a second data directory. Cross-origin navigation is refused and new-window requests go to the default browser.

Two launch properties are load-bearing:

- **The child runs under plain `node` from PATH, never under Electron-as-Node.** The vendored Loader reaches Node's internal ESM machinery through `node-addon-require-builtin`; under Electron's embedded Node runtime the profile boot failed to resolve in-box plugins. Stock Node boots the same composition.
- **Readiness is an HTTP probe of the spawned server, not its stdout URL line.** With libuv-created stdio pipes on a GUI-spawned child, the CLI's module resolution was observed to break (in-box plugin imports fell back to the vendored Loader's own location as referrer); inherited streams boot cleanly. The probe also decouples startup from the backend's `printUrl` composition, which would otherwise be a hidden startup dependency.

## Alternatives considered

- **Tauri** — rejected: it adds a Rust toolchain and sidecar-process packaging to an all-Node repository, while the harness backend already requires Node at runtime; Electron keeps one language and one process model.
- **A native IPC bridge instead of any HTTP server** (load the frontend over `file://` and carry `ctx.apiProxy` across Electron IPC via the client transport hooks) — deferred: it reworks `toh-client-connection`'s trust fences and the boot kernel seams for no current need, and the loopback transport is already same-origin fenced. The seam is documented as available if a no-socket deployment ever demands it.
- **Reading the stdout URL line for readiness** (the signal the browser handoff itself uses) — rejected for the piped-stdio failure above and because a composition that silences `printUrl` would silently hang startup.
- **`ELECTRON_RUN_AS_NODE=1` for the backend child** — rejected: boots failed under Electron's embedded Node regardless of stdio shape, per the Loader internals dependency.

## Consequences

- One window is now the product surface: launching the desktop app starts and stops the harness with it, and the URL-line/terminal dance is gone for GUI users.
- The workspace gains an `electron` build-script allowlist entry (`pnpm-workspace.yaml`) whose postinstall fetches the Electron runtime binary; CI install time grows accordingly.
- The app runs from a built checkout and needs `node` on PATH plus the tools the harness itself needs; packaging into an installer with a bundled runtime remains future work ([README](../../../../apps/desktop/README.md) carries the current limitations).
- As an app rather than a plugin package, `apps/desktop` ships no Cordis service and therefore registers no package invariant; its behavior is pinned by the backend-handle unit tests (readiness URL match, exit rejection, tree-kill) and by real-checkout launches.
