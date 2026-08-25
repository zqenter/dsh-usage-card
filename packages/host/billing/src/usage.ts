/**
 * Pure folds for the usage dashboard: token-bucket extraction from session
 * events, local-day windowing, and per-event cost estimation under the
 * peak/off-peak price schedule. All functions are deterministic functions of
 * their inputs so the plugin's RPC handlers stay thin and testable.
 *
 * Cost facts: the harness records provider-reported token usage per step, but
 * no per-request model id or billed price, so the amount is an ESTIMATE over
 * the configured per-model price table, priced per event at the schedule in
 * effect at that event's own timestamp (off-peak discount factor applied to
 * events inside the DeepSeek off-peak window). Reasoning tokens ride output
 * tokens on the wire (DeepSeek's `completion_tokens` includes reasoning), so
 * output is priced once.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { isOffPeak } from './api.ts'

/** Token buckets of one usage report (reasoning already inside output). */
export interface UsageBuckets {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

/** One priced usage observation: bucket totals plus the event's own time. */
export interface UsageSample {
  /** Epoch ms of the usage-bearing event. */
  time: number
  buckets: UsageBuckets
}

/** Per-million-token price of one model, in the balance currency. */
export interface ModelPrice {
  /** Cache-miss input price per million tokens. */
  inputPerMillion: number
  /** Cache-hit input price per million tokens (cache writes price like hits). */
  cacheReadPerMillion: number
  /** Output price per million tokens (reasoning included). */
  outputPerMillion: number
}

/** Sum two bucket sets (mutation-free; used to merge live samples). */
export function addBuckets(left: UsageBuckets, right: UsageBuckets): UsageBuckets {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  }
}

/** The all-zero bucket set. */
export function zeroBuckets(): UsageBuckets {
  return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
}

/** Extract the provider usage record carried by one session event, if any. */
export function usageOf(event: SessionEvent): TokenUsage | undefined {
  if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
    return event.data.chunk.usage
  }
  if (event.type === 'assistant/message') return event.data.usage
  return undefined
}

/** One usage-bearing step of a session event: its (turn, step) key + usage. */
function usageStepOf(event: SessionEvent): { key: string; usage: TokenUsage } | undefined {
  if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
    return { key: `${event.data.turn}/${event.data.step}`, usage: event.data.chunk.usage }
  }
  if (event.type === 'assistant/message' && event.data.usage !== undefined) {
    return { key: `${event.data.turn}/${event.data.step}`, usage: event.data.usage }
  }
  return undefined
}

function bucketsFrom(usage: TokenUsage): UsageBuckets {
  return {
    uncachedInputTokens: usage.inputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    outputTokens: usage.outputTokens,
  }
}

/**
 * Fold a session log into usage samples inside one time window. A step's
 * usage arrives cumulatively (trailing usage chunk and final message both
 * report the step total), so per (turn, step) the LAST report wins and only
 * the winning report becomes a sample — mirrors the token meter's
 * same-step-replaces fold. Events outside the window are ignored.
 * @param events - the session's event log.
 * @param window - inclusive start / exclusive end epoch ms.
 * @returns one sample per usage-bearing (turn, step) inside the window.
 */
export function foldSamples(
  events: readonly SessionEvent[],
  window: { start: number; end: number },
): UsageSample[] {
  const lastByStep = new Map<string, UsageSample>()
  for (const event of events) {
    if (event.time < window.start || event.time >= window.end) continue
    const step = usageStepOf(event)
    if (step === undefined) continue
    lastByStep.set(step.key, { time: event.time, buckets: bucketsFrom(step.usage) })
  }
  return [...lastByStep.values()]
}

/** The day window (index into `windows`) containing an epoch, or -1. */
function dayIndexOf(windows: ReadonlyArray<{ start: number; end: number }>, time: number): number {
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index]
    if (window !== undefined && time >= window.start && time < window.end) return index
  }
  return -1
}

/**
 * The last `count` local day windows, oldest first, ending with the day
 * containing `now`. Each window is the exact local midnight-bounded day, so
 * DST-length days stay correct across the whole span.
 * @param timeZone - IANA time zone name.
 * @param now - epoch ms inside the last day.
 * @param count - number of days.
 * @returns the day windows, oldest first.
 */
export function recentDayWindows(
  timeZone: string,
  now: number,
  count: number,
): Array<{ start: number; end: number }> {
  const windows: Array<{ start: number; end: number }> = []
  let cursor = now
  for (let index = 0; index < count; index += 1) {
    const window = localDayWindow(timeZone, cursor)
    windows.unshift(window)
    cursor = window.start - 1
  }
  return windows
}

/**
 * Fold a session log into usage samples bucketed by day window. A step's
 * usage arrives cumulatively, so per (day, turn, step) the LAST report wins
 * (a step straddling midnight is counted on the day its final report lands).
 * @param events - the session's event log.
 * @param windows - the day windows (oldest first).
 * @returns one sample array per window, same order as `windows`.
 */
