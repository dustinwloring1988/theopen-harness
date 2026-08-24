/**
 * downloads domain impl: the host-only session-log ZIP export surface (GET /
 * HEAD /api/session.export), streaming each session's stored artifact bytes
 * verbatim through fflate's Zip at the configured DEFLATE level.
 */

import type { Context } from '@buckeyestudio/cordis'
// Value edges: resolve `ctx.sessions` / `ctx.attachments` merges and read raw
// artifacts from persistence.
import type {} from '@buckeyestudio/toh-attachment'
import type { SessionRawArtifact } from '@buckeyestudio/toh-session-persistence'
import {
  flushLiveSessionLog,
  sessionLogExportDeps,
  sessionLogZipFilename,
  streamSessionLogZip,
  type SessionLogExportReady,
  type SessionLogCompressionLevel,
} from '../session-export.ts'
import type { ApiProxy } from './index.ts'

/** Closure values the downloads domain consumes from the gateway assembly. */
export interface DownloadsDeps {
  /** Validated DEFLATE level for session-log ZIP entries. */
  compressionLevel: SessionLogCompressionLevel
}

/**
 * Create the downloads domain over a composed host context.
 * @param ctx - a context with the Host spine mounted; missing query,
 * persistence, or attachment services answer before any zip byte is produced.
 * @param deps - resolved gateway configuration consumed by the stream.
 * @returns the `downloads.*` method group.
 */
export function createDownloadsImpl(ctx: Context, deps: DownloadsDeps): ApiProxy['downloads'] {
  const { compressionLevel } = deps

  return {
    async sessionLog(request, signal) {
      // Clean error path first: missing services answer 500 and a missing
      // root artifact 404 before any zip byte is produced. The root content
      // read here is reused as the first zip entry, so nothing is read twice.
      const deps = sessionLogExportDeps(ctx)
      if (deps.sessionQuery === undefined || deps.sessionPersistence === undefined || deps.attachments === undefined) {
        return new Response(
          'session log export is unavailable: missing session-query, session-persistence, or attachments service',
          { status: 500 },
        )
      }
      if (!deps.sessionPersistence.supportsRawArtifacts) {
        return new Response(
          'session log export is unavailable: the persistence backend does not expose per-session raw artifacts',
          { status: 501 },
        )
      }
      const ready: SessionLogExportReady = {
        sessionQuery: deps.sessionQuery,
        sessionPersistence: deps.sessionPersistence,
        attachments: deps.attachments,
        sessions: deps.sessions,
      }
      let root: SessionRawArtifact | undefined
      try {
        await flushLiveSessionLog(deps, request.sessionId, signal)
        root = await deps.sessionPersistence.readRaw(request.sessionId, signal)
        signal.throwIfAborted()
      } catch {
        signal.throwIfAborted()
        // Root preparation failure: answer 500 without echoing the error,
        // which may carry absolute host paths into the browser error bar.
        return new Response('session log export failed to prepare the stored artifact', { status: 500 })
      }
      if (root === undefined) {
        return new Response('session not found', { status: 404 })
      }
      return new Response(
        streamSessionLogZip(
          ready,
          root,
          request.sessionId,
          request.includeDescendants === true,
          compressionLevel,
          signal,
        ),
        {
          headers: {
            'content-type': 'application/zip',
            'content-disposition': `attachment; filename="${sessionLogZipFilename(request.sessionId)}"`,
          },
        },
      )
    },
  }
}
