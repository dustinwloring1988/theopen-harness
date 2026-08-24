/**
 * One opened JSON unit. The in-memory state is authoritative; every write
 * primitive mutates it and republishes the whole file atomically. Publishes
 * serialize on an in-unit chain and read the state when their slot runs, so
 * overlapping un-awaited writes publish in call order and a slower earlier
 * rename can never land over a newer file (completion-order-wins would
 * silently discard an acknowledged record). Logical write ordering across
 * calls still belongs to the caller (the domain layer's write chain); this
 * unit only guarantees that each single call publishes a complete, durable
 * file that carries every acknowledged write issued before it. A failed
 * publish rolls back only its caller's mutation: when a later mutation on
 * the same target has already replaced the failed one in memory, the
 * rollback preserves that mutation and hands the restore target to the
 * later mutation's own rollback. Both paths append one replacement publish,
 * so the medium converges to the acknowledged state — a rejected write
 * never persists, and an older failed write never discards a newer
 * acknowledged one.
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

/** Prior value of one mutation target: what a failed attempt must restore. */
interface PriorValue {
  /** Whether the target held a record before the attempted mutation. */
  present: boolean
  /** The record value when {@link present} is `true`; ignored otherwise. */
  value: unknown
}

/**
 * Mutation ordering state for one target (one record key, or the global
 * slot): a ticket counter over attempted mutations plus the restore target
 * handed down by a failed attempt that a later attempt superseded.
 */
interface TargetMutations {
  revision: number
  deferredRestore?: PriorValue
}

const GLOBAL_TARGET = '\u0000global'

function restoreRecord(records: Map<string, unknown>, key: string): (prior: PriorValue) => void {
  return (prior) => {
    if (prior.present) records.set(key, prior.value)
    else records.delete(key)
  }
}

class JsonKvUnit implements KvUnit {
  private closed = false
  /**
   * Settled tail of the publish chain: every publish appends one
   * whole-file replacement behind all earlier ones, and a rejected link is
   * swallowed here so one failed write cannot poison the chain (the
   * rejecting caller still observes its own error). The rejecting caller's
   * rollback then appends one replacement of the acknowledged state, so the
   * medium never keeps a rejected mutation past that replacement.
   */
  private publishTail: Promise<void> = Promise.resolve()

