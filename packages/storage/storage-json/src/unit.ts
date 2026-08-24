/**
 * One opened JSON unit. The in-memory state is authoritative; every write
 * primitive republishes the whole file atomically. Each primitive enqueues one
 * publication on a per-unit chain, and its queue slot captures the previous
 * value, applies only its own mutation, and rolls that mutation back if
 * serializing or writing it fails: a slot publishes exactly the committed
 * earlier slots plus its own mutation, never a later pending one. Publications chain
 * because overlapping unchained calls stage independent temp files whose
 * renames complete in arbitrary order, letting an older snapshot rename last
 * and discard an already-resolved newer write. Ordering across separately
 * awaited calls remains the caller's responsibility (the domain layer's write
 * chain).
 * @module @buckeyestudio/toh-storage-json/src/unit
 */

import { readFile } from 'node:fs/promises'
import { StorageError } from '@buckeyestudio/toh-storage'
import type { KvUnit, KvUnitDescriptor } from '@buckeyestudio/toh-storage'
import { writeAtomic } from './atomic.ts'
import { parse, serialize } from './format.ts'
import type { UnitState } from './format.ts'

/**
 * Open (load or lazily create) one unit backed by `path`.
 * @param descriptor - Static identity and shape of the unit.
 * @param path - Absolute unit file path under the backend root.
 * @param onClose - Backend callback releasing the unit's open-slot.
 * @returns the opened unit.
 */
export async function openJsonUnit(
  descriptor: KvUnitDescriptor,
  path: string,
  onClose: () => void,
): Promise<KvUnit> {
  let text: string | undefined
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Missing file = empty unit; materialization defers to the first write.
  }
  const state: UnitState =
    text === undefined
      ? {
        version: descriptor.version,
        global: null,
        tables: new Map(descriptor.tables.map(table => [table, new Map<string, unknown>()])),
      }
      : parse(text, descriptor)
  return new JsonKvUnit(descriptor, path, state, onClose)
}

class JsonKvUnit implements KvUnit {
  private closed = false
  /** Publish-chain tail; every link settles, so one failure cannot poison the chain. */
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly descriptor: KvUnitDescriptor,
    private readonly path: string,
    private readonly state: UnitState,
    private readonly onClose: () => void,
  ) {}

  // oxlint-disable-next-line typescript/require-await -- async keeps the closed guard a rejection, not a synchronous throw
  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen()
    const tables: Record<string, Record<string, unknown>> = {}
    for (const [table, records] of this.state.tables) {
      tables[table] = Object.fromEntries(records)
    }
    return { tables, global: this.state.global }
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    const records = this.records(table)
    return this.enqueuePublish(async () => {
      // Capture, mutation, and rollback live inside the slot so no pending
      // later write leaks into this publication and no rejected write lingers
      // in memory past it. The async body routes a synchronous serialize
      // throw into the same catch as a failed write.
      const hadKey = records.has(key)
      const previous = records.get(key)
      records.set(key, value)
      try {
        await writeAtomic(this.path, serialize(this.descriptor.name, this.state))
      } catch (error) {
        if (hadKey) records.set(key, previous)
        else records.delete(key)
        throw error
      }
    })
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    const records = this.records(table)
    return this.enqueuePublish(async () => {
      const previous = records.get(key)
      if (!records.delete(key)) return
      try {
        await writeAtomic(this.path, serialize(this.descriptor.name, this.state))
      } catch (error) {
        records.set(key, previous)
        throw error
      }
    })
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    if (!this.descriptor.hasGlobal) {
      throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`)
    }
    return this.enqueuePublish(async () => {
      const previous = this.state.global
      this.state.global = value
      try {
        await writeAtomic(this.path, serialize(this.descriptor.name, this.state))
      } catch (error) {
        this.state.global = previous
        throw error
      }
    })
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.tail
      return
    }
    this.closed = true
    await this.tail
    this.onClose()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', `unit '${this.descriptor.name}' is closed`)
    }
  }

  private records(table: string): Map<string, unknown> {
    const records = this.state.tables.get(table)
    if (!records) {
      throw new Error(`unit '${this.descriptor.name}' does not declare table '${table}'`)
    }
    return records
  }

  /**
   * Chain one publish behind the previous one; rejections stay observed exactly
   * once by the caller's returned promise. A slot callback may resolve without
   * writing when it has nothing to publish.
   */
  private enqueuePublish(publish: () => Promise<void> | undefined): Promise<void> {
    const write = this.tail.then(publish)
    this.tail = write.then(() => undefined, () => undefined)
    return write
  }
}
