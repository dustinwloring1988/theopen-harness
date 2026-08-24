import type { ObservableSnapshot, SessionId } from '@buckeyestudio/toh-client-runtime/client'
import { Button, Modal } from '@buckeyestudio/toh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@buckeyestudio/toh-client-ui-slots'
import type {
  SessionLogDownloadFormat, SessionLogDownloadRequest, SessionLogDownloadState,
} from './controller.ts'
import { NS } from './locales.ts'

/** Browser operations and state injected into the Session Header contribution. */
export interface SessionLogDownloadDialogInjected {
  hooks: { sessionLogDownload: ObservableSnapshot<SessionLogDownloadState> }
  request: (sessionId: SessionId, request?: SessionLogDownloadRequest) => Promise<void>
  dismiss: (sessionId: SessionId) => void
  /** Serialize this Session's assembled conversation window into a Markdown transcript. */
  buildMarkdown: (sessionId: SessionId) => string
}

export type SessionLogDownloadDialogProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof NS>
  & InjectFace<SessionLogDownloadDialogInjected>

/**
 * Modal shared by both Session Header buttons and this browser's `/export` command.
 * @param props - Session runtime, bound controller state, actions, and localized copy.
 * @returns the modal portal contribution.
 */
export function SessionLogDownloadDialog({
  sessionId, useSessionLogDownload, dismiss, t,
}: SessionLogDownloadDialogProps) {
  const entry = useSessionLogDownload(state => state.bySession[String(sessionId)])

  const status = entry?.status
  const open = entry?.open === true
  const format: SessionLogDownloadFormat = entry?.format ?? 'zip'
  const error = status === 'error' ? entry?.error || t('dialog.commandFailed') : null
  const title = status === 'downloading'
    ? t('dialog.preparingTitle')
    : status === 'success' ? t('dialog.successTitle') : t('dialog.errorTitle')
  const description = status === 'downloading'
    ? format === 'markdown' ? t('dialog.preparingMarkdownDescription') : t('dialog.preparingDescription')
    : status === 'success'
      ? format === 'markdown' ? t('dialog.successMarkdownDescription') : t('dialog.successDescription')
      : error ?? t('dialog.commandFailed')

  return (
    <Modal
      open={open}
      onClose={() => { dismiss(sessionId) }}
      title={title}
      description={description}
      closeLabel={t('dialog.close')}
      footer={<Button variant="primary" onClick={() => { dismiss(sessionId) }}>{t('dialog.close')}</Button>}
    />
  )
}
