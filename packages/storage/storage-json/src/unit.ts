/**
 * One opened JSON unit. The in-memory state is authoritative; every write
 * primitive mutates it and republishes the whole file atomically. Publishes
 * serialize on an in-unit chain and read the state when their slot runs, so
 * overlapping un-awaited writes publish in call order and a slower earlier
 * rename can never land over a newer file (completion-order-wins would
 * silently discard an acknowledged record). Logical write ordering across
 * calls still belongs to the caller (the domain layer's write chain); this
 * unit only guarantees that each single call publishes a complete, durable
 * file that carries every acknowledged write issued before it.
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

const noop = (): void => {}

class JsonKvUnit implements KvUnit {
  private closed = false
  /**
   * Settled tail of the publish chain: every publish appends one
   * whole-file replacement behind all earlier ones, and a rejected link is
   * swallowed here so one failed write cannot poison the chain (the
   * rejecting caller still observes its own error).
   */
  private publishTail: Promise<void> = Promise.resolve()

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
    const hadKey = records.has(key)
    const previous = records.get(key)
    records.set(key, value)
    // Roll back on a failed publish: memory is authoritative, so a rejected
    // write must not survive in memory (or ride along with the next publish).
    await this.publish().catch((error: unknown) => {
      if (hadKey) records.set(key, previous)
      else records.delete(key)
      throw error
    })
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    const records = this.records(table)
    if (!records.has(key)) return
    const previous = records.get(key)
    records.delete(key)
    await this.publish().catch((error: unknown) => {
      records.set(key, previous)
      throw error
    })
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    if (!this.descriptor.hasGlobal) {
      throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`)
    }
    const previous = this.state.global
    this.state.global = value
    await this.publish().catch((error: unknown) => {
      this.state.global = previous
      throw error
    })
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.publishTail
      return
    }
    this.closed = true
    // Draining the tail waits out every queued publish, held or not yet
    // started; the tail never rejects, so this cannot throw. After the drain
    // the medium matches memory: the last landed slot serialized the full
    // state, and any failed publish rolled its caller's mutation back before
    // the next slot serialized.
    await this.publishTail
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

  private publish(): Promise<void> {
    // The state is read inside the slot, not at enqueue time: each publish
    // serializes every mutation acknowledged up to its turn, so the renames
    // land in queue order and the last one always carries the newest state.
    // Swallow only on the tracking branch: the caller still awaits `write`
    // itself, so rejections stay observed exactly once.
    const write = this.publishTail.then(() =>
      writeAtomic(this.path, serialize(this.descriptor.name, this.state)),
    )
    this.publishTail = write.then(noop, noop)
    return write
  }
}
