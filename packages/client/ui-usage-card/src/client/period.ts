/**
 * Pure presentation helpers of the usage card: the peak/off-peak period
 * predicate (mirrors the host's shared window — the client bundle cannot
 * value-import host code), and the token/amount/clock formatters.
 */

const BEIJING_OFFSET_MS = 8 * 3_600_000

/** Peak window 1: 09:00–12:00 Beijing time (DeepSeek official 峰谷 pricing). */
export const PEAK_START_1_BEIJING_MINUTES = 9 * 60
export const PEAK_END_1_BEIJING_MINUTES = 12 * 60
/** Peak window 2: 14:00–18:00 Beijing time. */
export const PEAK_START_2_BEIJING_MINUTES = 14 * 60
export const PEAK_END_2_BEIJING_MINUTES = 18 * 60

/**
 * Whether an epoch falls in a peak window (Beijing 09:00–12:00 / 14:00–18:00),
 * mirroring `dsh-host-billing/api`.
 * @param time - epoch ms.
 * @returns true inside either peak window.
 */
export function isPeak(time: number): boolean {
  const minutes = Math.floor(((time + BEIJING_OFFSET_MS) % 86_400_000) / 60_000)
  return (minutes >= PEAK_START_1_BEIJING_MINUTES && minutes < PEAK_END_1_BEIJING_MINUTES)
    || (minutes >= PEAK_START_2_BEIJING_MINUTES && minutes < PEAK_END_2_BEIJING_MINUTES)
}

/**
 * Whether an epoch falls in the off-peak (空闲) window — everything outside
 * the peak windows, priced at half the peak rate.
 * @param time - epoch ms.
 * @returns true outside both peak windows.
 */
export function isOffPeak(time: number): boolean {
  return !isPeak(time)
}

/** The billing period a clock reading falls in. */
export type BillingPeriod = 'peak' | 'off-peak'

/**
 * Current billing period of an epoch.
 * @param now - epoch ms.
 * @returns `off-peak` outside the peak windows, `peak` otherwise.
 */
export function currentPeriod(now: number): BillingPeriod {
  return isOffPeak(now) ? 'off-peak' : 'peak'
}

/** Trim a scaled value for token counts: 1.0 → "1", 1.25 → "1.3". */
function trimScaled(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '')
}

/**
 * Humanize a token count: < 1000 verbatim, else "X.XK"/"X.XM".
 * @param count - raw token count.
 * @returns the compact display string.
 */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${trimScaled(count / 1_000_000)}M`
  if (count >= 1_000) return `${trimScaled(count / 1_000)}K`
  return String(count)
}

/**
 * Currency symbol of an ISO currency code (CNY/USD known, else the code itself).
 * @param currency - ISO currency code.
 * @returns the display prefix.
 */
export function currencySymbol(currency: string): string {
  if (currency === 'CNY') return '¥'
  if (currency === 'USD') return '$'
  return `${currency} `
}

/**
 * Format an amount with its currency symbol (integer display: whole units,
 * no decimals).
 * @param amount - the amount.
 * @param currency - ISO currency code (default CNY).
 * @returns e.g. "¥12".
 */
export function formatAmount(amount: number, currency = 'CNY'): string {
  return `${currencySymbol(currency)}${Math.round(amount)}`
}

/**
 * Local HH:MM clock of an epoch in a time zone.
 * @param time - epoch ms.
 * @param timeZone - IANA time zone name.
 * @returns the clock string.
 */
export function formatClock(time: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(time)
}

/**
 * Display label of the peak window (DeepSeek defines it in Beijing time).
 * @returns e.g. "9:00–12:00、14:00–18:00（北京时间）".
 */
export function peakWindowLabel(): string {
  return '9:00–12:00、14:00–18:00（北京时间）'
}

/**
 * Compact chart label for an ISO local date (yyyy-mm-dd): "01/15".
 * @param date - the ISO date.
 * @returns the MM/DD label.
 */
export function formatDayLabel(date: string): string {
  return date.slice(5).replace('-', '/')
}