export function foldDaySamples(
  events: readonly SessionEvent[],
  windows: ReadonlyArray<{ start: number; end: number }>,
): UsageSample[][] {
  const lastByStep = new Map<string, UsageSample & { day: number }>()
  for (const event of events) {
    const step = usageStepOf(event)
    if (step === undefined) continue
    const day = dayIndexOf(windows, event.time)
    if (day === -1) continue
    lastByStep.set(`${day}/${step.key}`, {
      day,
      time: event.time,
      buckets: bucketsFrom(step.usage),
    })
  }
  const days: UsageSample[][] = windows.map(() => [])
  for (const sample of lastByStep.values()) {
    const day = days[sample.day]
    if (day !== undefined) day.push(sample)
  }
  return days
}

/**
 * Price one usage sample under the given model price and off-peak factor.
 * @param sample - the usage sample.
 * @param price - per-million-token prices.
 * @param offPeakFactor - multiplier applied when the sample falls in the off-peak window.
 * @returns the estimated amount in the price currency.
 */
export function priceSample(sample: UsageSample, price: ModelPrice, offPeakFactor: number): number {
  const { uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens } = sample.buckets
  const fullPrice =
    uncachedInputTokens * price.inputPerMillion
    + (cacheReadTokens + cacheWriteTokens) * price.cacheReadPerMillion
    + outputTokens * price.outputPerMillion
  const factor = isOffPeak(sample.time) ? offPeakFactor : 1
  return (fullPrice / 1_000_000) * factor
}

/**
 * Format the local calendar date (yyyy-mm-dd) of an epoch in a time zone.
 * @param timeZone - IANA time zone name (fallback: the host's own zone).
 * @param time - epoch ms.
 * @returns the local date string.
 */
export function localDateOf(timeZone: string, time: number): string {
  const parts = formatterFor(timeZone).formatToParts(time)
  const field = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find(part => part.type === type)?.value ?? ''
  return `${field('year')}-${field('month')}-${field('day')}`
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    formatterCache.set(timeZone, formatter)
  }
  return formatter
}

/** One clock reading decomposed in a time zone. */
export interface LocalClock {
  year: number
  month: number
  day: number
  /** Minutes since local midnight. */
  minutes: number
}

/** Decompose an epoch into the local clock of a time zone. */
export function localClockOf(timeZone: string, time: number): LocalClock {
  const parts = formatterFor(timeZone).formatToParts(time)
  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find(part => part.type === type)?.value ?? '0')
  return {
    year: field('year'),
    month: field('month'),
    day: field('day'),
    minutes: field('hour') * 60 + field('minute'),
  }
}

/**
 * The local day window (inclusive start, exclusive end) containing `now` in a
 * time zone. Handles DST-length days: the window is bounded by the two local
 * midnights around `now`, found by epoch bisection, so a 23/25-hour day still
 * yields exactly the local calendar day.
 * @param timeZone - IANA time zone name.
 * @param now - epoch ms inside the day to bound.
 * @returns the day's [start, end) window.
 */
export function localDayWindow(timeZone: string, now: number): { start: number; end: number } {
  const targetDate = localDateOf(timeZone, now)
  // First guess: strip the local wall-clock time off `now`. This lands on the
  // true local midnight except across a DST transition inside the trailing
  // day, where it is off by the shift (±1h) — corrected by bisection: a point
  // two hours earlier is always on the previous local date, so the true
  // midnight crossing sits between it and `now`.
  const naive = now - localClockOf(timeZone, now).minutes * 60_000 - (now % 1000)
  let lo = naive - 2 * 3_600_000
  while (localDateOf(timeZone, lo) === targetDate) lo -= 3_600_000
  const start = bisectMidnight(timeZone, lo, now, targetDate)
  // End of day: the first epoch past `start` on a different local date. Probe
  // forward until the date changes (covering 23/24/25-hour DST days), then
  // bisect to the exact crossing.
  let hi = start + 24 * 3_600_000
  while (localDateOf(timeZone, hi) === localDateOf(timeZone, start)) hi += 6 * 3_600_000
  const end = bisectMidnight(timeZone, start, hi, localDateOf(timeZone, hi))
  return { start, end }
}

/**
 * Bisect an epoch range to the exact instant the local date changes at the
 * range's far edge (local midnight between `lo` (older) and `hi` (newer)).
 * @param timeZone - IANA time zone name.
 * @param lo - epoch on the earlier local date.
 * @param hi - epoch on the later local date.
 * @param hiDate - the later date string (cache of `localDateOf(timeZone, hi)`).
 * @returns the earliest epoch whose local date equals `hiDate`.
 */
function bisectMidnight(timeZone: string, lo: number, hi: number, hiDate: string): number {
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (localDateOf(timeZone, mid) === hiDate) hi = mid
    else lo = mid
  }
  return hi
}

/** Sum all samples' buckets and count them. */
export function summarizeSamples(samples: readonly UsageSample[]): {
  buckets: UsageBuckets
  count: number
} {
  let buckets = zeroBuckets()
  for (const sample of samples) buckets = addBuckets(buckets, sample.buckets)
  return { buckets, count: samples.length }
}
