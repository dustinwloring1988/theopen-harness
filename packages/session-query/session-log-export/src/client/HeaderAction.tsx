import type { ReactNode } from 'react'
import { IconDownloadOutline16 } from '@buckeyestudio/toh-client-ui-primitives'
import { SessionLogDownloadDialog, type SessionLogDownloadDialogProps } from './Dialog.tsx'
import css from './HeaderAction.module.css'

/**
 * Render the Session Header export capsules (raw ZIP and Markdown transcript)
 * and their shared result dialog.
 * @param props - Session runtime, download controller, transcript builder, and localized dialog copy.
 * @returns the persistent Header actions and Session-scoped dialog.
 */
export function SessionLogDownloadHeaderAction(props: SessionLogDownloadDialogProps): ReactNode {
  const { sessionId, useSessionLogDownload, request, buildMarkdown } = props
  const entry = useSessionLogDownload(state => state.bySession[String(sessionId)])
  const busy = entry?.status === 'downloading'

  return (
    <>
      <button
        type="button"
        className={css.sessionLogButton}
        disabled={busy}
        aria-busy={busy}
        onClick={() => { void request(sessionId) }}
      >
        <span>Session log</span>
        <IconDownloadOutline16 size={12} />
      </button>
      <button
        type="button"
        className={css.sessionLogButton}
        disabled={busy}
        aria-busy={busy}
        onClick={() => {
          void request(sessionId, { format: 'markdown', document: buildMarkdown(sessionId) })
        }}
      >
        <span>Markdown</span>
        <IconDownloadOutline16 size={12} />
      </button>
      <SessionLogDownloadDialog {...props} />
    </>
  )
}
