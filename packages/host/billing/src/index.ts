/**
 * Usage dashboard data plane. Registers the `/billing` loopback RPC channel
 * that the browser usage card reads: `balance` fetches the DeepSeek account
 * balance through the host (the API key never reaches the browser), and
 * `today` serves the last-7-days usage series. When a platform session token
 * (`DEEPSEEK_PLATFORM_TOKEN`) is configured, the series comes from the
 * DeepSeek PLATFORM dashboard endpoints (the same per-day figures the web
 * console shows — authoritative cost and tokens). Without the token it falls
 * back to a local ESTIMATE: provider-reported token usage from every session
 * log, priced per event at the configured per-model price table (peak-hour
 * prices; the off-peak factor applied outside Beijing 09:00–12:00 /
 * 14:00–18:00, DeepSeek's official 峰谷 pricing window).
 * @module @deepseek-ai/dsh-host-billing
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
// Type-only: resolves the `ctx.get('sessionPersistence')` Context merge.
import type {} from '@deepseek-ai/dsh-session-persistence'
import { DEFAULT_API_KEY_ENV, fetchBalance, resolveBillingOptions } from './balance.ts'
import type { BillingConnectionOptions } from './balance.ts'
import type { BalanceView, TodayUsageReport, TodayUsageTokens } from './api.ts'
import { isOffPeak } from './api.ts'
import {
  DEFAULT_MODEL, DEFAULT_PRICING,
} from './pricing.ts'
import {
  DEFAULT_PLATFORM_TOKEN_ENV, fetchOfficialDays, fetchPlatformMonth, fetchPlatformSummary, resolvePlatformToken,
} from './platform.ts'
import {
  foldDaySamples, localDateOf, priceSample, recentDayWindows, summarizeSamples,
} from './usage.ts'
import type { ModelPrice, UsageSample } from './usage.ts'

export * from './api.ts'
export type { BalanceWire, BalanceWireInfo, BillingConnectionOptions } from './balance.ts'
export { DEFAULT_API_KEY_ENV, PUBLIC_BASE_URL, normalizeBalance } from './balance.ts'
export { DEFAULT_MODEL, DEFAULT_PRICING } from './pricing.ts'
export {
  DEFAULT_PLATFORM_TOKEN_ENV, fetchOfficialDays, fetchPlatformSummary, parsePlatformDays, resolvePlatformToken,
} from './platform.ts'
export type { PlatformDay, PlatformMonth } from './platform.ts'
export {
  addBuckets, foldDaySamples, foldSamples, localClockOf, localDateOf, localDayWindow,
  priceSample, recentDayWindows, summarizeSamples, usageOf, zeroBuckets,
} from './usage.ts'
export type { LocalClock, ModelPrice, UsageBuckets, UsageSample } from './usage.ts'

export const name = 'host-billing'
/** The connection service owns the RPC channel registry this plugin registers into. */
export const inject = ['connection']

const NS = 'host-billing'
/** Number of days in the usage series (the current day plus six prior). */
const REPORT_DAYS = 7

/** One model's per-million-token prices (schemastery mirror of {@link ModelPrice}). */
const modelPriceSchema = z.object({
  inputPerMillion: z.number().min(0),
  cacheReadPerMillion: z.number().min(0),
  outputPerMillion: z.number().min(0),
})

/**
 * Plugin config. Every field is optional in yml: a missing API key resolves
 * through the credentials seam at each request, an omitted base URL falls
 * back to $DEEPSEEK_BASE_URL then the public API, and pricing/off-peak
 * defaults match the shipped model table.
 */
export interface Config {
  /** Credential reference (environment-variable name) resolved per request; defaults to `DEEPSEEK_API_KEY`. */
  /** Credential reference (environment-variable name) resolved per request; defaults to `DEEPSEEK_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; falls back to $DEEPSEEK_BASE_URL, then the public API. */
  baseURL?: string
  /** Platform session token reference; when set, `today` serves official platform rows. */
  platformTokenEnv?: string
  /** Model whose price table prices the day's usage estimate (default `deepseek-v4-flash`). */
  defaultModel?: string
  /** Per-model per-million-token prices, in the balance currency. */
  pricing?: Record<string, ModelPrice>
  /** Multiplier applied to off-peak (discounted) usage (default 0.5). */
  offPeakFactor?: number
  /** How long a `today` report is cached before the session logs are re-folded (default 10s). */
  refreshCacheMs?: number
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  platformTokenEnv: z.string().role('credential-ref').default(DEFAULT_PLATFORM_TOKEN_ENV),
  defaultModel: z.string().default(DEFAULT_MODEL),
  pricing: z.dict(modelPriceSchema).default(DEFAULT_PRICING),
  offPeakFactor: z.number().min(0).max(1).default(0.5),
  refreshCacheMs: z.number().min(1_000).max(3_600_000).default(10_000),
})

