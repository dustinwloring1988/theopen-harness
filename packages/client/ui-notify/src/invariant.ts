/**
 * Package-owned invariant companion for `@buckeyestudio/toh-client-ui-notify`.
 * @module @buckeyestudio/toh-client-ui-notify/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@buckeyestudio/cordis'
import type { InvariantInstaller } from '@buckeyestudio/toh-invariants'

const PACKAGE_NAME = '@buckeyestudio/toh-client-ui-notify'

/** Cordis companion plugin name. */
export const name = 'client-ui-notify-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: every decision input (mode, focus, quiet window,
 * permission) is validated at its own boundary — the settings schema, the
 * Notification permission state, and the sessions list snapshot — and the
 * pure gate over them is exhaustively unit-tested in this package's specs.
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
