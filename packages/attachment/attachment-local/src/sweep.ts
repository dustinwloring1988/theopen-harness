/**
 * Best-effort startup sweep of crash-orphaned staging residue in a local
 * attachment root. Object publication stages under `tmp/<uuid>` and hard-links
 * to the content-addressed target; request-image publication writes
 * `<hash>.<uuid>.tmp` beside the cache object and renames it into place. No
 * published object or cached variant ever takes a staged or `.tmp` name, and
 * this process has created nothing yet at its own mount time, so residue from
 * a writer that died before publishing is exactly the set of candidates older
 * than this process's start — anything newer may belong to a live peer sharing
 * the root and waits for a later mount. Both swept locations apply that age
 * discriminator to each candidate's own (never symlink-followed) mtime. The
 * store sweeps both locations once when it mounts.
 *
 * @module @buckeyestudio/toh-attachment-local/sweep
 */

import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Request-image temporaries always carry this suffix; cache objects never do. */
const TEMP_SUFFIX = /\.tmp$/

/**
 * Delete crash residue below `root`: every entry of `<root>/tmp` and every
 * `*.tmp` file in `<root>/request-images/<prefix>/` whose own mtime predates
 * `startedBeforeMs`. Stored objects, cached variants, and non-matching files
 * are untouched. Individual failures are skipped so one locked entry cannot
 * hide the rest; only an enumeration failure propagates.
 * @param root - absolute versioned attachment storage root (`attachments/v1`).
 * @param startedBeforeMs - epoch milliseconds of this process's start.
 * @returns the number of files removed.
 * @throws the enumeration error when a swept location exists but cannot be read.
 */
export async function sweepStagingResidue(root: string, startedBeforeMs: number): Promise<number> {
  return await sweepTmpDir(join(root, 'tmp'), startedBeforeMs)
    + await sweepRequestImageTemps(join(root, 'request-images'), startedBeforeMs)
}

/** Remove every stale file directly inside the private staging directory. */
async function sweepTmpDir(staging: string, startedBeforeMs: number): Promise<number> {
  let entries
  try {
    entries = await readdir(staging, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return 0
    throw error
  }
  let swept = 0
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    if (await removeIfStale(join(staging, entry.name), startedBeforeMs)) swept += 1
  }
  return swept
}

/** Remove every stale `*.tmp` file inside each two-hex-character request-image bucket. */
async function sweepRequestImageTemps(cacheRoot: string, startedBeforeMs: number): Promise<number> {
  let swept = 0
  for (const bucket of await listDirectories(cacheRoot)) {
    let entries
    try {
      entries = await readdir(bucket, { withFileTypes: true })
    } catch {
      // A bucket removed by a concurrent process has nothing to sweep.
      continue
    }
    for (const entry of entries) {
      if (!TEMP_SUFFIX.test(entry.name)) continue
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      if (await removeIfStale(join(bucket, entry.name), startedBeforeMs)) swept += 1
    }
  }
  return swept
}

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

/** Remove one path whose own (never symlink-followed) mtime predates the cutoff. */
async function removeIfStale(path: string, startedBeforeMs: number): Promise<boolean> {
  try {
    // lstat never follows a symlink: a planted link must not borrow the
    // freshness or staleness of whatever it points at.
    const info = await lstat(path)
    if (info.mtimeMs >= startedBeforeMs) return false
    await rm(path, { force: true })
    return true
  } catch {
    // A vanished or locked file stays behind; the next startup retries it.
    return false
  }
}