/** Wiring shared by the two endpoints, separated for tests. */
export interface BillingDeps {
  /** Host context: reads sessions, persistence, credentials, logger. */
  ctx: Context
  /** Resolved DeepSeek connection facts. */
  connection: BillingConnectionOptions
  /** Platform session token reference (resolved through the credentials seam). */
  platformTokenRef: CredentialRef
  /** Model id → price table (already merged with defaults). */
  pricing: Record<string, ModelPrice>
  /** Model whose prices price the estimate. */
  defaultModel: string
  /** Off-peak discount multiplier. */
  offPeakFactor: number
  /** `today` report cache TTL. */
  refreshCacheMs: number
  /** Clock source (test seam; defaults to Date.now). */
  now?: () => number
}

/**
 * Compute the usage report: the current local day plus the last-7-days series
 * (oldest first, ending with today). With a platform session token configured,
 * the series is the official DeepSeek platform rows; otherwise it is folded
 * from every session log (attached from memory, cold from persistence) and
 * priced per event. Cached per (time zone, date, model) for `refreshCacheMs`.
 * @param deps - wiring.
 * @param timeZone - IANA zone the caller's local day is computed in.
 * @param signal - caller cancellation.
 * @returns the report.
 */
export async function todayUsage(
  deps: BillingDeps,
  timeZone: string,
  signal: AbortSignal,
): Promise<TodayUsageReport> {
  const now = deps.now?.() ?? Date.now()
  const token = await resolvePlatformToken(deps.ctx, deps.platformTokenRef)
  if (token !== undefined) {
    try {
      const official = await officialReport(deps, token, timeZone, now, signal)
      if (official !== null) return official
      deps.ctx.logger.warn(`${NS}: platform usage rows unavailable; serving the local estimate`)
    } catch (error) {
      deps.ctx.logger.warn(`${NS}: platform usage failed (${String(error)}); serving the local estimate`)
    }
  }
  return estimateReport(deps, timeZone, now, signal)
}

/** Official-source report from the platform dashboard rows (or null when empty). */
async function officialReport(
  deps: BillingDeps,
  token: string,
  timeZone: string,
  now: number,
  signal: AbortSignal,
): Promise<TodayUsageReport | null> {
  const windows = recentDayWindows(timeZone, now, REPORT_DAYS)
  const firstWindow = windows[0]
  if (firstWindow === undefined) return null
  const start = localDateOf(timeZone, firstWindow.start)
  const end = localDateOf(timeZone, now)
  const { days: rows, monthCost } = await fetchOfficialDays(token, start, end, signal)
  if (rows.length === 0) return null
  const days = rows.slice(-REPORT_DAYS)
  const today = days[days.length - 1]
  if (today === undefined) return null
  const summary = await fetchPlatformSummary(token, signal)
  const tokensOf = (day: (typeof days)[number]): TodayUsageTokens => ({
    uncachedInput: day.cacheMissTokens,
    cacheRead: day.cacheHitTokens,
    cacheWrite: 0,
    output: day.outputTokens,
    total: day.tokens,
  })
  // The platform reports only daily totals; the local estimate's priced
  // peak/off-peak split is mapped onto the official amount (same requests, so
  // the proportion is a good approximation). Days without local logs stay
  // unsplit (total bars).
  let estimateByDate = new Map<string, DayEstimate>()
  try {
    const estimate = await estimateDays(deps, timeZone, now, signal)
    estimateByDate = new Map(estimate.days.map(day => [day.date, day]))
  } catch (error) {
    deps.ctx.logger.warn(`${NS}: local split unavailable for the official chart (${String(error)})`)
  }
  const splitOf = (date: string, total: number): { peakAmount: number; offPeakAmount: number } => {
    const day = estimateByDate.get(date)
    const combined = (day?.peakAmount ?? 0) + (day?.offPeakAmount ?? 0)
    if (day === undefined || combined <= 0) return { peakAmount: 0, offPeakAmount: 0 }
    const ratio = day.peakAmount / combined
    return { peakAmount: total * ratio, offPeakAmount: total * (1 - ratio) }
  }
  const todaySplit = splitOf(today.date, today.cost)
  return {
    date: today.date,
    timeZone,
    model: deps.defaultModel,
    source: 'official',
    tokens: tokensOf(today),
    amount: today.cost,
    peakAmount: todaySplit.peakAmount,
    offPeakAmount: todaySplit.offPeakAmount,
    pricedSamples: 0,
    sessionCount: 0,
    monthTotal: monthCost,
    ...summary === undefined ? {} : { lifetimeTotal: summary.lifetimeCost },
    requests: today.requests,
    pricedAt: now,
    days: days.map((day) => {
      const split = splitOf(day.date, day.cost)
      return {
        date: day.date,
        amount: day.cost,
        peakAmount: split.peakAmount,
        offPeakAmount: split.offPeakAmount,
        tokens: tokensOf(day),
      }
    }),
  }
}

