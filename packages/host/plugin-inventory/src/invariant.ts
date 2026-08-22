/** Package-owned invariant companion. @module @buckeyestudio/toh-host-plugin-inventory/invariant */

/* jscpd:ignore-start */
import type { Context } from '@buckeyestudio/cordis'
import type { InvariantInstaller } from '@buckeyestudio/toh-invariants'

const PACKAGE_NAME = '@buckeyestudio/toh-host-plugin-inventory'

/** Cordis companion plugin name. */
export const name = 'host-plugin-inventory-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: every snapshot is projected directly from Loader-owned state. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
