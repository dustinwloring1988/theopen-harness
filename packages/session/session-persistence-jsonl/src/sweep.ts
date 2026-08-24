/**
 * Best-effort startup sweep of crash-orphaned staging temporaries in a JSONL
 * storage root. Materialization writes `session<suffix>.<random>.tmp` beside
 * the final log and publishes it by link or no-overwrite rename, so no
 * published log ever carries the suffix while this process has created no
 * temporary at its own mount time. A surviving `*.tmp` file inside a session
 * directory is therefore residue when its mtime predates this process's start;
 * anything newer may belong to a live peer sharing the root and waits for a
 * later mount. The sweep runs once when the backend mounts.
 *
 * @module toh-session-persistence-jsonl/sweep
 */

import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Staging temporaries always carry this suffix; published logs never do. */
const TEMP_SUFFIX = /\.tmp$/

/**
 * Delete every `*.tmp` file inside every session directory below `root` whose
 * own mtime predates `startedBeforeMs`. Publication always targets the
 * `session.jsonl`/`session.jsonl.zstd` form, never `*.tmp`, so no published
 * log is reachable, and the age cutoff keeps an in-flight write by a live peer
 * safe. Directories, non-matching files, and logs are untouched. Individual
 * failures are skipped so one locked entry cannot hide the rest; only a
 * failure to enumerate propagates.
 * @param root - resolved JSONL storage root (may not exist yet).
 * @param startedBeforeMs - epoch milliseconds of this process's start.
 * @returns the number of temporaries removed.
 * @throws the enumeration error when the root or a project directory cannot be read.
 */
export async function sweepOrphanedTemps(root: string, startedBeforeMs: number): Promise<number> {
  let swept = 0
  for (const project of await listDirectories(root)) {
    for (const dir of await listDirectories(project)) {
      swept += await sweepDirectoryTemps(dir, startedBeforeMs)
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

/** Remove stale `*.tmp` files directly inside one session directory. */
async function sweepDirectoryTemps(dir: string, startedBeforeMs: number): Promise<number> {
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
      // lstat never follows a symlink: a planted link must not borrow the freshness of its target.
      const info = await lstat(path)
      if (info.mtimeMs >= startedBeforeMs) continue
      // rm on a symlink deletes the link itself; it never follows into a target.
      await rm(path, { force: true })
      swept += 1
    } catch {
      // A vanished or locked temp stays behind; the next startup retries it.
    }
  }
  return swept
}