/** One local-estimate day: priced totals plus the peak/off-peak split. */
interface DayEstimate {
  date: string
  amount: number
  peakAmount: number
  offPeakAmount: number
  tokens: TodayUsageTokens
}

/** Fold every session log once and price each local day (estimate amounts). */
async function estimateDays(
  deps: BillingDeps,
  timeZone: string,
  now: number,
  signal: AbortSignal,
): Promise<{ days: DayEstimate[]; sessionCount: number; todaySampleCount: number }> {
  const windows = recentDayWindows(timeZone, now, REPORT_DAYS)
  const dayBuckets: UsageSample[][] = windows.map(() => [])
  let sessionCount = 0
  const seen = new Set<string>()
  const sessions = deps.ctx.get('sessions')
  if (sessions !== undefined) {
    for (const session of sessions.list()) {
      seen.add(String(session.id))
      sessionCount += 1
      mergeDayBuckets(dayBuckets, foldDaySamples(session.events, windows))
    }
  }
  const persistence = deps.ctx.get('sessionPersistence')
  if (persistence !== undefined) {
    const cold = (await persistence.list(signal)).filter(meta => !seen.has(String(meta.id)))
    for (const meta of cold) {
      try {
        const inspection = await persistence.load(meta.id)
        sessionCount += 1
        mergeDayBuckets(dayBuckets, foldDaySamples(inspection.events, windows))
      } catch (error) {
        deps.ctx.logger.warn(`${NS}: skipping unreadable session "${meta.id}": ${String(error)}`)
      }
    }
  }
  const fallbackPrice = DEFAULT_PRICING[DEFAULT_MODEL]
  const price = deps.pricing[deps.defaultModel] ?? DEFAULT_PRICING[deps.defaultModel] ?? fallbackPrice
  if (price === undefined) {
    throw new Error(`${NS}: no price table available for the default model "${deps.defaultModel}"`)
  }
  const days = windows.map((window, index) => {
    const samples = dayBuckets[index] ?? []
    let amount = 0
    let peakAmount = 0
    let offPeakAmount = 0
    for (const sample of samples) {
      const cost = priceSample(sample, price, deps.offPeakFactor)
      amount += cost
      if (isOffPeak(sample.time)) offPeakAmount += cost
      else peakAmount += cost
    }
    const { buckets } = summarizeSamples(samples)
    return {
      date: localDateOf(timeZone, window.start),
      amount,
      peakAmount,
      offPeakAmount,
      tokens: {
        uncachedInput: buckets.uncachedInputTokens,
        cacheRead: buckets.cacheReadTokens,
        cacheWrite: buckets.cacheWriteTokens,
        output: buckets.outputTokens,
        total: buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens + buckets.outputTokens,
      },
    }
  })
  return {
    days,
    sessionCount,
    todaySampleCount: summarizeSamples(dayBuckets[dayBuckets.length - 1] ?? []).count,
  }
}

/** Local-estimate report folded from the session logs. */
async function estimateReport(
  deps: BillingDeps,
  timeZone: string,
  now: number,
  signal: AbortSignal,
): Promise<TodayUsageReport> {
  const { days, sessionCount, todaySampleCount } = await estimateDays(deps, timeZone, now, signal)
  const today = days[days.length - 1]
  if (today === undefined) {
    throw new Error(`${NS}: empty day series (${REPORT_DAYS} windows were requested)`)
  }
  return {
    date: today.date,
    timeZone,
    model: deps.defaultModel,
    source: 'estimate',
    tokens: today.tokens,
    amount: today.amount,
    peakAmount: today.peakAmount,
    offPeakAmount: today.offPeakAmount,
    pricedSamples: todaySampleCount,
    sessionCount,
    pricedAt: now,
    days,
  }
}

