/** Package-owned invariant companion for the bash seam. @module @buckeyestudio/toh-shell/invariant */

import type { Context } from '@buckeyestudio/cordis'
import type { InvariantInstaller } from '@buckeyestudio/toh-invariants'

const PACKAGE_NAME = '@buckeyestudio/toh-shell'

/** Cordis companion plugin name. */
export const name = 'shell-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: this stateless Service Definition owns request/result types, while executors and policy own observations. */
const install: InvariantInstaller = () => {}

/**
 * Register the bash invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
