/**
 * Usage dashboard card plugin, browser half: renders the `sidebar.footer.action`
 * occupant — the balance / today / peak-off-peak card above the Settings
 * button — and owns the `usage-card` dictionaries. Data is polled from the
 * `/billing` loopback RPC channel (registered by dsh-host-billing) through a
 * small shared store; the card itself only renders.
 * Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
// Type-only: the footer-action slot declaration lives in ui-sidebar's
// 'sidebar' entry; the locale plugin's Context merge provides ctx.locale.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { UsageCard } from './UsageCard.tsx'
import type { UsageCardInjected } from './UsageCard.tsx'
import { UsageCardStore } from './usage-card-store.ts'
import { en, zh, type UsageCardKey } from './locales.ts'

export type { UsageCardInjected, UsageCardProps } from './UsageCard.tsx'
export { REFRESH_INTERVAL_MS, UsageCardStore } from './usage-card-store.ts'
export type { UsageCardState } from './usage-card-store.ts'
export {
  currentPeriod, currencySymbol, formatAmount, formatClock, formatDayLabel, formatTokens,
  isOffPeak, isPeak, peakWindowLabel,
} from './period.ts'
export type { BillingPeriod } from './period.ts'
export type { UsageCardKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Usage card copy. */
    'usage-card': UsageCardKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'usage-card'

/**
 * Required services: slots (registration), connection (the RPC caller), and
 * locale (dictionaries + the `t` seat).
 */
export const inject = ['slots', 'connection', 'locale']

/**
 * Register the `usage-card` dictionaries and the footer-action occupant, each
 * once its slot declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-usage-card: dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  const store = new UsageCardStore(connection.rpc, () => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const useSnapshot = bindSnapshotSelector(store.store)
  const injected = (): UsageCardInjected => ({ store, useSnapshot, rpc: connection.rpc })

  ctx.effect(() => {
    store.start()
    return () => { store.dispose() }
  }, 'ui-usage-card: refresh loop')
  // A reconnect invalidates the served numbers: refetch right away.
  ctx.effect(() => ctx.on('connection/reset', () => { void store.refresh() }), 'ui-usage-card: reconnect refresh')

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'usage-card',
    order: 0,
    locale: NS,
    inject: injected,
  }, UsageCard))
}
