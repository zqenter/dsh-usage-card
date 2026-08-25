/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-usage-card`.
 * @module @deepseek-ai/dsh-client-ui-usage-card/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-usage-card'

/** Cordis companion plugin name. */
export const name = 'client-ui-usage-card-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the card owns no cross-plugin mutable state (its
 * store is private), and the served facts are RPC reads — the pure period and
 * formatting helpers are asserted directly by this package's specs.
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
