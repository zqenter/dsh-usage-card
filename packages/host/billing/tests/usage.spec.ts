/**
 * Pure folds of the usage dashboard: off-peak window, bucket extraction,
 * last-wins per-step folding, per-event pricing, and local-day windows.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  addBuckets, foldDaySamples, foldSamples, localDayWindow, priceSample, recentDayWindows,
  summarizeSamples, usageOf,
} from '../src/usage.ts'
import { isOffPeak } from '../src/api.ts'
import type { ModelPrice } from '../src/usage.ts'

const PRICE: ModelPrice = { inputPerMillion: 2, cacheReadPerMillion: 0.5, outputPerMillion: 8 }

function messageEvent(time: number, turn: number, step: number, usage: TokenUsage): SessionEvent {
  return {
    type: 'assistant/message',
    seq: 0,
    time,
    data: { turn, step, message: { role: 'assistant', blocks: [] }, usage },
  } as unknown as SessionEvent
}

function chunkUsageEvent(time: number, turn: number, step: number, usage: TokenUsage): SessionEvent {
  return {
    type: 'assistant/chunk',
    seq: 0,
    time,
    data: { turn, step, chunk: { type: 'usage', usage } },
  } as unknown as SessionEvent
}

describe('isOffPeak', () => {
  const atUtc = (hour: number, minute = 0): number => Date.UTC(2026, 0, 15, hour, minute)

  it('treats Beijing 09:00–12:00 as peak', () => {
    // 00:00 UTC = 08:00 Beijing → off-peak; 01:00 UTC = 09:00 Beijing → peak.
    expect(isOffPeak(atUtc(0))).toBe(true)
    expect(isOffPeak(atUtc(1))).toBe(false)
    // 03:00 UTC = 11:00 Beijing → peak; 04:00 UTC = 12:00 Beijing → off-peak.
    expect(isOffPeak(atUtc(3))).toBe(false)
    expect(isOffPeak(atUtc(4))).toBe(true)
  })

  it('treats Beijing 14:00–18:00 as peak and 12:00–14:00 as off-peak', () => {
    // 05:00 UTC = 13:00 Beijing → off-peak (午间); 06:00 UTC = 14:00 Beijing → peak.
    expect(isOffPeak(atUtc(5))).toBe(true)
    expect(isOffPeak(atUtc(6))).toBe(false)
    // 09:00 UTC = 17:00 Beijing → peak; 10:00 UTC = 18:00 Beijing → off-peak.
    expect(isOffPeak(atUtc(9))).toBe(false)
    expect(isOffPeak(atUtc(10))).toBe(true)
  })

  it('treats overnight Beijing hours as off-peak', () => {
    // 16:00 UTC = 00:00 Beijing, 23:00 UTC = 07:00 Beijing → off-peak.
    expect(isOffPeak(atUtc(16))).toBe(true)
    expect(isOffPeak(atUtc(23))).toBe(true)
  })
})

describe('usageOf', () => {
  it('extracts usage from assistant/message', () => {
    const event = messageEvent(1, 1, 1, { inputTokens: 3, outputTokens: 2 })
    expect(usageOf(event)).toEqual({ inputTokens: 3, outputTokens: 2 })
  })

  it('extracts usage from a trailing usage chunk', () => {
    const event = chunkUsageEvent(1, 1, 1, { inputTokens: 4, outputTokens: 5 })
    expect(usageOf(event)).toEqual({ inputTokens: 4, outputTokens: 5 })
  })

  it('returns nothing for non-usage events', () => {
    const event = { type: 'user/message', seq: 0, time: 1, data: { message: {} } } as unknown as SessionEvent
    expect(usageOf(event)).toBeUndefined()
  })
})

describe('foldSamples', () => {
  const window = { start: 0, end: 1000 }

  it('keeps the last usage report per (turn, step)', () => {
    const events = [
      chunkUsageEvent(100, 1, 1, { inputTokens: 1, outputTokens: 1 }),
      messageEvent(200, 1, 1, { inputTokens: 9, outputTokens: 9 }),
      messageEvent(300, 1, 2, { inputTokens: 2, outputTokens: 2 }),
    ]
    const samples = foldSamples(events, window)
    expect(samples).toHaveLength(2)
    expect(samples[0]).toEqual({ time: 200, buckets: { uncachedInputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 9 } })
    expect(samples[1]).toEqual({ time: 300, buckets: { uncachedInputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2 } })
  })

  it('ignores events outside the window', () => {
    const events = [messageEvent(500, 1, 1, { inputTokens: 1, outputTokens: 1 })]
    expect(foldSamples(events, { start: 600, end: 700 })).toHaveLength(0)
    expect(foldSamples(events, { start: 0, end: 500 })).toHaveLength(0)
  })

  it('carries cache buckets', () => {
    const events = [messageEvent(100, 1, 1, {
      inputTokens: 5, outputTokens: 1, cacheReadTokens: 7, cacheWriteTokens: 3,
    })]
    const samples = foldSamples(events, window)
    expect(samples[0]!.buckets).toEqual({
      uncachedInputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 3, outputTokens: 1,
    })
  })
})

describe('priceSample', () => {
  const sample = (time: number): Parameters<typeof priceSample>[0] => ({
    time,
    buckets: { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
  })

  it('prices a peak sample at full input price', () => {
    expect(priceSample(sample(Date.UTC(2026, 0, 15, 8)), PRICE, 0.5)).toBe(2)
  })

  it('applies the off-peak factor to off-peak samples', () => {
    expect(priceSample(sample(Date.UTC(2026, 0, 15, 20)), PRICE, 0.5)).toBe(1)
  })

  it('prices cache reads at the cache price and output at output price', () => {
    const s = {
      time: Date.UTC(2026, 0, 15, 8),
      buckets: { uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000 },
    }
    expect(priceSample(s, PRICE, 1)).toBe(2 + 0.5 + 8)
  })
})

describe('addBuckets and summarizeSamples', () => {
  it('sums bucket sets', () => {
    const left = { uncachedInputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4 }
    const right = { uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 40 }
    expect(addBuckets(left, right)).toEqual({
      uncachedInputTokens: 11, cacheReadTokens: 22, cacheWriteTokens: 33, outputTokens: 44,
    })
  })

  it('summarizes samples into totals and a count', () => {
    const samples = [
      { time: 1, buckets: { uncachedInputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } },
      { time: 2, buckets: { uncachedInputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, outputTokens: 4 } },
    ]
    const { buckets, count } = summarizeSamples(samples)
    expect(count).toBe(2)
    expect(buckets).toEqual({ uncachedInputTokens: 3, cacheReadTokens: 3, cacheWriteTokens: 0, outputTokens: 4 })
  })
})

describe('localDayWindow', () => {
  it('bounds a UTC day at UTC midnight', () => {
    const now = Date.UTC(2026, 0, 15, 12, 30)
    const { start, end } = localDayWindow('UTC', now)
    expect(new Date(start).toISOString()).toBe('2026-01-15T00:00:00.000Z')
    expect(new Date(end).toISOString()).toBe('2026-01-16T00:00:00.000Z')
  })

  it('bounds a Shanghai day at +08:00 midnight', () => {
    const now = Date.UTC(2026, 0, 15, 20, 30) // 2026-01-16 04:30 in Shanghai
    const { start, end } = localDayWindow('Asia/Shanghai', now)
    expect(new Date(start).toISOString()).toBe('2026-01-15T16:00:00.000Z')
    expect(new Date(end).toISOString()).toBe('2026-01-16T16:00:00.000Z')
  })

  it('handles a DST spring-forward day (America/New_York, March 8 2026)', () => {
    const now = Date.UTC(2026, 2, 8, 16, 0) // 2026-03-08 12:00 EDT (DST starts 07:00 EST → 08:00 EDT)
    const { start, end } = localDayWindow('America/New_York', now)
    expect(new Date(start).toISOString()).toBe('2026-03-08T05:00:00.000Z')
    // The day is 23 hours long: next midnight is 2026-03-09 04:00 EDT = 08:00 UTC.
    expect(new Date(end).toISOString()).toBe('2026-03-09T04:00:00.000Z')
  })

  it('handles a DST fall-back day (America/New_York, November 1 2026)', () => {
    const now = Date.UTC(2026, 10, 1, 16, 30) // 2026-11-01 11:30 EST (DST ends 02:00 EDT → 01:00 EST)
    const { start, end } = localDayWindow('America/New_York', now)
    expect(new Date(start).toISOString()).toBe('2026-11-01T04:00:00.000Z')
    // The day is 25 hours long: next midnight is 2026-11-02 00:00 EST = 05:00 UTC.
    expect(new Date(end).toISOString()).toBe('2026-11-02T05:00:00.000Z')
  })
})

describe('recentDayWindows', () => {
  it('returns count days oldest-first ending with the day containing now', () => {
    const now = Date.UTC(2026, 0, 15, 8, 0)
    const windows = recentDayWindows('UTC', now, 7)
    expect(windows).toHaveLength(7)
    expect(windows[0]!.start).toBe(Date.UTC(2026, 0, 9, 0, 0))
    expect(windows[6]!.start).toBe(Date.UTC(2026, 0, 15, 0, 0))
    expect(windows[6]!.end).toBe(Date.UTC(2026, 0, 16, 0, 0))
  })

  it('keeps each window midnight-bounded across DST days', () => {
    const now = Date.UTC(2026, 2, 10, 12, 0) // two days after the NY spring-forward
    const windows = recentDayWindows('America/New_York', now, 7)
    expect(windows[6]!.start).toBe(Date.UTC(2026, 2, 10, 4, 0, 0))
    // Day 6 days ago is March 4 (before the March 8 transition): 5h offset.
    expect(windows[0]!.start).toBe(Date.UTC(2026, 2, 4, 5, 0, 0))
  })
})

describe('foldDaySamples', () => {
  it('buckets samples into the matching day and keeps last-wins per step', () => {
    const windows = recentDayWindows('UTC', Date.UTC(2026, 0, 15, 8, 0), 7)
    const events = [
      messageEvent(Date.UTC(2026, 0, 13, 10, 0), 1, 1, { inputTokens: 100, outputTokens: 0 }), // 2 days ago
      messageEvent(Date.UTC(2026, 0, 14, 20, 0), 2, 1, { inputTokens: 7, outputTokens: 0 }), // 1 day ago
      messageEvent(Date.UTC(2026, 0, 15, 8, 0), 3, 1, { inputTokens: 9, outputTokens: 0 }), // today
      messageEvent(Date.UTC(2026, 0, 15, 9, 0), 3, 1, { inputTokens: 42, outputTokens: 0 }), // today, same step (last wins)
      messageEvent(Date.UTC(2025, 11, 20, 8, 0), 4, 1, { inputTokens: 999, outputTokens: 0 }), // outside the span
    ]
    const days = foldDaySamples(events, windows)
    expect(days).toHaveLength(7)
    expect(days[0]).toHaveLength(0)
    expect(days[4]![0]!.buckets.uncachedInputTokens).toBe(100)
    expect(days[5]![0]!.buckets.uncachedInputTokens).toBe(7)
    expect(days[6]).toHaveLength(1)
    expect(days[6]![0]!.buckets.uncachedInputTokens).toBe(42) // last report of the step wins
  })
})
