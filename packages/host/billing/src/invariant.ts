/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-host-billing`.
 * @module @deepseek-ai/dsh-host-billing/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-billing'

/** Cordis companion plugin name. */
export const name = 'host-billing-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the plugin owns no mutable cross-plugin state beyond
 * its own report cache, and the served facts are pure functions of the
 * session store and the balance endpoint — asserted directly by this
 * package's fold/price specs and the RPC handler spec.
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