/** Append per-day sample buckets into a shared array of day buckets. */
function mergeDayBuckets(target: UsageSample[][], source: UsageSample[][]): void {
  source.forEach((samples, index) => {
    const day = target[index]
    if (day === undefined) return
    day.push(...samples)
  })
}

/**
 * Build the `/billing` channel handler. Endpoints: `balance` (no payload) and
 * `today` (`{ timeZone?: string }`).
 * @param deps - wiring.
 * @returns the decoded RPC handler.
 */
export function createBillingHandler(deps: BillingDeps): ConnectionRpcHandler {
  let cache: { key: string; at: number; report: TodayUsageReport } | undefined
  return async (endpoint, payload, signal) => {
    try {
      if (endpoint === 'balance') {
        const value: BalanceView = await fetchBalance(deps.ctx, deps.connection, signal)
        return { ok: true as const, value }
      }
      if (endpoint === 'today') {
        const timeZone = (payload as { timeZone?: string } | null)?.timeZone ?? 'UTC'
        const now = deps.now?.() ?? Date.now()
        const cacheKey = `${timeZone}|${localDateOf(timeZone, now)}|${deps.defaultModel}`
        if (cache !== undefined && cache.key === cacheKey && now - cache.at < deps.refreshCacheMs) {
          return { ok: true as const, value: cache.report }
        }
        const report = await todayUsage(deps, timeZone, signal)
        cache = { key: cacheKey, at: now, report }
        return { ok: true as const, value: report }
      }
      if (endpoint === 'platformToken.status') {
        const credentials = deps.ctx.get('credentials')
        if (credentials === undefined) return { ok: true as const, value: { configured: false } }
        const info = await credentials.describe(deps.platformTokenRef)
        return { ok: true as const, value: { configured: info.configured } }
      }
      if (endpoint === 'platformToken.set') {
        const token = (payload as { token?: unknown } | null)?.token
        if (typeof token !== 'string' || token.trim().length === 0) {
          return {
            ok: false as const,
            error: { code: 'bad-request' as const, message: '平台 token 不能为空', details: { issues: [] } },
          }
        }
        const credentials = deps.ctx.get('credentials')
        if (credentials === undefined) {
          return { ok: false as const, error: { code: 'internal' as const, message: '凭据服务不可用', details: {} } }
        }
        // Verify against the platform before persisting anything.
        const now = new Date()
        try {
          await fetchPlatformMonth(token.trim(), 'cost', now.getMonth() + 1, now.getFullYear(), signal)
        } catch (error) {
          return {
            ok: false as const,
            error: {
              code: 'internal' as const,
              message: `平台 token 无效或已过期：${error instanceof Error ? error.message : String(error)}`,
              details: {},
            },
          }
        }
        await credentials.set(deps.platformTokenRef, token.trim())
        return { ok: true as const, value: { saved: true } }
      }
      if (endpoint === 'platformToken.clear') {
        const credentials = deps.ctx.get('credentials')
        if (credentials !== undefined) await credentials.unset(deps.platformTokenRef)
        return { ok: true as const, value: { cleared: true } }
      }
      return {
        ok: false as const,
        error: { code: 'bad-request' as const, message: `unknown billing endpoint "${endpoint}"`, details: { issues: [] } },
      }
    } catch (error) {
      if (signal.aborted) {
        return { ok: false as const, error: { code: 'cancelled' as const, message: 'cancelled', details: {} } }
      }
      return {
        ok: false as const,
        error: { code: 'internal' as const, message: error instanceof Error ? error.message : String(error), details: {} },
      }
    }
  }
}

/**
 * Register the `/billing` loopback RPC channel on the connection service.
 * @param ctx - the plugin's host context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const connection = resolveBillingOptions(config.apiKeyEnv, config.baseURL, launchEnvironmentOf(ctx))
  const pricing = { ...DEFAULT_PRICING, ...config.pricing }
  const handler = createBillingHandler({
    ctx,
    connection,
    platformTokenRef: credentialRef(config.platformTokenEnv ?? DEFAULT_PLATFORM_TOKEN_ENV),
    pricing,
    defaultModel: config.defaultModel ?? DEFAULT_MODEL,
    offPeakFactor: config.offPeakFactor ?? 0.5,
    refreshCacheMs: config.refreshCacheMs ?? 10_000,
  })
  ctx.effect(() => {
    const remove = ctx.connection.rpc.handle('/billing', handler, { authority: 'loopback' })
    return () => { void remove() }
  }, 'host-billing: /billing rpc channel')
}
