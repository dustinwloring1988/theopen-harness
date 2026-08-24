import { once } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_FRAME_BYTES, JsonRpcLineTransport, JsonRpcResponseError } from '../src/index.ts'

function transportPair() {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const a = new JsonRpcLineTransport(bToA, aToB)
  const b = new JsonRpcLineTransport(aToB, bToA)
  return { a, b, aToB, bToA }
}

describe('JsonRpcLineTransport', () => {
  it('supports bidirectional requests and notifications over newline-delimited JSON-RPC', async () => {
    const { a, b } = transportPair()
    const notifications: Record<string, unknown>[] = []

    a.onRequest(async (method, params) => {
      expect(method).toBe('echo')
      return { echoed: params }
    })
    b.onNotification((method, params) => {
      notifications.push({ method, params })
    })
    a.start()
    b.start()

    const response = await b.request('echo', { value: 42 })
    expect(response).toEqual({ echoed: { value: 42 } })

    a.notify('session.status', { sessionId: 'main', status: 'idle' })
    a.notify('heartbeat')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(notifications).toEqual([
      { method: 'session.status', params: { sessionId: 'main', status: 'idle' } },
      { method: 'heartbeat', params: {} },
    ])

    a.close()
    b.close()
  })

  it('reports JSON-RPC request errors from the remote peer with their wire code', async () => {
    const { a, b } = transportPair()
    a.onRequest(async () => {
      throw new Error('handler boom')
    })
    a.start()
    b.start()

    const failure = await b.request('explode', {}).then(
      () => { throw new Error('request unexpectedly succeeded') },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(JsonRpcResponseError)
    expect(failure).toMatchObject({ message: 'handler boom', code: -32603, data: undefined })

    a.close()
    b.close()
  })

  it('writes a handler-thrown JsonRpcResponseError back verbatim with its wire code and data', async () => {
    const { a, b } = transportPair()
    a.onRequest(async () => {
      throw new JsonRpcResponseError(-32602, 'invalid params for session/prompt', { issues: [{ path: ['contentBlocks'], message: 'invalid input' }] })
    })
    a.start()
    b.start()

    const failure = await b.request('session/prompt', {}).then(
      () => { throw new Error('request unexpectedly succeeded') },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(JsonRpcResponseError)
    expect(failure).toMatchObject({
      code: -32602,
      message: 'invalid params for session/prompt',
      data: { issues: [{ path: ['contentBlocks'], message: 'invalid input' }] },
    })

    a.close()
    b.close()
  })

  it('maps a thrown JsonRpcResponseError without a wire code to the internal-error fallback', async () => {
    const { a, b } = transportPair()
    a.onRequest(async () => {
      throw new JsonRpcResponseError(undefined, 'no wire code')
    })
    a.start()
    b.start()

    await expect(b.request('explode', {})).rejects.toMatchObject({ code: -32603, message: 'no wire code', data: undefined })

    a.close()
    b.close()
  })

  it('drops circular error data and still answers the peer with the error frame', async () => {
    const { a, b } = transportPair()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    a.onRequest(async () => {
      throw new JsonRpcResponseError(-32000, 'circular data', circular)
    })
    a.start()
    b.start()

    const failure = await b.request('explode-circular', {}).then(
      () => { throw new Error('request unexpectedly succeeded') },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(JsonRpcResponseError)
    expect(failure).toMatchObject({ code: -32000, message: 'circular data', data: undefined })

    a.close()
    b.close()
  })

  it('drops BigInt error data and still answers the peer with the error frame', async () => {
    const { a, b } = transportPair()
    a.onRequest(async () => {
      throw new JsonRpcResponseError(-32000, 'bigint data', { tokens: 1n })
    })
    a.start()
    b.start()

    const failure = await b.request('explode-bigint', {}).then(
      () => { throw new Error('request unexpectedly succeeded') },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(JsonRpcResponseError)
    expect(failure).toMatchObject({ code: -32000, message: 'bigint data', data: undefined })

    a.close()
    b.close()
  })

  it('serializes error data exactly once when its toJSON succeeds only on the first pass', async () => {
    const { a, b } = transportPair()
    let serializations = 0
    const stateful = {
      toJSON() {
        serializations += 1
        if (serializations > 1) throw new Error('stateful toJSON exhausted')
        return { ok: true }
      },
    }
    a.onRequest(async () => {
      throw new JsonRpcResponseError(-32000, 'stateful data', stateful)
    })
    a.start()
    b.start()

    const failure = await b.request('explode-stateful', {}).then(
      () => { throw new Error('request unexpectedly succeeded') },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(JsonRpcResponseError)
    expect(failure).toMatchObject({ code: -32000, message: 'stateful data', data: { ok: true } })
    expect(serializations).toBe(1)

    a.close()
    b.close()
  })

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ] as const)('maps a non-finite (%s) wire code to the internal-error fallback without data', async (_label, code) => {
    const { a, b } = transportPair()
    a.onRequest(async () => {
      throw new JsonRpcResponseError(code, 'non-finite wire code', { issues: [] })
    })
    a.start()
    b.start()

    const failure = await b.request('explode-nonfinite', {}).then(
      () => { throw new Error('request unexpectedly succeeded') },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(JsonRpcResponseError)
    expect(failure).toMatchObject({ code: -32603, message: 'non-finite wire code', data: undefined })

    a.close()
    b.close()
  })

  it('rejects immediately on a pre-aborted signal without registering pending state', async () => {
    const { b } = transportPair()
    b.start()
    const controller = new AbortController()
    controller.abort(new Error('already gone'))
    await expect(b.request('never-sent', {}, controller.signal)).rejects.toThrow('already gone')
    expect((b as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
    b.close()
  })

  it('abandons a pending request on abort, stringifying a non-Error reason', async () => {
    const { b } = transportPair()
    b.start()
    const controller = new AbortController()
    const pending = b.request('never-answered', {}, controller.signal)
    controller.abort('plain-string-reason')
    await expect(pending).rejects.toThrow('JSON-RPC request aborted: plain-string-reason')
    // The abandonment removed the pending entry — nothing is retained for a
    // response that may never come.
    expect((b as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
    b.close()
  })

  it('preserves structured error data from an error response frame', async () => {
    const { aToB, bToA, b } = transportPair()
    b.start()

    const pending = b.request('remote-error-data', {})
    const requestChunk = (await once(bToA, 'data'))[0] as Buffer | string
    const request = JSON.parse(String(requestChunk)) as { id: string }
    aToB.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: 7, message: 'structured', data: { detail: 'x' } } })}\n`)

    const failure = await pending.then(
      () => { throw new Error('request unexpectedly succeeded') },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(JsonRpcResponseError)
    expect(failure).toMatchObject({ code: 7, message: 'structured', data: { detail: 'x' } })

    b.close()
  })

  it('stringifies non-Error request handler failures', async () => {
    const { a, b } = transportPair()
    a.onRequest(async () => {
      throw 'string boom'
    })
    a.start()
    b.start()

    await expect(b.request('explode-string', {})).rejects.toThrow('string boom')

    a.close()
    b.close()
  })

  it('reports method-not-found when no request handler is installed', async () => {
    const { a, b } = transportPair()
    a.start()
    b.start()

    await expect(b.request('missing', {})).rejects.toThrow('method not found: missing')

    a.close()
    b.close()
  })

  it('normalizes non-object request params and ignores notifications without a handler', async () => {
    const { aToB, bToA, b } = transportPair()
    const seen: Record<string, unknown>[] = []
    b.onRequest(async (method, params) => {
      seen.push({ method, params })
      return { ok: true }
    })
    b.start()

    aToB.write('{"jsonrpc":"2.0","method":"ignored"}\n')
    aToB.write('{"jsonrpc":"2.0","id":7,"method":"array-params","params":[]}\n')
    const chunk = (await once(bToA, 'data'))[0] as Buffer | string

    expect(seen).toEqual([{ method: 'array-params', params: {} }])
    expect(JSON.parse(String(chunk))).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } })
    b.close()
  })

  it('ignores malformed frames and accepts notifications without params', async () => {
    const { aToB, b } = transportPair()
    const notifications: Record<string, unknown>[] = []
    b.onNotification((method, params) => {
      notifications.push({ method, params })
    })
    b.start()
    b.start()

    aToB.write('not json\n')
    aToB.write('\n')
    aToB.write('null\n')
    aToB.write('{"jsonrpc":"2.0","params":{}}\n')
    aToB.write('{"jsonrpc":"2.0","method":"tick"}\n')
    aToB.emit('data', '{"jsonrpc":"2.0","method":"string-chunk"}\n')
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(notifications).toEqual([
      { method: 'tick', params: {} },
      { method: 'string-chunk', params: {} },
    ])
    b.close()
  })

  it('preserves multibyte UTF-8 characters split across Buffer chunks', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new JsonRpcLineTransport(input, output)
    const notifications: Record<string, unknown>[] = []
    transport.onNotification((method, params) => { notifications.push({ method, params }) })
    transport.start()

    const frame = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'message', params: { text: '你好' } })}\n`)
    const character = Buffer.from('你')
    const characterStart = frame.indexOf(character)
    expect(characterStart).toBeGreaterThanOrEqual(0)
    input.write(frame.subarray(0, characterStart + 1))
    input.write(frame.subarray(characterStart + 1))
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(notifications).toEqual([{ method: 'message', params: { text: '你好' } }])
    transport.close()
  })

  it('flush waits for all earlier output writes', async () => {
    const events: string[] = []
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        const label = chunk.length === 0 ? 'barrier' : 'frame'
        events.push(`start:${label}`)
        setTimeout(() => {
          events.push(`finish:${label}`)
          callback()
        }, 5)
      },
    })
    const transport = new JsonRpcLineTransport(new PassThrough(), output)

    transport.notify('tick')
    await transport.flush()

    expect(events).toEqual([
      'start:frame',
      'finish:frame',
      'start:barrier',
      'finish:barrier',
    ])
    transport.close()
  })

  it('reports an output callback failure from flush', async () => {
    const output = {
      write(_chunk: string, callback?: (error?: Error) => void) {
        callback?.(new Error('flush failed'))
        return true
      },
    }
    const transport = new JsonRpcLineTransport(new PassThrough(), output as never)

    await expect(transport.flush()).rejects.toThrow('flush failed')
  })

  it('rejects pending requests when the input closes', async () => {
    const { aToB, b } = transportPair()
    b.start()

    const pending = b.request('never-replies', {})
    aToB.end()

    await expect(pending).rejects.toThrow('JSON-RPC input closed')
    b.close()
  })

  it('rejects pending requests when the input errors', async () => {
    const { aToB, b } = transportPair()
    b.start()

    const pending = b.request('never-replies', {})
    aToB.emit('error', new Error('input broke'))

    await expect(pending).rejects.toThrow('input broke')
    b.close()
  })

  it('rejects pending requests when the transport closes', async () => {
    const { b } = transportPair()

    const pending = b.request('never-replies', {})
    b.close()

    await expect(pending).rejects.toThrow('JSON-RPC transport closed')
  })

  it('rejects a request when writing the frame throws', async () => {
    const input = new PassThrough()
    const output = {
      write() {
        throw new Error('write exploded')
      },
    }
    const transport = new JsonRpcLineTransport(input, output as never)

    await expect(transport.request('write-fails', {})).rejects.toThrow('write exploded')
  })

  it('stringifies non-Error write failures', async () => {
    const input = new PassThrough()
    const output = {
      write() {
        throw 'write string'
      },
    }
    const transport = new JsonRpcLineTransport(input, output as never)

    await expect(transport.request('write-fails', {})).rejects.toThrow('write string')
  })

  it('uses a fallback message for malformed JSON-RPC error responses', async () => {
    const { aToB, bToA, b } = transportPair()
    b.start()

    const pending = b.request('remote-error', {})
    const requestChunk = (await once(bToA, 'data'))[0] as Buffer | string
    const request = JSON.parse(String(requestChunk)) as { id: string }
    aToB.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: {} })}\n`)

    await expect(pending).rejects.toThrow('JSON-RPC error')
    b.close()
  })

  it('ignores responses that do not match a pending request', async () => {
    const { aToB, b } = transportPair()
    b.start()

    aToB.write('{"jsonrpc":"2.0","id":"unknown","result":{"ignored":true}}\n')
    await new Promise(resolve => setTimeout(resolve, 10))

    b.close()
  })

  it('defaults the frame cap to 16 MiB', () => {
    expect(DEFAULT_MAX_FRAME_BYTES).toBe(16 * 1024 * 1024)
  })

  it('rejects invalid maxFrameBytes values at construction', () => {
    const input = new PassThrough()
    for (const maxFrameBytes of [0, -1, 1.5, Number.NaN]) {
      expect(() => new JsonRpcLineTransport(input, new PassThrough(), { maxFrameBytes }),
        `maxFrameBytes ${String(maxFrameBytes)}`).toThrow(TypeError)
      expect(() => new JsonRpcLineTransport(input, new PassThrough(), { maxFrameBytes }),
        `maxFrameBytes ${String(maxFrameBytes)}`).toThrow('maxFrameBytes must be a positive safe integer')
    }
  })

  it('fails pending requests and stops buffering when an unterminated frame exceeds the cap', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new JsonRpcLineTransport(input, output, { maxFrameBytes: 64 })
    transport.start()

    const pending = transport.request('never-replies', {})
    input.write('x'.repeat(40))
    input.write('y'.repeat(40))

    const failure = await pending.then(
      () => { throw new Error('request unexpectedly succeeded') },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(JsonRpcResponseError)
    expect(failure).toMatchObject({ code: -32700, message: 'JSON-RPC frame exceeded 64 bytes' })
    expect(input.destroyed).toBe(true)

    const internals = transport as unknown as { chunks: Buffer[] }
    expect(internals.chunks).toEqual([])
    input.write('z'.repeat(100))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(internals.chunks).toEqual([])

    transport.close()
  })

  it('fails a complete frame larger than the cap like an unterminated one', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const notifications: Record<string, unknown>[] = []
    const transport = new JsonRpcLineTransport(input, output, { maxFrameBytes: 64 })
    transport.onNotification((method, params) => { notifications.push({ method, params }) })
    transport.start()

    // Complete frames within the cap keep batching valid before the overflow.
    input.write('{"jsonrpc":"2.0","method":"tick"}\n')
    const pending = transport.request('never-replies', {})
    input.write(`${'x'.repeat(80)}\n`)

    const failure = await pending.then(
      () => { throw new Error('request unexpectedly succeeded') },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(JsonRpcResponseError)
    expect(failure).toMatchObject({ code: -32700, message: 'JSON-RPC frame exceeded 64 bytes' })
    expect(input.destroyed).toBe(true)
    expect(notifications.map(notification => notification.method)).toEqual(['tick'])
    transport.close()
  })

  it('trips the cap over malformed UTF-8 lines whose decoding outgrows their raw bytes', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new JsonRpcLineTransport(input, output, { maxFrameBytes: 64 })
    transport.start()

    const pending = transport.request('never-replies', {})
    for (let index = 0; index < 100; index += 1) input.write(Buffer.from([0xff, 0x0a]))
    input.write(Buffer.alloc(80, 0x7a))

    await expect(pending).rejects.toMatchObject({ code: -32700 })
    expect(input.destroyed).toBe(true)
    transport.close()
  })

  it('keeps buffering at exactly the cap and overflows only past it', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new JsonRpcLineTransport(input, output, { maxFrameBytes: 8 })
    transport.start()

    const settled: string[] = []
    const pending = transport.request('never-replies', {})
    pending.then(
      () => { settled.push('resolved') },
      (error: unknown) => { settled.push(String(error)) },
    )

    input.write('a'.repeat(8))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toEqual([])
    expect((transport as unknown as { bufferedBytes: number }).bufferedBytes).toBe(8)

    // Completing the frame exactly at the cap delivers it normally.
    input.write('\n')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toEqual([])

    const overflowing = transport.request('never-replies-2', {})
    input.write('b'.repeat(9))
    await expect(overflowing).rejects.toMatchObject({ code: -32700 })
    transport.close()
  })

  it('measures the frame cap in UTF-8 bytes, not characters', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new JsonRpcLineTransport(input, output, { maxFrameBytes: 5 })
    transport.start()

    const pending = transport.request('never-replies', {})
    // '你好' is 6 UTF-8 bytes but only 2 string characters.
    input.write(Buffer.from('你好'))
    await expect(pending).rejects.toMatchObject({ code: -32700 })
    transport.close()
  })
})
