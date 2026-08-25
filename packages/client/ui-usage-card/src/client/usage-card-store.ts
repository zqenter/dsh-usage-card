/**
 * State owner of the usage card: polls the `/billing` loopback RPC channel
 * (balance + today) on a timer, exposing a uSES-safe snapshot store.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { BalanceView, TodayUsageReport } from '@deepseek-ai/dsh-host-billing/api'

/** Browser state of the usage card. */
export interface UsageCardState {
  /** Loading while a refresh is in flight; ready after the first success; error on RPC failure. */
  status: 'loading' | 'ready' | 'error'
  /** Last successful balance view; undefined before the first success. */
  balance: BalanceView | undefined
  /** Last successful today report; undefined before the first success. */
  today: TodayUsageReport | undefined
  /** Last failure diagnostic; null while ready/loading. */
  error: string | null
  /** Epoch ms of the last successful refresh. */
  refreshedAt: number | null
}

/** Card refresh cadence: near-real-time polling for a glance dashboard. */
export const REFRESH_INTERVAL_MS = 15_000

/** Error text of the first failing call, when either call failed. */
function failureOf(
  balance: { ok: boolean; error?: { message: string } },
  today: { ok: boolean; error?: { message: string } },
): string {
  if (!balance.ok && balance.error !== undefined) return balance.error.message
  if (!today.ok && today.error !== undefined) return today.error.message
  return 'unknown error'
}

/**
 * Polls balance + today usage through the connection RPC channel.
 * @param rpc - the browser RPC caller (`ctx.connection.rpc`).
 * @param timeZone - resolves the caller's IANA zone per refresh (the host
 *   computes the local day window from it).
 */
export class UsageCardStore {
  /** uSES-safe state source shared by the registered card. */
  readonly store: SnapshotStore<UsageCardState> = createSnapshotStore({
    status: 'loading', balance: undefined, today: undefined, error: null, refreshedAt: null,
  })

  private timer: number | undefined
  private generation = 0

  constructor(
    private readonly rpc: Pick<ClientConnectionRpc, 'call'>,
    private readonly timeZone: () => string,
  ) {}

  /**
   * Start the refresh loop: one immediate refresh, then a timer.
   */
  start(): void {
    void this.refresh()
    this.timer = window.setInterval(() => { void this.refresh() }, REFRESH_INTERVAL_MS)
  }

  /**
   * Stop the refresh loop and invalidate any in-flight refresh.
   */
  dispose(): void {
    this.generation += 1
    if (this.timer !== undefined) window.clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * Refresh balance and today usage in parallel; stale responses (a newer
   * refresh already ran, or the store was disposed) are dropped.
   */
  async refresh(): Promise<void> {
    const generation = this.generation
    this.store.update((state) => { state.status = 'loading' })
    const timeZone = this.timeZone()
    const [balanceResult, todayResult] = await Promise.all([
      this.rpc.call('/billing', 'balance', {}, undefined),
      this.rpc.call('/billing', 'today', { timeZone }, undefined),
    ])
    if (generation !== this.generation) return
    if (!balanceResult.ok || !todayResult.ok) {
      this.store.update((state) => {
        state.status = 'error'
        state.error = failureOf(balanceResult, todayResult)
      })
      return
    }
    this.store.update((state) => {
      state.status = 'ready'
      state.balance = balanceResult.value as BalanceView
      state.today = todayResult.value as TodayUsageReport
      state.error = null
      state.refreshedAt = Date.now()
    })
  }
}
