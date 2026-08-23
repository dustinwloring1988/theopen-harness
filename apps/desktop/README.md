# `@buckeyestudio/toh-desktop`

English | [中文](README.zh.md)

The desktop container app: one Electron window around the harness Web GUI. Its main process picks a free loopback port, spawns the built `toh web` backend on it, waits until that port answers HTTP, and loads it in the window; closing the window stops the whole backend process tree.

## Run

Production runs require built artifacts. From the repository root:

```sh
pnpm run build
pnpm --filter @buckeyestudio/toh-desktop exec electron .
```

The app refuses a second concurrent instance: launching again focuses the existing window instead of starting a second backend.

## How it composes

| Module | Role |
|---|---|
| [`src/main.ts`](src/main.ts) | Electron main process: window lifecycle, single-instance lock, navigation guard, fatal-error dialogs. |
| [`src/backend.ts`](src/backend.ts) | Picks a free 127.0.0.1 port, spawns `apps/cli`'s built `lib/bin.js` with `--profile web --port <port> --no-open` under a plain Node executable (the Loader's module resolution needs stock Node semantics), resolves readiness by polling the HTTP server, and owns tree-kill on shutdown. |

Readiness is an HTTP probe against the spawned server, not its stdout: piped stdio of a GUI-spawned child perturbs the CLI's module resolution, and the probe decouples startup from the backend's `printUrl` composition. The renderer keeps the ordinary browser transport (loopback HTTP plus SSE against the `/api` gateway); there is no preload bridge and no extra listening surface beyond what `toh web` already binds on 127.0.0.1. Cross-origin navigations are refused, and new-window requests go to the default browser.

## Known Limitations and Deferred Work

- No packaging or distribution yet (no installer, no bundled runtime): the app runs from a built checkout, needs `node` on PATH to start the backend, and requires the tools the harness itself needs.
