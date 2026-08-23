/** Bounded tail retention for decoded terminal output streams. */

import { Buffer } from 'node:buffer'

/** Ring slack that lets the byte-cap cut advance to the next UTF-8 lead byte before releasing retained data. */
const CODE_POINT_SLACK_BYTES = 3

/**
 * Retain the bounded tail of an appended text stream as UTF-8 bytes.
 *
 * Appends cost work proportional to the incoming chunk, never to the retained
 * window: bytes land in a fixed ring and both caps release only head data. The
 * byte cap keeps the longest whole-code-point tail of at most `maxBytes` bytes,
 * identical to a whole-string tail computation; the optional line cap keeps the
 * last `maxLines` newline-separated segments, tracked by incremental newline
 * offsets. Chunks arrive as complete decoded text, so the ring always begins at
 * a code-point boundary and UTF-8 decoding reproduces the string-domain value.
 * Decode work happens only in {@link BoundedOutputBuffer.snapshot} and
 * {@link BoundedOutputBuffer.consume}.
 * @param maxBytes - Retained-byte cap; a positive safe integer.
 * @param maxLines - Retained-segment cap when defined; must be a positive integer.
 */
export class BoundedOutputBuffer {
  private readonly ring: Buffer
  /** Ring offset of the first retained byte. */
  private head = 0
  /** Retained byte count; never exceeds `ring.length`. */
  private size = 0
  /** Stream offset of the first retained byte within the current consume epoch. */
  private base = 0
  private droppedValue = false
  /** Absolute stream offsets of every newline appended this epoch, in order. */
  private newlineOffsets: number[] = []
  /** Stream newline index of `newlineOffsets[0]`, advanced by compaction. */
  private newlineStart = 0
  /** Count of leading `newlineOffsets` entries whose bytes are no longer retained. */
  private newlineCursor = 0
  private newlinesSeen = 0

  constructor(
    private readonly maxBytes: number,
    private readonly maxLines: number | undefined,
  ) {
    this.ring = Buffer.allocUnsafe(maxBytes + CODE_POINT_SLACK_BYTES)
  }

  /** Whether a cap released any data since the last consume. */
  get truncated(): boolean {
    return this.droppedValue
  }

  /** Whether nothing is currently retained. */
  get empty(): boolean {
    return this.size === 0
  }

  /** Retained byte count. */
  get byteLength(): number {
    return this.size
  }

  append(text: string): void {
    if (text.length === 0) return
    const bytes = Buffer.from(text, 'utf8')
    const streamStart = this.base + this.size
    if (bytes.length > this.ring.length) {
      this.replaceWithChunkTail(bytes, streamStart)
      return
    }
    let newlines = 0
    for (let index = 0; index < bytes.length; index += 1) {
      if ((bytes[index] as number) === 0x0a) {
        this.newlineOffsets.push(streamStart + index)
        newlines += 1
      }
    }
    this.newlinesSeen += newlines
    const free = this.ring.length - this.size
    if (bytes.length > free) {
      const loss = bytes.length - free
      this.head = (this.head + loss) % this.ring.length
      this.base += loss
      this.size -= loss
      this.droppedValue = true
    }
    const writeAt = (this.head + this.size) % this.ring.length
    const headRun = Math.min(bytes.length, this.ring.length - writeAt)
    bytes.copy(this.ring, writeAt, 0, headRun)
    bytes.copy(this.ring, 0, headRun)
    this.size += bytes.length
    this.purgeReleasedNewlines()
    this.enforceLineCap()
    this.enforceByteCap()
  }

  consume(): { delta: string; truncated: boolean } {
    const delta = this.decode()
    const truncated = this.droppedValue
    this.head = 0
    this.size = 0
    this.base = 0
    this.droppedValue = false
    this.newlineOffsets = []
    this.newlineStart = 0
    this.newlineCursor = 0
    this.newlinesSeen = 0
    return { delta, truncated }
  }

  snapshot(): { text: string; truncated: boolean } {
    return { text: this.decode(), truncated: this.droppedValue }
  }

  /**
   * Replace the window with the chunk's own capped tail. A chunk at least as
   * long as the ring contains every byte the combined stream could retain,
   * because the retained tail never exceeds the ring size, so earlier data is
   * released wholesale; every newline is still indexed so the line cap keeps
   * addressing newlines by their stream position.
   */
  private replaceWithChunkTail(bytes: Buffer, streamStart: number): void {
    let cut = bytes.length - this.maxBytes
    while (cut < bytes.length && ((bytes[cut] as number) & 0xc0) === 0x80) cut += 1
    for (let index = 0; index < bytes.length; index += 1) {
      if ((bytes[index] as number) === 0x0a) {
        this.newlineOffsets.push(streamStart + index)
        this.newlinesSeen += 1
      }
    }
    this.head = 0
    bytes.copy(this.ring, 0, cut)
    this.size = bytes.length - cut
    this.base = streamStart + bytes.length - this.size
    this.droppedValue = true
    this.purgeReleasedNewlines()
    this.enforceLineCap()
  }

  private enforceLineCap(): void {
    if (this.maxLines === undefined) return
    const excessSegments = this.newlinesSeen + 1 - this.maxLines
    if (excessSegments <= 0) return
    const target = excessSegments - 1 - this.newlineStart
    // A target behind the cursor lies outside the window, and the window start
    // already sits at or after that cut, so no further release is possible.
    if (target >= this.newlineCursor) this.dropHeadTo((this.newlineOffsets[target] as number) + 1)
    this.droppedValue = true
  }

  private enforceByteCap(): void {
    if (this.size <= this.maxBytes) return
    const limit = this.base + this.size
    let cut = limit - this.maxBytes
    while (cut < limit) {
      const physical = (this.head + cut - this.base) % this.ring.length
      if (((this.ring[physical] as number) & 0xc0) !== 0x80) break
      cut += 1
    }
    this.dropHeadTo(cut)
    this.droppedValue = true
  }

  private dropHeadTo(target: number): void {
    while (this.size > 0 && this.base < target) {
      const droppable = Math.min(target - this.base, this.size, this.ring.length - this.head)
      this.head = (this.head + droppable) % this.ring.length
      this.base += droppable
      this.size -= droppable
    }
    if (this.size === 0) this.head = 0
    this.purgeReleasedNewlines()
  }

  private purgeReleasedNewlines(): void {
    while (this.newlineCursor < this.newlineOffsets.length
      && (this.newlineOffsets[this.newlineCursor] as number) < this.base) {
      this.newlineCursor += 1
    }
    if (this.newlineCursor > 2048 && this.newlineCursor * 2 >= this.newlineOffsets.length) {
      this.newlineOffsets.splice(0, this.newlineCursor)
      this.newlineStart += this.newlineCursor
      this.newlineCursor = 0
    }
  }

  private decode(): string {
    if (this.size === 0) return ''
    if (this.head + this.size <= this.ring.length) {
      return this.ring.toString('utf8', this.head, this.head + this.size)
    }
    const linear = Buffer.allocUnsafe(this.size)
    this.ring.copy(linear, 0, this.head, this.ring.length)
    this.ring.copy(linear, this.ring.length - this.head, 0, this.head + this.size - this.ring.length)
    return linear.toString('utf8')
  }
}
