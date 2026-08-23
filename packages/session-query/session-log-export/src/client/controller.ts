/** Browser download state shared by the Session Header buttons and `/export`. */

import { createSnapshotStore, type SessionId, type SnapshotStore } from '@buckeyestudio/toh-client-runtime/client'

/** Download phases presented by the shared modal. */
export type SessionLogDownloadStatus = 'downloading' | 'success' | 'error'

/** Artifact variants one Session's shared download dialog presents. */
export type SessionLogDownloadFormat = 'zip' | 'markdown'

/** One download request: which artifact to fetch and, for Markdown, its document. */
export interface SessionLogDownloadRequest {
  /** Artifact variant; `zip` streams the host endpoint, `markdown` saves a client-built document. */
  readonly format: SessionLogDownloadFormat
  /** Complete Markdown document; required by and used only for the markdown format. */
  readonly document?: string
}

/** One Session's current download-dialog state. */
export interface SessionLogDownloadEntry {
  readonly open: boolean
  readonly status: SessionLogDownloadStatus
  readonly error: string | null
  readonly format: SessionLogDownloadFormat
}

/** Download states keyed by the Session whose Header owns the dialog. */
export interface SessionLogDownloadState {
  bySession: Record<string, SessionLogDownloadEntry | undefined>
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>
type Save = (url: string, filename: string) => void

const INITIAL: SessionLogDownloadState = { bySession: {} }

const DEFAULT_REQUEST: SessionLogDownloadRequest = { format: 'zip' }

/**
 * Collapse an untrusted Session id into the filename token convention shared
 * by both artifact filenames.
 * @param sessionId - Session whose artifact is downloaded.
 * @returns one safe filename token.
 */
function sessionIdToken(sessionId: SessionId): string {
  return String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')
}

/**
 * Collapse an untrusted Session id into the archive filename owned by the host endpoint.
 * @param sessionId - Session whose archive is downloaded.
 * @returns one safe browser download filename.
 */
export function sessionLogZipFilename(sessionId: SessionId): string {
  return `toh-session-${sessionIdToken(sessionId)}.zip`
}

/**
 * Collapse an untrusted Session id into the Markdown transcript filename.
 * @param sessionId - Session whose transcript is downloaded.
 * @returns one safe browser download filename.
 */
export function sessionMarkdownFilename(sessionId: SessionId): string {
  return `toh-session-${sessionIdToken(sessionId)}.md`
}

/**
 * Hand a Host download URL to the browser download manager.
 * @param url - same-origin Host download URL.
 * @param filename - browser download filename.
 */
export function downloadUrl(url: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
}

/** Resolve the browser's Host base with the connection carrier's null-origin fallback. */
function hostBase(): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  return origin !== undefined && origin !== 'null' ? origin : 'http://toh.internal'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Owns one in-flight browser download per Session and publishes modal state. */
export class SessionLogDownloadController {
  /** uSES-safe state source shared by every Session-scoped modal contribution. */
  readonly store: SnapshotStore<SessionLogDownloadState> = createSnapshotStore(INITIAL)

  private readonly active = new Map<SessionId, { readonly abort: AbortController; readonly done: Promise<void> }>()
  private disposed = false

  /**
   * @param fetcher - HTTP carrier used to read the host-streamed ZIP.
   * @param save - browser save operation.
   */
  constructor(
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
    private readonly save: Save = downloadUrl,
  ) {}

  /**
   * Download one Session artifact; concurrent gestures for the same Session share one operation.
   * @param sessionId - root Session whose artifact is downloaded.
   * @param request - artifact selection; defaults to the raw ZIP.
   * @returns after the browser save starts, an error state is published, or a late post-disposal request is ignored.
   */
  download(
    sessionId: SessionId,
    request: SessionLogDownloadRequest = DEFAULT_REQUEST,
  ): Promise<void> {
    const existing = this.active.get(sessionId)
    if (existing !== undefined) return existing.done
    if (this.disposed) return Promise.resolve()
    const abort = new AbortController()
    const done = this.run(sessionId, request, abort.signal).finally(() => {
      this.active.delete(sessionId)
    })
    this.active.set(sessionId, { abort, done })
    return done
  }

  /**
   * Close one Session's dialog without cancelling an in-flight browser download.
   * @param sessionId - Session whose modal closes.
   */
  dismiss(sessionId: SessionId): void {
    const current = this.store.getSnapshot().bySession[String(sessionId)]
    if (current === undefined || !current.open) return
    this.publish(sessionId, { ...current, open: false })
  }

  /**
   * Abort active fetches and reach quiescence.
   * @returns after every active operation settles.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    const active = [...this.active.values()]
    for (const operation of active) operation.abort.abort()
    await Promise.allSettled(active.map(operation => operation.done))
  }

  private async run(
    sessionId: SessionId,
    request: SessionLogDownloadRequest,
    signal: AbortSignal,
  ): Promise<void> {
    this.publish(sessionId, { open: true, status: 'downloading', error: null, format: request.format })
    try {
      if (request.format === 'markdown') this.saveMarkdown(sessionId, request.document ?? '')
      else await this.saveZip(sessionId, signal)
      const open = this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true
      this.publish(sessionId, { open, status: 'success', error: null, format: request.format })
    } catch (error: unknown) {
      if (signal.aborted) return
      const open = this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true
      this.publish(sessionId, { open, status: 'error', error: messageOf(error), format: request.format })
    }
  }

  /**
   * Preflight the host endpoint, then hand the GET URL to the browser download manager.
   * @param sessionId - root Session whose ZIP includes descendants and attachments.
   * @param signal - cancellation from controller disposal.
   */
  private async saveZip(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    const url = new URL('/api/session.export', hostBase())
    url.searchParams.set('sessionId', sessionId)
    url.searchParams.set('includeDescendants', 'true')
    const response = await this.fetcher(url, { method: 'HEAD', signal })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Export failed: HTTP ${response.status}${detail === '' ? '' : ` ${detail}`}`)
    }
    this.save(url.toString(), sessionLogZipFilename(sessionId))
  }

  /**
   * Save a client-built Markdown document through a short-lived object URL.
   * @param sessionId - Session whose transcript is saved.
   * @param document - complete Markdown text.
   */
  private saveMarkdown(sessionId: SessionId, document: string): void {
    const url = URL.createObjectURL(new Blob([document], { type: 'text/markdown' }))
    try {
      this.save(url, sessionMarkdownFilename(sessionId))
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  private publish(sessionId: SessionId, entry: SessionLogDownloadEntry): void {
    this.store.update((state) => {
      state.bySession = { ...state.bySession, [String(sessionId)]: entry }
    })
  }
}
