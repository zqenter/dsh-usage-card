/**
 * Official platform source specs: envelope parsing, month fetching/merging,
 * token resolution, and the handler's official-vs-estimate path.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  createBillingHandler, DEFAULT_PRICING, parsePlatformDays, resolvePlatformToken,
  type BillingDeps,
} from '../src/index.ts'
import { fetchOfficialDays } from '../src/platform.ts'
import type { TodayUsageReport } from '../src/api.ts'

/** A platform cost-endpoint wire envelope (biz_data is an ARRAY). */
function wireDays() {
  return {
    code: 0,
    data: {
      biz_code: 0,
      biz_data: [
        {
          days: [
            {
              date: '2026-01-14',
              data: [{ usage: [{ type: 'PROMPT_CACHE_HIT_TOKEN', amount: 10_000_000 }, { type: 'RESPONSE_TOKEN', amount: 500_000 }] }],
            },
            {
              date: '2026-01-15',
              data: [{ usage: [{ type: 'PROMPT_CACHE_HIT_TOKEN', amount: 20_000_000 }, { type: 'RESPONSE_TOKEN', amount: 1_000_000 }, { type: 'REQUEST', amount: 3 }] }],
            },
          ],
        },
      ],
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parsePlatformDays', () => {
  it('extracts per-type totals and costs, excluding REQUEST counts', () => {
    const days = parsePlatformDays(wireDays())
    expect(days).toEqual([
      {
        date: '2026-01-14', cost: 10_500_000, tokens: 10_500_000,
        cacheHitTokens: 10_000_000, cacheMissTokens: 0, outputTokens: 500_000, requests: 0,
      },
      {
        date: '2026-01-15', cost: 21_000_000, tokens: 21_000_000,
        cacheHitTokens: 20_000_000, cacheMissTokens: 0, outputTokens: 1_000_000, requests: 3,
      },
    ])
  })

  it('returns nothing for a rejected or empty envelope', () => {
    expect(parsePlatformDays({ code: 40002 })).toEqual([])
    expect(parsePlatformDays({ code: 0, data: { biz_code: 0 } })).toEqual([])
  })
})

describe('fetchOfficialDays', () => {
  it('merges cost and amount months and filters to the range', async () => {
    const costCall = (month: number): unknown => ({
      code: 0,
      data: { biz_code: 0, biz_data: [{ days: [{ date: `2026-${String(month).padStart(2, '0')}-15`, data: [{ usage: [{ type: 'PROMPT_CACHE_MISS_TOKEN', amount: 2 }] }] }], total: [{ usage: [{ type: 'PROMPT_CACHE_MISS_TOKEN', amount: 30 }] }] }] },
    })
    const amountCall = (month: number): unknown => ({
      code: 0,
      data: { biz_code: 0, biz_data: { days: [{ date: `2026-${String(month).padStart(2, '0')}-15`, data: [{ usage: [{ type: 'PROMPT_CACHE_MISS_TOKEN', amount: 3_000_000 }] }] }] } },
    })
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes('/cost?month=12')
        ? costCall(12)
        : url.includes('/cost?month=1')
          ? costCall(1)
          : url.includes('/amount?month=12')
            ? amountCall(12)
            : amountCall(1),
    ), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchOfficialDays('tok', '2025-12-30', '2026-01-15', new AbortController().signal)
    expect(result.days).toEqual([
      { date: '2026-01-15', cost: 2, tokens: 3_000_000, cacheHitTokens: 0, cacheMissTokens: 3_000_000, outputTokens: 0, requests: 0 },
    ])
    expect(result.monthCost).toBe(30) // January's aggregate cost (the month of "today")
    // The window crosses the month boundary: both months, both kinds.
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      'https://platform.deepseek.com/api/v0/usage/cost?month=12&year=2025',
      'https://platform.deepseek.com/api/v0/usage/cost?month=1&year=2026',
      'https://platform.deepseek.com/api/v0/usage/amount?month=12&year=2025',
      'https://platform.deepseek.com/api/v0/usage/amount?month=1&year=2026',
    ])
  })
})

describe('resolvePlatformToken', () => {
  it('resolves through the credentials seam', async () => {
    const ctx = {
      get: () => ({ resolve: async () => ({ value: 'platform-token', source: 'file' }) }),
    } as unknown as Context
    await expect(resolvePlatformToken(ctx, credentialRef('DEEPSEEK_PLATFORM_TOKEN'))).resolves.toBe('platform-token')
  })

  it('returns undefined when no provider has the token', async () => {
    const ctx = {
      get: () => undefined,
    } as unknown as Context
    await expect(resolvePlatformToken(ctx, credentialRef('DEEPSEEK_PLATFORM_TOKEN'))).resolves.toBeUndefined()
  })
})

