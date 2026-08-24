// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@buckeyestudio/toh-client-runtime/client'
import { SessionLogDownloadController } from '../src/client/controller.ts'
import { SessionLogDownloadHeaderAction } from '../src/client/HeaderAction.tsx'
import type { SessionLogDownloadDialogProps } from '../src/client/Dialog.tsx'
import { en } from '../src/client/locales.ts'

const SID = 'session-export-header' as SessionId

function bindSessionExport(controller: SessionLogDownloadController) {
  return function useSessionLogDownload<T>(selector: (state: ReturnType<typeof controller.store.getSnapshot>) => T): T {
    return useSyncExternalStore(
      listener => controller.store.subscribe(listener),
      () => selector(controller.store.getSnapshot()),
    )
  }
}

function bench() {
  const controller = new SessionLogDownloadController(async () => new Response('zip'), vi.fn())
  const request = vi.fn((sessionId: SessionId) => controller.download(sessionId))
  const dismiss = vi.fn((sessionId: SessionId) => { controller.dismiss(sessionId) })
  const buildMarkdown = vi.fn(() => '# Session transcript')
  const useSessionLogDownload = bindSessionExport(controller)
  const props = {
    sessionId: SID,
    useSessionLogDownload,
    request,
    dismiss,
    buildMarkdown,
    t: (key: keyof typeof en): string => en[key],
  } as unknown as SessionLogDownloadDialogProps
  const view = render(<SessionLogDownloadHeaderAction {...props} />)
  return { controller, request, buildMarkdown, view }
}

afterEach(cleanup)

describe('Session export Header actions', () => {
  it('renders the ZIP capsule and downloads through the shared controller', async () => {
    const b = bench()
    const button = b.view.getByRole('button', { name: 'Session log' })
    expect(button.querySelector('svg')).not.toBeNull()
    fireEvent.click(button)
    await waitFor(() => { expect(b.request).toHaveBeenCalledWith(SID) })
    expect(await b.view.findByRole('dialog', { name: 'Session download started' })).toBeTruthy()
  })

  it('renders a Markdown capsule that hands the serialized transcript to the same controller', async () => {
    const b = bench()
    const button = b.view.getByRole('button', { name: 'Markdown' })
    fireEvent.click(button)
    await waitFor(() => {
      expect(b.request).toHaveBeenCalledWith(SID, { format: 'markdown', document: '# Session transcript' })
    })
    expect(b.buildMarkdown).toHaveBeenCalledWith(SID)
    expect(await b.view.findByRole('dialog', { name: 'Session download started' })).toBeTruthy()
  })

  it('disables both capsules while either entry path downloads this Session', async () => {
    const b = bench()
    let release!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => { release = resolve })
    const controller = new SessionLogDownloadController(() => pending, vi.fn())
    const useSessionLogDownload = bindSessionExport(controller)
    b.view.rerender(<SessionLogDownloadHeaderAction {...({
      sessionId: SID,
      useSessionLogDownload,
      request: (sessionId: SessionId) => controller.download(sessionId),
      dismiss: (sessionId: SessionId) => { controller.dismiss(sessionId) },
      buildMarkdown: b.buildMarkdown,
      t: (key: keyof typeof en): string => en[key],
    } as unknown as SessionLogDownloadDialogProps)} />)

    const download = controller.download(SID)
    const zipButton = b.view.getByRole('button', { name: 'Session log' })
    const markdownButton = b.view.getByRole('button', { name: 'Markdown' })
    await waitFor(() => { expect(zipButton.getAttribute('aria-busy')).toBe('true') })
    expect((zipButton as HTMLButtonElement).disabled).toBe(true)
    expect((markdownButton as HTMLButtonElement).disabled).toBe(true)
    release(new Response('zip'))
    await download
    await waitFor(() => { expect(zipButton.getAttribute('aria-busy')).toBe('false') })
    expect((markdownButton as HTMLButtonElement).disabled).toBe(false)
  })
})
