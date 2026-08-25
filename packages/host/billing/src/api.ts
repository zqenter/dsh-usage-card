/**
 * Browser-safe wire contracts of the usage dashboard: the types the sidebar
 * card reads over the `/billing` RPC channel, plus the peak/off-peak window
 * predicate both halves share. Zero imports — safe for the client bundle to
 * import type-only (the tsdown purity gate erases type-only imports; this
 * subpath keeps the shared facts in one place).
 *
 * The window follows DeepSeek's official 峰谷分时 pricing (effective
 * 2026-08-17): peak hours are BEIJING time 09:00–12:00 and 14:00–18:00, and
 * every other hour is off-peak (空闲) at half the peak price.
 */

/** Peak window 1 start: 09:00 Beijing time (UTC+8, no DST). */
export const PEAK_START_1_BEIJING_MINUTES = 9 * 60
/** Peak window 1 end: 12:00 Beijing time. */
export const PEAK_END_1_BEIJING_MINUTES = 12 * 60
/** Peak window 2 start: 14:00 Beijing time. */
export const PEAK_START_2_BEIJING_MINUTES = 14 * 60
/** Peak window 2 end: 18:00 Beijing time. */
export const PEAK_END_2_BEIJING_MINUTES = 18 * 60
const BEIJING_OFFSET_MS = 8 * 3_600_000

/**
 * Whether a Beijing-minute-of-day value falls inside a peak window.
 * @param minutes - minutes since Beijing midnight.
 * @returns true for [09:00, 12:00) and [14:00, 18:00).
 */
export function isBeijingPeakMinutes(minutes: number): boolean {
  return (minutes >= PEAK_START_1_BEIJING_MINUTES && minutes < PEAK_END_1_BEIJING_MINUTES)
    || (minutes >= PEAK_START_2_BEIJING_MINUTES && minutes < PEAK_END_2_BEIJING_MINUTES)
}

/**
 * Whether a Beijing-minute-of-day value falls inside the off-peak window.
 * @param minutes - minutes since Beijing midnight.
 * @returns true outside both peak windows (off-peak = half price).
 */
export function isOffPeakMinutes(minutes: number): boolean {
  return !isBeijingPeakMinutes(minutes)
}

/**
 * Whether an epoch falls inside the off-peak (discounted) window.
 * @param time - epoch ms.
 * @returns true when the Beijing clock is outside 09:00–12:00 and 14:00–18:00.
 */
export function isOffPeak(time: number): boolean {
  const minutes = Math.floor(((time + BEIJING_OFFSET_MS) % 86_400_000) / 60_000)
  return isOffPeakMinutes(minutes)
}

/** One currency row of the normalized balance view. */
export interface BalanceCurrencyView {
  currency: string
  total: number
  granted: number
  toppedUp: number
}

/** Browser-facing normalized balance view served by `billing.balance`. */
export interface BalanceView {
  /** Whether the account can currently make API calls. */
  isAvailable: boolean
  /** One row per reported currency, amounts as numbers. */
  currencies: BalanceCurrencyView[]
  /** Epoch ms of the successful fetch. */
  fetchedAt: number
}

/** Summed token buckets of the day's usage. */
export interface TodayUsageTokens {
  uncachedInput: number
  cacheRead: number
  cacheWrite: number
  output: number
  total: number
}

/** One day of the 7-day usage series. */
export interface DayUsage {
  /** Local calendar date (yyyy-mm-dd). */
  date: string
  /** Estimated total amount for the day. */
  amount: number
  /** Estimated amount of peak-window usage. */
  peakAmount: number
  /** Estimated amount of off-peak (discounted) usage. */
  offPeakAmount: number
  /** Summed token buckets of the day. */
  tokens: TodayUsageTokens
}

/** Data source of a usage report: official platform rows or a local-log estimate. */
export type UsageSource = 'official' | 'estimate'

/** The `today` report served by `billing.today`. */
export interface TodayUsageReport {
  /** Local calendar date (yyyy-mm-dd) of the reported window. */
  date: string
  /** IANA time zone the day window was computed in. */
  timeZone: string
  /** Model whose price table priced the estimate (estimate source only). */
  model: string
  /** Whether the figures come from the DeepSeek platform or a local estimate. */
  source: UsageSource
  /** Summed token buckets inside the day window. */
  tokens: TodayUsageTokens
  /** Total amount for the day (official platform cost, or estimated peak + off-peak). */
  amount: number
  /** Estimated amount of peak-window usage (estimate source only). */
  peakAmount: number
  /** Estimated amount of off-peak (discounted) usage (estimate source only). */
  offPeakAmount: number
  /** Number of usage-bearing steps priced (estimate source only). */
  pricedSamples: number
  /** Number of sessions folded (attached + cold; estimate source only). */
  sessionCount: number
  /** This month's total consumption (official source). */
  monthTotal?: number
  /** Lifetime (累计) consumption (official source). */
  lifetimeTotal?: number
  /** Today's request count (official source). */
  requests?: number
  /** Epoch ms the report was computed. */
  pricedAt: number
  /** The last 7 local days, oldest first, ending with the reported day. */
  days: DayUsage[]
}
