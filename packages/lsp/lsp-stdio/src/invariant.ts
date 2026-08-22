/**
 * Package-owned invariant companion for `@buckeyestudio/toh-lsp-stdio`.
 * @module @buckeyestudio/toh-lsp-stdio/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@buckeyestudio/cordis'
import type { InvariantInstaller } from '@buckeyestudio/toh-invariants'

const PACKAGE_NAME = '@buckeyestudio/toh-lsp-stdio'

/** Cordis companion plugin name. */
export const name = 'lsp-stdio-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: process pools and per-workspace queues are private implementation state,
 * and this provider publishes no independent lifecycle event stream or enumerable snapshot.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
