/**
 * Best-effort startup sweep of crash-orphaned staging temporaries in a JSONL
 * storage root. Materialization writes `session<suffix>.<random>.tmp` beside
 * the final log and publishes it by link or no-overwrite rename, so any
 * surviving `*.tmp` file inside a session directory is residue from a process
 * that died between the temp write and publication — discovery never reads
 * those names. The sweep runs once when the backend mounts.
 *
 * @module toh-session-persistence-jsonl/sweep
 */

import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Staging temporaries always carry this suffix; published logs never do. */
const TEMP_SUFFIX = /\.tmp$/

/**
 * Delete every `*.tmp` file inside every session directory below `root`. The
 * name is the garbage proof: a published log always takes the
 * `session.jsonl`/`session.jsonl.zstd` form, never `*.tmp`. Directories,
 * non-matching files, and logs are untouched. Individual failures are skipped
 * so one locked entry cannot hide the rest; only a failure to enumerate
 * propagates.
 * @param root - resolved JSONL storage root (may not exist yet).
 * @returns the number of temporaries removed.
 * @throws the enumeration error when the root or a project directory cannot be read.
 */
export async function sweepOrphanedTemps(root: string): Promise<number> {
  let swept = 0
  for (const project of await listDirectories(root)) {
    for (const dir of await listDirectories(project)) {
      swept += await sweepDirectoryTemps(dir)
    }
  }
  return swept
}

// Each backend owns its sweep beside its storage code; extracting this trivial
// directory walk into a shared package would add a dependency edge for ten lines.
/* jscpd:ignore-start */
/** Read one directory's immediate subdirectories; an absent directory has none. */
async function listDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => join(path, entry.name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return []
    throw error
  }
}
/* jscpd:ignore-end */

/** Remove `*.tmp` files directly inside one session directory. */
async function sweepDirectoryTemps(dir: string): Promise<number> {
  let swept = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    // A session directory removed by a concurrent process has nothing to sweep.
    return 0
  }
  for (const entry of entries) {
    if (!TEMP_SUFFIX.test(entry.name)) continue
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    const path = join(dir, entry.name)
    try {
      // rm on a symlink deletes the link itself; it never follows into a target.
      await rm(path, { force: true })
      swept += 1
    } catch {
      // A vanished or locked temp stays behind; the next startup retries it.
    }
  }
  return swept
}
