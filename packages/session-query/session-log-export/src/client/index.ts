/** Browser plugin owning Session export download state and its shared modal. */

import type { ClientContext, SessionId } from '@buckeyestudio/toh-client-runtime/client'
import type {} from '@buckeyestudio/toh-client-locale/client'
import type {} from '@buckeyestudio/toh-client-ui-commands/client'
import type {} from '@buckeyestudio/toh-client-ui-conversation/client'
import {
  SessionLogDownloadController, type SessionLogDownloadRequest,
} from './controller.ts'
import { exportVariantOf } from '../command.ts'
import type { SessionLogDownloadDialogInjected } from './Dialog.tsx'
import { SessionLogDownloadHeaderAction } from './HeaderAction.tsx'
import { en, NS, zh, type SessionLogDownloadKey } from './locales.ts'
import { serializeSessionTranscript } from './transcript.ts'

declare module '@buckeyestudio/cordis' {
  interface Context {
    sessionLogDownload: SessionLogDownloadController
  }
}

declare module '@buckeyestudio/toh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'session-log-download': SessionLogDownloadKey
  }
}

export type { SessionLogDownloadEntry, SessionLogDownloadState } from './controller.ts'

export const inject = ['slots', 'locale', 'sessions']

/**
 * Provide the download controller and mount its modal into the Session Header.
 * @param ctx - browser context carrying slots, locale, and sessions services.
 */
export function apply(ctx: ClientContext): void {
  const controller = new SessionLogDownloadController()
  ctx.provide('sessionLogDownload', controller)
  ctx.effect(() => async () => { await controller.dispose() }, 'session-log-download: browser download lifecycle')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-log-download: browser dictionaries')
  // The transcript reads the assembled conversation window at gesture time;
  // the render path never subscribes to conversation changes for it.
  const buildMarkdown = (sessionId: SessionId): string => serializeSessionTranscript({
    sessionId,
    nodes: ctx.sessions.binding(sessionId)?.session.getSnapshot().nodes ?? [],
  })
  ctx.on('command/executed', (sessionId, commandName, result) => {
    if (commandName !== 'export' || result.kind !== 'success') return
    const request: SessionLogDownloadRequest = exportVariantOf(result.text) === 'markdown'
      ? { format: 'markdown', document: buildMarkdown(sessionId) }
      : { format: 'zip' }
    void controller.download(sessionId, request)
  })
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'session-log-download',
    locale: NS,
    inject: (): SessionLogDownloadDialogInjected => ({
      hooks: { sessionLogDownload: controller.store },
      request: (sessionId: SessionId, request?: SessionLogDownloadRequest) =>
        controller.download(sessionId, request),
      dismiss: (sessionId: SessionId) => { controller.dismiss(sessionId) },
      buildMarkdown,
    }),
  }, SessionLogDownloadHeaderAction))
}