describe('createBillingHandler / today with a platform token', () => {
  it('serves official platform rows when the token resolves', async () => {
    const ctx = {
      get: (key: string) => key === 'credentials'
        ? { resolve: async (ref: { toString(): string }) => String(ref) === 'DEEPSEEK_API_KEY'
          ? { value: 'key', source: 'file' }
          : { value: 'platform-token', source: 'file' } }
        : key === 'sessions' ? { list: () => [] } : undefined,
      logger: { warn: vi.fn() },
    } as unknown as Context
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes('/cost')
        ? { code: 0, data: { biz_code: 0, biz_data: [{ days: [
          { date: '2026-01-14', data: [{ usage: [{ type: 'PROMPT_CACHE_HIT_TOKEN', amount: 2 }] }] },
          { date: '2026-01-15', data: [{ usage: [{ type: 'PROMPT_CACHE_HIT_TOKEN', amount: 7.5 }] }] },
        ] }] } }
        : { code: 0, data: { biz_code: 0, biz_data: { days: [
          { date: '2026-01-14', data: [{ usage: [{ type: 'PROMPT_CACHE_HIT_TOKEN', amount: 1_000_000 }] }] },
          { date: '2026-01-15', data: [{ usage: [{ type: 'PROMPT_CACHE_HIT_TOKEN', amount: 2_000_000 }] }] },
        ] } } },
    ), { status: 200 })))
    const deps: BillingDeps = {
      ctx,
      connection: { baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' as never },
      platformTokenRef: 'DEEPSEEK_PLATFORM_TOKEN' as never,
      pricing: DEFAULT_PRICING,
      defaultModel: 'deepseek-v4-flash',
      offPeakFactor: 0.5,
      refreshCacheMs: 60_000,
      now: () => Date.UTC(2026, 0, 15, 8, 0),
    }
    const result = await createBillingHandler(deps)('today', { timeZone: 'UTC' }, new AbortController().signal)
    expect(result.ok).toBe(true)
    const report = (result as { ok: true; value: TodayUsageReport }).value
    expect(report.source).toBe('official')
    expect(report.amount).toBe(7.5)
    expect(report.tokens).toEqual({ uncachedInput: 0, cacheRead: 2_000_000, cacheWrite: 0, output: 0, total: 2_000_000 })
    expect(report.days.map(day => day.date)).toEqual(['2026-01-14', '2026-01-15'])
    expect(report.requests).toBe(0)
  })
})


describe('createBillingHandler / platformToken endpoints', () => {
  function deps(
    set = vi.fn(async () => {}),
    unset = vi.fn(async () => {}),
    describe = vi.fn(async () => ({ configured: false, writable: true })),
  ): BillingDeps {
    const credentials = { resolve: async () => undefined, set, unset, describe }
    const fullCtx = {
      get: (key: string) => key === 'credentials' ? credentials : undefined,
      logger: { warn: vi.fn() },
    } as unknown as Context
    return {
      ctx: fullCtx,
      connection: { baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' as never },
      platformTokenRef: 'DEEPSEEK_PLATFORM_TOKEN' as never,
      pricing: DEFAULT_PRICING,
      defaultModel: 'deepseek-v4-flash',
      offPeakFactor: 0.5,
      refreshCacheMs: 60_000,
    }
  }
  const signal = new AbortController().signal

  it('reports configured=false when no token is stored', async () => {
    const handler = createBillingHandler(deps())
    const result = await handler('platformToken.status', {}, signal)
    expect(result).toEqual({ ok: true, value: { configured: false } })
  })

  it('verifies the token against the platform before saving it', async () => {
    const set = vi.fn(async () => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 0, data: { biz_code: 0, biz_data: [{ days: [] }] },
    }), { status: 200 })))
    const handler = createBillingHandler(deps(set))
    const result = await handler('platformToken.set', { token: 'platform-token' }, signal)
    expect(result).toEqual({ ok: true, value: { saved: true } })
    expect(set).toHaveBeenCalledWith(expect.anything(), 'platform-token')
  })

  it('rejects an invalid token without saving', async () => {
    const set = vi.fn(async () => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"unauthorized"}}', { status: 401 })))
    const handler = createBillingHandler(deps(set))
    const result = await handler('platformToken.set', { token: 'bad' }, signal)
    expect(result.ok).toBe(false)
    expect(set).not.toHaveBeenCalled()
  })

  it('rejects an empty token', async () => {
    const set = vi.fn(async () => {})
    const handler = createBillingHandler(deps(set))
    const result = await handler('platformToken.set', { token: '   ' }, signal)
    expect(result.ok).toBe(false)
    expect(set).not.toHaveBeenCalled()
  })

  it('clears a stored token', async () => {
    const unset = vi.fn(async () => {})
    const handler = createBillingHandler(deps(vi.fn(async () => {}), unset))
    const result = await handler('platformToken.clear', {}, signal)
    expect(result).toEqual({ ok: true, value: { cleared: true } })
    expect(unset).toHaveBeenCalled()
  })
})
