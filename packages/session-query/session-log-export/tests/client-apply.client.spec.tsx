// @vitest-environment jsdom
import { Context } from '@buckeyestudio/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@buckeyestudio/toh-client-runtime/client'
import type { ConversationNode, SessionId } from '@buckeyestudio/toh-client-runtime/client'
import { LocaleRuntime } from '@buckeyestudio/toh-client-locale/client'
import type {} from '@buckeyestudio/toh-client-ui-conversation/client'
import { SessionLogDownloadHeaderAction } from '../src/client/HeaderAction.tsx'
import { apply, inject } from '../src/client/index.ts'

const SID = 'session-export-apply' as SessionId

afterEach(() => {
  vi.unstubAllGlobals()
  const urlCtor = URL as unknown as Record<string, unknown>
  delete urlCtor.createObjectURL
  delete urlCtor.revokeObjectURL
})

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
}

/** Minimal sessions double: only the binding lookup the transcript builder reads. */
function stubSessions(nodes: readonly ConversationNode[]): unknown {
  return {
    binding(id: SessionId) {
      if (String(id) !== String(SID)) return undefined
      return {
        sessionId: id,
        session: { getSnapshot: () => ({ nodes }) },
      }
    },
  }
}

async function bench(nodes: readonly ConversationNode[] = []) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const declaration = declare(slots)
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('sessions', stubSessions(nodes))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, slots, declaration, fiber }
}

describe('session-log-download browser plugin', () => {
  it('provides one controller and removes its Header contribution on disposal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    const b = await bench()
    expect(inject).toEqual(['slots', 'locale', 'sessions'])
    expect(b.ctx.sessionLogDownload).toBeDefined()
    expect(b.slots.entries('conversation.session.header.actions')).toHaveLength(0)
    const entry = b.slots.entries('conversation.session.header.utilities')[0]
    expect(entry?.component).toBe(SessionLogDownloadHeaderAction)
    expect(entry?.options).toMatchObject({ id: 'session-log-download' })
    const injected = (entry?.inject as unknown as () => import('../src/client/Dialog.tsx').SessionLogDownloadDialogInjected)()
    await injected.request(SID)
    expect(b.ctx.sessionLogDownload.store.getSnapshot().bySession[SID]?.status).toBe('error')
    injected.dismiss(SID)
    expect(b.ctx.sessionLogDownload.store.getSnapshot().bySession[SID]?.open).toBe(false)

    await b.fiber.dispose()
    expect(b.slots.entries('conversation.session.header.utilities')).toHaveLength(0)
  })

  it('downloads only for an export execution acknowledged by this browser client', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    ;(URL as unknown as Record<string, unknown>).createObjectURL = () => 'blob:mock-markdown'
    ;(URL as unknown as Record<string, unknown>).revokeObjectURL = () => {}
    const fetcher = vi.fn(async () => new Response('', { status: 500 }))
    vi.stubGlobal('fetch', fetcher)
    const nodes: ConversationNode[] = [
      { kind: 'user', seq: 0, time: 1, content: [{ type: 'text', text: '# hello' }], source: null },
    ]
    const first = await bench(nodes)
    const second = await bench()

    first.ctx.emit('command/executed', SID, 'plan', { kind: 'success' })
    expect(fetcher).not.toHaveBeenCalled()
    first.ctx.emit('command/executed', SID, 'export', { kind: 'error', text: 'bad path' })
    expect(fetcher).not.toHaveBeenCalled()
    first.ctx.emit('command/executed', SID, 'export', { kind: 'success' })
    await vi.waitFor(() => {
      expect(fetcher).toHaveBeenCalledOnce()
      expect(first.ctx.sessionLogDownload.store.getSnapshot().bySession[SID]?.status).toBe('error')
    })
    expect(second.ctx.sessionLogDownload.store.getSnapshot().bySession[SID]).toBeUndefined()

    // The Markdown variant serializes this browser's assembled window instead of fetching.
    first.ctx.emit('command/executed', SID, 'export', {
      kind: 'success',
      text: 'Markdown transcript download requested.',
    })
    await vi.waitFor(() => {
      expect(first.ctx.sessionLogDownload.store.getSnapshot().bySession[SID]).toMatchObject({
        status: 'success', format: 'markdown',
      })
    })
    const anchor = click.mock.instances.at(-1) as HTMLAnchorElement
    expect(anchor.download).toBe('toh-session-session-export-apply.md')
    expect(anchor.href).toContain('blob:mock-markdown')

    await first.fiber.dispose()
    await second.fiber.dispose()
  })

  it('serializes the assembled conversation window for the Markdown gesture', async () => {
    const nodes: ConversationNode[] = [
      { kind: 'user', seq: 0, time: 1, content: [{ type: 'text', text: 'hello' }], source: null },
    ]
    const b = await bench(nodes)
    const entry = b.slots.entries('conversation.session.header.utilities')[0]
    const injected = (entry?.inject as unknown as () => import('../src/client/Dialog.tsx').SessionLogDownloadDialogInjected)()
    expect(injected.buildMarkdown(SID)).toContain('## User')
    expect(injected.buildMarkdown('unbound' as SessionId)).toContain('- Entries: 0')

    await b.fiber.dispose()
  })

  it('re-registers after the declaring Header slot collapses and returns', async () => {
    const b = await bench()
    b.declaration()
    expect(b.slots.entries('conversation.session.header.utilities')).toHaveLength(0)
    const redeclare = declare(b.slots)
    await Promise.resolve()
    expect(b.slots.entries('conversation.session.header.utilities')[0]?.component).toBe(SessionLogDownloadHeaderAction)
    redeclare()
    await b.fiber.dispose()
  })
})
