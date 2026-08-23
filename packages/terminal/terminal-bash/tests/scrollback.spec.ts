import { describe, expect, it } from 'vitest'
import { Buffer } from 'node:buffer'
import { BoundedOutputBuffer } from '@buckeyestudio/toh-terminal-bash/src/scrollback.ts'

/**
 * Reference implementation of the retired string-domain buffer. Parity tests
 * compare against it op-by-op so caps, truncation flags, and UTF-8 boundary
 * handling stay byte-identical.
 */
class LegacyBoundedTextBuffer {
  private value = ''
  private dropped = false

  constructor(
    private readonly maxBytes: number,
    private readonly maxLines?: number,
  ) {}

  append(text: string): void {
    if (text.length === 0) return
    this.value += text
    if (this.maxLines !== undefined) {
      const lines = this.value.split('\n')
      if (lines.length > this.maxLines) {
        this.value = lines.slice(lines.length - this.maxLines).join('\n')
        this.dropped = true
      }
    }
    const tail = legacyUtf8Tail(this.value, this.maxBytes)
    this.value = tail.text
    this.dropped ||= tail.truncated
  }

  consume(): { delta: string; truncated: boolean } {
    const delta = this.value
    const truncated = this.dropped
    this.value = ''
    this.dropped = false
    return { delta, truncated }
  }

  snapshot(): { text: string; truncated: boolean } {
    return { text: this.value, truncated: this.dropped }
  }
}

function legacyUtf8Tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  const chars = Array.from(text)
  let bytes = 0
  let start = chars.length
  while (start > 0) {
    const next = Buffer.byteLength(chars[start - 1] as string)
    if (bytes + next > maxBytes) break
    bytes += next
    start -= 1
  }
  return { text: chars.slice(start).join(''), truncated: true }
}

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('BoundedOutputBuffer bounds', () => {
  it('drops head code points at the byte cap and reports truncation until consumed', () => {
    const buffer = new BoundedOutputBuffer(4, undefined)
    buffer.append('a一')
    expect(buffer.snapshot()).toEqual({ text: 'a一', truncated: false })
    buffer.append('b')
    expect(buffer.snapshot()).toEqual({ text: '一b', truncated: true })
    expect(buffer.consume()).toEqual({ delta: '一b', truncated: true })
    expect(buffer.snapshot()).toEqual({ text: '', truncated: false })
    expect(buffer.truncated).toBe(false)
  })

  it('cuts a chunk whose cap falls inside a code point', () => {
    const buffer = new BoundedOutputBuffer(2, undefined)
    buffer.append('一')
    expect(buffer.snapshot()).toEqual({ text: '', truncated: true })
  })

  it('keeps only the last maxLines segments across appends', () => {
    const buffer = new BoundedOutputBuffer(64, 2)
    buffer.append('one\ntwo')
    expect(buffer.snapshot().text).toBe('one\ntwo')
    buffer.append('\nthree\nfour')
    expect(buffer.snapshot()).toEqual({ text: 'three\nfour', truncated: true })
    expect(buffer.consume()).toEqual({ delta: 'three\nfour', truncated: true })
  })

  it('applies the line cap before the byte cap', () => {
    const buffer = new BoundedOutputBuffer(8, 2)
    buffer.append('abcdefghij\nklm\nopq')
    expect(buffer.snapshot()).toEqual({ text: 'klm\nopq', truncated: true })
  })

  it('lets the byte cap cut into the segments the line cap kept', () => {
    const buffer = new BoundedOutputBuffer(6, 2)
    buffer.append('abcdefghij\nklm\nopq')
    expect(buffer.snapshot()).toEqual({ text: 'lm\nopq', truncated: true })
  })

  it('ignores empty appends', () => {
    const buffer = new BoundedOutputBuffer(1, 1)
    buffer.append('')
    expect(buffer.snapshot()).toEqual({ text: '', truncated: false })
  })

  it('compacts the newline index while line-heavy floods keep releasing head data', () => {
    const buffer = new BoundedOutputBuffer(4096, 3)
    const legacy = new LegacyBoundedTextBuffer(4096, 3)
    for (let index = 0; index < 1200; index += 1) {
      buffer.append('\n\n\n\n\n')
      legacy.append('\n\n\n\n\n')
      expect(buffer.snapshot()).toEqual(legacy.snapshot())
    }
    expect(buffer.truncated).toBe(true)
    expect(buffer.consume()).toEqual(legacy.consume())
    expect(buffer.empty).toBe(true)
  })

  it('decodes a wrapped ring identically to the string-domain value', () => {
    const buffer = new BoundedOutputBuffer(7, undefined)
    const legacy = new LegacyBoundedTextBuffer(7, undefined)
    for (const chunk of ['一', '二', '三', '四', '五']) {
      buffer.append(chunk)
      legacy.append(chunk)
    }
    expect(buffer.snapshot()).toEqual(legacy.snapshot())
  })
})

describe('BoundedOutputBuffer parity with string-domain retention', () => {
  it('matches legacy snapshots and consumes across randomized chunk sequences', () => {
    const alphabet = ['a', 'b', '\n', '一', 'é', '😀', 'あ']
    const rng = mulberry32(0xc0ffee)
    for (let scenario = 0; scenario < 400; scenario += 1) {
      const maxBytes = 1 + Math.floor(rng() * 12)
      const maxLines = rng() < 0.7 ? 1 + Math.floor(rng() * 4) : undefined
      const fresh = new BoundedOutputBuffer(maxBytes, maxLines)
      const legacy = new LegacyBoundedTextBuffer(maxBytes, maxLines)
      const ops = 40 + Math.floor(rng() * 40)
      for (let op = 0; op < ops; op += 1) {
        const roll = rng()
        if (roll < 0.12) {
          expect(fresh.consume()).toEqual(legacy.consume())
          continue
        }
        let chunk = ''
        const length = Math.floor(rng() * 8)
        for (let index = 0; index < length; index += 1) {
          chunk += alphabet[Math.floor(rng() * alphabet.length)] as string
        }
        if (roll > 0.94) chunk = chunk.padEnd(maxBytes * 3 + 5, 'z')
        fresh.append(chunk)
        legacy.append(chunk)
        expect(fresh.snapshot()).toEqual(legacy.snapshot())
        expect(fresh.byteLength).toBeLessThanOrEqual(maxBytes)
      }
      expect(fresh.consume()).toEqual(legacy.consume())
      expect(fresh.empty).toBe(true)
      expect(fresh.truncated).toBe(false)
      expect(fresh.consume()).toEqual({ delta: '', truncated: false })
    }
  })
})

describe('BoundedOutputBuffer steady-state cost', () => {
  it('keeps appends flat while the window sits saturated at its byte cap', { timeout: 120_000 }, () => {
    const maxBytes = 512 * 1024
    const buffer = new BoundedOutputBuffer(maxBytes, 50_000)
    const chunk = `${'x'.repeat(63)}\n`
    while (buffer.byteLength < maxBytes) buffer.append(chunk)

    const iterations = 20_000
    const started = process.hrtime.bigint()
    for (let index = 0; index < iterations; index += 1) buffer.append(chunk)
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

    expect(buffer.byteLength).toBeLessThanOrEqual(maxBytes)
    // Quadratic retention would touch iterations x maxBytes (~10 GB of string
    // and split work here); linear appends stay far below this bound even on a
    // loaded CI runner.
    expect(elapsedMs).toBeLessThan(10_000)
    expect(buffer.snapshot().truncated).toBe(true)
    expect(buffer.consume().delta.endsWith(chunk)).toBe(true)
  })
})
