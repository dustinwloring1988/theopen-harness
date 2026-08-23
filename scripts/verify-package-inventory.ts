/**
 * Diff the hand-maintained package-group inventories against the workspace on
 * disk, so the accuracy drift the generated catalogs are freshness-gated
 * against cannot recur silently in hand-edited tables. Root `AGENTS.md`
 * (repository-layout block) and the [`packages/README.md`](../packages/README.md)
 * group table must each name exactly the group directories under `packages/`.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/** One parsed inventory: the group names it lists and where it lives. */
interface Inventory {
  /** Repo-relative path reported in violations. */
  source: string
  /** Group directory names in listed order. */
  groups: string[]
}

/** The authoritative group set: every directory under `packages/`. */
function diskGroups(): string[] {
  return readdirSync(resolve(root, 'packages'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
}

/**
 * Extract the `group/` tokens of the `packages/` section from the fenced
 * repository-layout block in root `AGENTS.md`: indented child rows between the
 * `packages/` row and the next top-level row.
 * @returns the inventory parsed from the layout block.
 */
function agentsLayoutGroups(): Inventory {
  const source = 'AGENTS.md'
  const lines = readFileSync(resolve(root, source), 'utf8').split('\n')
  const groups: string[] = []
  let collecting = false
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (collecting) break
      continue
    }
    if (collecting) {
      const child = /^ {2}([a-z0-9-]+)\/(?:\s|$)/.exec(line)
      if (child) groups.push(child[1])
      else collecting = false
      continue
    }
    if (line.startsWith('packages/')) collecting = true
  }
  return { source, groups }
}

/** Parse the group rows of the [`packages/README.md`](../packages/README.md) hierarchy table. */
function packagesTableGroups(): Inventory {
  const source = 'packages/README.md'
  const text = readFileSync(resolve(root, source), 'utf8')
  const groups = [...text.matchAll(/^\| \[`([a-z0-9-]+)\/`\]/gm)].map(match => match[1] ?? '')
  return { source, groups }
}

/**
 * Compare one hand-maintained inventory with the authoritative disk set.
 * @param inventory - parsed list under test.
 * @param expected - sorted group directories on disk.
 * @returns violation lines; empty when the inventory is exact.
 */
function compare(inventory: Inventory, expected: readonly string[]): string[] {
  const expectedSet = new Set(expected)
  const listed = new Set(inventory.groups)
  const violations = inventory.groups
    .filter((group, index) => inventory.groups.indexOf(group) !== index)
    .map(group => `${inventory.source}: duplicate group ${JSON.stringify(group)}.`)
  for (const group of expectedSet) {
    if (!listed.has(group)) violations.push(`${inventory.source}: missing group ${JSON.stringify(group)} present under packages/.`)
  }
  for (const group of listed) {
    if (!expectedSet.has(group)) violations.push(`${inventory.source}: stale group ${JSON.stringify(group)} absent from disk.`)
  }
  return violations
}

const expected = diskGroups()
const violations = [agentsLayoutGroups(), packagesTableGroups()].flatMap(inventory => compare(inventory, expected))
if (violations.length > 0) {
  console.error('verify-package-inventory failed:\n')
  for (const violation of violations) console.error(`  ${violation}`)
  console.error('\nThe hand-maintained inventories must match packages/*/ on disk; update them together.')
  process.exit(1)
}
console.log(`verify-package-inventory: ${expected.length} groups match AGENTS.md and packages/README.md.`)
