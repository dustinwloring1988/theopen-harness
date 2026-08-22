// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { DocumentTitle } from '../src/client/DocumentTitle.tsx'

afterEach(() => {
  cleanup()
  document.title = ''
  vi.unstubAllEnvs()
})

describe('DocumentTitle', () => {
  it('projects a durable title and restores the product title', () => {
    vi.stubEnv('TOH_CLIENT_TITLE', 'TheOpen Harness')
    document.title = 'stale title'
    const mounted = render(<DocumentTitle />)
    expect(document.title).toBe('TheOpen Harness')
    mounted.rerender(<DocumentTitle title="First title" />)
    expect(document.title).toBe('First title — TheOpen Harness')
    mounted.rerender(<DocumentTitle title="Revised title" />)
    expect(document.title).toBe('Revised title — TheOpen Harness')
    mounted.rerender(<DocumentTitle />)
    expect(document.title).toBe('TheOpen Harness')
    mounted.unmount()
    expect(document.title).toBe('TheOpen Harness')
  })

  it('uses the generic title when the build provides no title', () => {
    vi.stubEnv('TOH_CLIENT_TITLE', '')
    delete process.env.TOH_CLIENT_TITLE
    const mounted = render(<DocumentTitle title="First title" />)
    expect(document.title).toBe('First title — TOH Local Build')
    mounted.unmount()
    expect(document.title).toBe('TOH Local Build')
  })
})
