/**
 * RPC handler specs: balance fetching through the host and today's usage
 * report over fake session/persistence stores.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createBillingHandler, DEFAULT_PRICING, type BillingDeps, type TodayUsageReport } from '../src/index.ts'
import type { BalanceView } from '../src/api.ts'

/** One fake attached session. */
interface FakeSession {
  id: string
  events: readonly SessionEvent[]
}

interface FakePersistence {
  headers: Array<{ id: string }>
  logs: Map<string, readonly SessionEvent[]>
  list: ReturnType<typeof vi.fn>
  load: ReturnType<typeof vi.fn>
}

function usageEvent(time: number, turn: number, step: number, usage: Record<string, number>): SessionEvent {
  return {
    type: 'assistant/message',
    seq: 0,
    time,
    data: { turn, step, message: { role: 'assistant', blocks: [] }, usage },
  } as unknown as SessionEvent
}

function fakeCtx(sessions: FakeSession[], persistence?: FakePersistence): Context {
  const services: Record<string, unknown> = {
    sessions: { list: () => sessions },
    ...persistence === undefined ? {} : { sessionPersistence: persistence },
    // Only the API key resolves; the platform token is absent so the estimate
    // path is exercised (platform fetching is covered by the platform specs).
    credentials: { resolve: async (ref: { toString(): string }) =>
      String(ref) === 'DEEPSEEK_API_KEY' ? { value: 'test-key', source: 'file' } : undefined },
  }
  return {
    get: (key: string) => services[key],
    logger: { warn: vi.fn() },
  } as unknown as Context
}

function depsOf(ctx: Context): BillingDeps {
  return {
    ctx,
    connection: { baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' as never },
    platformTokenRef: 'DEEPSEEK_PLATFORM_TOKEN' as never,
    pricing: DEFAULT_PRICING,
    defaultModel: 'deepseek-v4-flash',
    offPeakFactor: 0.5,
    refreshCacheMs: 60_000,
    now: () => Date.UTC(2026, 0, 15, 8, 0), // 2026-01-15 08:00 UTC (16:00 Beijing = peak)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createBillingHandler / balance', () => {
  it('serves a normalized balance view', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{
        currency: 'CNY',
        total_balance: '110.50',
        granted_balance: '10.00',
        topped_up_balance: '100.50',
      }],
    }), { status: 200 })))
    const handler = createBillingHandler(depsOf(fakeCtx([])))
    const result = await handler('balance', {}, new AbortController().signal)
    expect(result.ok).toBe(true)
    const value = (result as { ok: true; value: BalanceView }).value
    expect(value.isAvailable).toBe(true)
    expect(value.currencies).toEqual([{ currency: 'CNY', total: 110.5, granted: 10, toppedUp: 100.5 }])
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/user/balance')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key')
  })

  it('reports a provider rejection as an internal RPC error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'invalid api key' },
    }), { status: 401 })))
    const handler = createBillingHandler(depsOf(fakeCtx([])))
    const result = await handler('balance', {}, new AbortController().signal)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('internal')
      expect(result.error.message).toContain('invalid api key')
    }
  })

  it('surfaces an unknown endpoint as bad-request', async () => {
    const handler = createBillingHandler(depsOf(fakeCtx([])))
    const result = await handler('nope', {}, new AbortController().signal)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('bad-request')
  })
})

