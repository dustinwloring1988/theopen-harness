/**
 * Package-owned invariant companion for `@buckeyestudio/toh-tool-session-query`.
 * @module @buckeyestudio/toh-tool-session-query/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@buckeyestudio/cordis'
import type { InvariantInstaller } from '@buckeyestudio/toh-invariants'

const PACKAGE_NAME = '@buckeyestudio/toh-tool-session-query'

/** Cordis companion plugin name. */
export const name = 'tool-session-query-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this read-only model adapter owns no event or mutable
 * data relationship beyond the registries that already validate registration.
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