  /** Per-target mutation ordering state; entries live only while mutations on the target may still roll back. */
  private readonly targetMutations = new Map<string, TargetMutations>()

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
    const target = `${table}\u0000${key}`
    const revision = this.beginMutation(target)
    const prior: PriorValue = { present: records.has(key), value: records.get(key) }
    records.set(key, value)
    // Roll back on a failed publish: memory is authoritative, so a rejected
    // write must not survive in memory (or ride along with the next publish)
    // — unless a later mutation on this key already replaced it.
    await this.publish().catch((error: unknown) => {
      this.rollbackMutation(target, revision, prior, restoreRecord(records, key))
      throw error
    })
    this.acknowledgeMutation(target, revision)
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    const records = this.records(table)
    const target = `${table}\u0000${key}`
    if (!records.has(key)) {
      if (!this.targetMutations.has(target)) return
      // An overlapping mutation on the key may still roll a failed publish
      // back to the last acknowledged value and hand its restore to the
      // newest ticket: settle the queue first, then apply that restore —
      // re-deleting the record when it comes back — so a resolved delete
      // always outlives every earlier mutation's rollback. A mutation issued
      // after this one owns the record's fate instead, so this delete
      // resolves without touching it.
      const ticket = this.beginMutation(target)
      await this.drain()
      const settled = this.targetMutations.get(target)
      if (settled === undefined || settled.revision !== ticket) return
      const deferred = settled.deferredRestore
      this.targetMutations.delete(target)
      if (deferred === undefined) return
      restoreRecord(records, key)(deferred)
      if (!deferred.present) {
        // Absence is the required restore target, so this publish is the
        // durable empty state a resolved delete promises: await it and
        // propagate its failure instead of leaving the replacement
        // best-effort.
        const revision = this.beginMutation(target)
        records.delete(key)
        await this.publish().catch((error: unknown) => {
          this.rollbackMutation(target, revision, deferred, restoreRecord(records, key))
          throw error
        })
        this.acknowledgeMutation(target, revision)
        return
      }
    }
    const revision = this.beginMutation(target)
    const prior: PriorValue = { present: true, value: records.get(key) }
    records.delete(key)
    await this.publish().catch((error: unknown) => {
      this.rollbackMutation(target, revision, prior, restoreRecord(records, key))
      throw error
    })
    this.acknowledgeMutation(target, revision)
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    if (!this.descriptor.hasGlobal) {
      throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`)
    }
    const revision = this.beginMutation(GLOBAL_TARGET)
    const prior: PriorValue = { present: true, value: this.state.global }
    this.state.global = value
    await this.publish().catch((error: unknown) => {
      this.rollbackMutation(GLOBAL_TARGET, revision, prior, (restored) => {
        this.state.global = restored.value
      })
      throw error
    })
    this.acknowledgeMutation(GLOBAL_TARGET, revision)
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.drain()
      return
    }
    this.closed = true
    await this.drain()
    this.onClose()
  }

  /**
   * Await the publish chain to quiescence: a failed publish appends its
   * replacement while the tail is being awaited, so keep waiting until a
   * wait observes no new link. The tail never rejects, so this cannot throw.
   * After the drain the medium matches memory: every landed slot serialized
   * the state current at its turn, and a rejected mutation is dropped by its
   * caller's replacement.
   */
  private async drain(): Promise<void> {
    let tail = this.publishTail
    for (;;) {
      await tail
      if (this.publishTail === tail) return
      tail = this.publishTail
    }
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

  /**
   * Ticket one attempted mutation on `target`, ordered after every earlier
   * attempt on the same target.
   */
  private beginMutation(target: string): number {
    const mutations = this.targetMutationsFor(target)
    return ++mutations.revision
  }

  /**
   * Acknowledge one published mutation on `target`: its value is now the
   * acknowledged state, so a restore target handed down by an older failed
   * attempt no longer applies. When no later attempt has been issued, the
   * bookkeeping drops entirely.
   */
  private acknowledgeMutation(target: string, revision: number): void {
    const mutations = this.targetMutations.get(target)
    if (mutations === undefined) return
    delete mutations.deferredRestore
    if (mutations.revision === revision) this.targetMutations.delete(target)
  }

  /**
   * Roll back one failed mutation without discarding later mutations on the
   * same target. When the failed attempt is still the target's newest,
   * memory returns to its prior value — or to a value handed down by an
   * older failed attempt it had superseded, which skips past every rejected
   * value back to the last acknowledged state. When a later attempt has been
   * issued, memory keeps it and the prior hands down as that attempt's
   * rollback target. Both paths append a replacement publish: an earlier
   * slot may have landed the failed mutation, and the medium must converge
   * to memory.
   */
  private rollbackMutation(
    target: string,
    revision: number,
    prior: PriorValue,
    restore: (prior: PriorValue) => void,
  ): void {
    const mutations = this.targetMutationsFor(target)
    if (mutations.revision !== revision) {
      mutations.deferredRestore ??= prior
      this.republishCurrentState()
      return
    }
    const restored = mutations.deferredRestore ?? prior
    this.targetMutations.delete(target)
    restore(restored)
    this.republishCurrentState()
  }

  private targetMutationsFor(target: string): TargetMutations {
    let mutations = this.targetMutations.get(target)
    if (!mutations) {
      mutations = { revision: 0 }
      this.targetMutations.set(target, mutations)
    }
    return mutations
  }

  /**
   * Append one replacement after a failed publish so the medium drops the
   * rejected mutation: an earlier slot may have already landed it while the
   * failing call was queued behind it. The replacement serializes current
   * memory — the restored prior, or the later mutation a superseded rollback
   * preserved. Best-effort: if this replacement also fails the medium is
   * left as-is and the rejection is swallowed here, because the caller
   * already received the primary error.
   */
  private republishCurrentState(): void {
    this.publish().catch(noop)
  }
}