describe('createBillingHandler / today', () => {
  const now = Date.UTC(2026, 0, 15, 8, 0)
  const inDay = (offsetMs: number): number => now + offsetMs

  it('folds attached and cold sessions inside the day window', async () => {
    const attached: FakeSession[] = [{
      id: 's-attached',
      events: [
        usageEvent(Date.UTC(2026, 0, 14, 22, 0), 1, 1, { inputTokens: 1000, outputTokens: 2000 }), // before the day window
        usageEvent(inDay(-1_000), 2, 1, { inputTokens: 1_000_000, outputTokens: 0 }), // today (peak)
        usageEvent(inDay(100), 2, 2, { inputTokens: 0, outputTokens: 500_000 }), // today (peak)
      ],
    }]
    const persistence: FakePersistence = {
      headers: [{ id: 's-cold' }],
      logs: new Map([
        ['s-cold', [
          usageEvent(inDay(1000), 1, 1, { inputTokens: 0, outputTokens: 1_000_000 }), // today (peak)
        ]],
      ]),
      list: vi.fn(async () => persistence.headers),
      load: vi.fn(async (id: string) => ({ meta: { id }, events: persistence.logs.get(id) ?? [] })),
    }
    const handler = createBillingHandler(depsOf(fakeCtx(attached, persistence)))
    const result = await handler('today', { timeZone: 'UTC' }, new AbortController().signal)
    expect(result.ok).toBe(true)
    const report = (result as { ok: true; value: TodayUsageReport }).value
    expect(report.date).toBe('2026-01-15')
    expect(report.sessionCount).toBe(2)
    expect(report.tokens).toEqual({
      uncachedInput: 1_000_000,
      cacheRead: 0,
      cacheWrite: 0,
      output: 1_500_000,
      total: 2_500_000,
    })
    // Peak pricing (16:00 Beijing in the test clock): 1M input × ¥3/M + 1.5M output × ¥9/M = 3 + 13.5 = 16.5.
    expect(report.amount).toBeCloseTo(16.5, 6)
    expect(report.peakAmount).toBeCloseTo(16.5, 6)
    expect(report.offPeakAmount).toBe(0)
    expect(persistence.list).toHaveBeenCalledOnce()
    expect(persistence.load).toHaveBeenCalledWith('s-cold')
    // The 7-day series is oldest-first and ends with the reported day; the
    // day-before-window event lands on 2026-01-14, not today.
    expect(report.days).toHaveLength(7)
    expect(report.days[0]!.date).toBe('2026-01-09')
    expect(report.days[5]!.date).toBe('2026-01-14')
    expect(report.days[5]!.tokens.total).toBe(3000)
    // That event is 2026-01-15 06:00 Beijing → off-peak (half price).
    expect(report.days[5]!.amount).toBeCloseTo(0.0105, 6)
    expect(report.days[6]).toEqual({
      date: '2026-01-15',
      amount: 16.5,
      peakAmount: 16.5,
      offPeakAmount: 0,
      tokens: report.tokens,
    })
  })

  it('applies the off-peak factor to events outside the peak windows', async () => {
    const offPeakTime = Date.UTC(2026, 0, 15, 20, 0) // 04:00 Beijing (off-peak)
    const attached: FakeSession[] = [{
      id: 's',
      events: [usageEvent(offPeakTime, 1, 1, { inputTokens: 1_000_000, outputTokens: 0 })],
    }]
    const handler = createBillingHandler(depsOf(fakeCtx(attached)))
    const result = await handler('today', { timeZone: 'UTC' }, new AbortController().signal)
    const report = (result as { ok: true; value: TodayUsageReport }).value
    expect(report.offPeakAmount).toBeCloseTo(1.5, 6) // ¥3/M × 0.5
    expect(report.amount).toBeCloseTo(1.5, 6)
  })

  it('caches the report within the refresh window and recomputes after the TTL', async () => {
    const attached: FakeSession[] = [{
      id: 's',
      events: [usageEvent(now + 1000, 1, 1, { inputTokens: 1_000_000, outputTokens: 0 })],
    }]
    const persistence: FakePersistence = {
      headers: [],
      logs: new Map(),
      list: vi.fn(async () => persistence.headers),
      load: vi.fn(async () => { throw new Error('unreachable') }),
    }
    const ctx = fakeCtx(attached, persistence)
    let clock = now
    const handler = createBillingHandler({ ...depsOf(ctx), now: () => clock })
    const signal = new AbortController().signal
    const first = await handler('today', { timeZone: 'UTC' }, signal)
    const second = await handler('today', { timeZone: 'UTC' }, signal)
    expect(first).toEqual(second)
    // A cached report reuses the prior fold: the cold scan ran exactly once.
    expect(persistence.list).toHaveBeenCalledTimes(1)
    // Past the TTL the logs are re-folded.
    clock = now + 120_000
    await handler('today', { timeZone: 'UTC' }, signal)
    expect(persistence.list).toHaveBeenCalledTimes(2)
  })

  it('uses UTC when no time zone is supplied', async () => {
    const handler = createBillingHandler(depsOf(fakeCtx([])))
    const result = await handler('today', null, new AbortController().signal)
    const report = (result as { ok: true; value: TodayUsageReport }).value
    expect(report.timeZone).toBe('UTC')
  })
})
