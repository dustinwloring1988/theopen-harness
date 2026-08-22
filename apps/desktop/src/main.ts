/**
 * Electron main process of the desktop container app: it spawns the built
 * `toh web` backend on an OS-assigned loopback port, waits for its HTTP server,
 * and presents that origin in one window. The page keeps the ordinary browser
 * transport (loopback HTTP + SSE), so no preload bridge exists.
 * @module @buckeyestudio/toh-desktop
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { spawnWebBackend, stopWebBackend, type WebBackend } from './backend.ts'

/** Window title of the container app. */
const WINDOW_TITLE = 'TheOpen Harness'

/** Initial window geometry; the OS window manager owns resizes beyond this. */
const WINDOW_WIDTH = 1400
const WINDOW_HEIGHT = 900

let backend: WebBackend | undefined
let window: BrowserWindow | undefined
/** Set once shutdown begins, so a killed backend cannot read as a crash. */
let stopping = false

/**
 * Resolve the built CLI entry through the workspace dependency graph rather
 * than a checkout-relative path.
 * @returns absolute path of `apps/cli`'s built `lib/bin.js`.
 */
function resolveCliBinPath(): string {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('@buckeyestudio/toh/package.json')), 'lib', 'bin.js')
}

/**
 * Report a fatal startup or backend failure and exit the app.
 * @param error - the failure to present.
 */
function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  dialog.showErrorBox(WINDOW_TITLE, message)
  app.exit(1)
}

/**
 * Create the container window for one loopback origin and keep navigation
 * inside it: cross-origin navigations are refused and new-window requests go
 * to the user's default browser instead.
 * @param url - the loopback URL advertised by the backend's readiness line.
 * @returns the created window.
 */
function createWindow(url: string): BrowserWindow {
  const created = new BrowserWindow({
    title: WINDOW_TITLE,
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    autoHideMenuBar: true,
  })
  created.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl.startsWith('https://') || targetUrl.startsWith('http://')) void shell.openExternal(targetUrl)
    return { action: 'deny' }
  })
  created.webContents.on('will-navigate', (event, target) => {
    if (target !== url) event.preventDefault()
  })
  void created.loadURL(url)
  return created
}

/** Boot the backend and open its window once its HTTP server answers. */
async function boot(): Promise<void> {
  try {
    backend = await spawnWebBackend(resolveCliBinPath())
    const url = await backend.ready
    backend.child.once('exit', () => {
      // An exit we did not request means the surface is gone; say so instead
      // of leaving a blank window behind.
      if (!stopping) fail(new Error(`${WINDOW_TITLE} backend exited unexpectedly`))
    })
    window = createWindow(url)
  } catch (error) {
    fail(error)
  }
}

/** Stop the backend, then quit; idempotent across close paths. */
function shutdown(): void {
  stopping = true
  if (backend !== undefined) stopWebBackend(backend)
  app.quit()
}

// A second launch must focus the existing container instead of spawning a
// second backend against a second data directory.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (window === undefined || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })
  void app.whenReady().then(() => { void boot() })
  app.on('window-all-closed', shutdown)
  app.on('before-quit', () => {
    stopping = true
    if (backend !== undefined) stopWebBackend(backend)
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => { shutdown() })
  }
}
