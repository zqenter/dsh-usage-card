/**
 * Official usage plane: fetches the DeepSeek PLATFORM dashboard endpoints
 * (`platform.deepseek.com/api/v0/usage/cost` and `.../usage/amount`) with the
 * user's platform session token — the same per-day data the platform web
 * console shows. These are private, undocumented endpoints; the API key
 * cannot authenticate them. The token lives in the browser's localStorage
 * (`userToken` of platform.deepseek.com); the host resolves it from the
 * credentials seam (`DEEPSEEK_PLATFORM_TOKEN` by default) and the launch
 * environment.
 *
 * Envelope (defensively parsed): `{ code: 0, data: { biz_code: 0, biz_data: {
 * days: [ { date: "YYYY-MM-DD", data: [ { usage: [ { type?, amount?, cost? } ] } ] } ] } } }`.
 * The `cost` endpoint's usage items are cost entries; the `amount` endpoint's
 * items are typed token counts (PROMPT_TOKEN / PROMPT_CACHE_MISS_TOKEN /
 * PROMPT_CACHE_HIT_TOKEN / RESPONSE_TOKEN). Month(s) are fetched to cover the
 * requested window and merged by date.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

/** Platform session token environment variable default. */
export const DEFAULT_PLATFORM_TOKEN_ENV = 'DEEPSEEK_PLATFORM_TOKEN'
const PLATFORM_USAGE_BASE = 'https://platform.deepseek.com/api/v0/usage'
const REQUEST_TIMEOUT_MS = 15_000

/** One platform usage item inside a model entry. */
interface PlatformUsageItem {
  type?: string
  amount?: number | string
  cost?: number | string
}

/** One day row of the platform usage response. */
export interface PlatformDay {
  /** Local date "YYYY-MM-DD" as the platform reports it. */
  date: string
  /** Parsed cost of the day (0 when the endpoint carries no cost data). */
  cost: number
  /** Parsed token total of the day (0 when the endpoint carries no token data). */
  tokens: number
  /** Cache-hit input tokens of the day. */
  cacheHitTokens: number
  /** Cache-miss input tokens of the day. */
  cacheMissTokens: number
  /** Output tokens of the day. */
  outputTokens: number
  /** Request count of the day. */
  requests: number
}

/** One fetched month: per-day rows plus the month's aggregate cost. */
export interface PlatformMonth {
  days: PlatformDay[]
  /** Monthly aggregate cost (the cost endpoint's `total`), 0 for the amount endpoint. */
  monthCost: number
}

/** Wire envelope of both platform usage endpoints (unknown fields ignored). */
interface PlatformUsageWire {
  code?: number
  data?: {
    biz_code?: number
    biz_data?: unknown
  }
}

/** Resolve a finite number from a possibly-string field. */
function toFinite(value: number | string | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/** Sum the token-carrying items of one model entry (typed token entries). */
function tokensOf(usage: readonly PlatformUsageItem[] | undefined): number {
  if (usage === undefined) return 0
  let total = 0
  for (const item of usage) {
    const type = item.type ?? ''
    if (type.includes('TOKEN')) total += toFinite(item.amount)
  }
  return total
}

/**
 * Sum the cost-carrying items of one model entry. The cost endpoint reports
 * every usage item's `amount` in the account currency, labeled by token type;
 * the REQUEST entry is a request count, never a cost. `PROMPT_TOKEN` is a
 * zero-cost alias (cache misses carry PROMPT_CACHE_MISS_TOKEN).
 */
function costOf(usage: readonly PlatformUsageItem[] | undefined): number {
  if (usage === undefined) return 0
  let total = 0
  for (const item of usage) {
    const type = item.type ?? ''
    if (item.cost !== undefined) total += toFinite(item.cost)
    else if (type !== 'REQUEST' && type !== 'PROMPT_TOKEN') total += toFinite(item.amount)
  }
  return total
}

/** One day's per-type token totals plus the request count. */
interface DayBreakdown {
  cacheHit: number
  cacheMiss: number
  output: number
  requests: number
}

/** Split one model entry's usage into per-type totals. */
function breakdownOf(usage: readonly PlatformUsageItem[] | undefined): DayBreakdown {
  const totals: DayBreakdown = { cacheHit: 0, cacheMiss: 0, output: 0, requests: 0 }
  if (usage === undefined) return totals
  for (const item of usage) {
    const amount = toFinite(item.amount)
    switch (item.type) {
      case 'PROMPT_CACHE_HIT_TOKEN':
        totals.cacheHit += amount
        break
      case 'PROMPT_CACHE_MISS_TOKEN':
      case 'PROMPT_TOKEN':
        totals.cacheMiss += amount
        break
      case 'RESPONSE_TOKEN':
        totals.output += amount
        break
      case 'REQUEST':
        totals.requests += amount
        break
      default:
        break
    }
  }
  return totals
}

/** One day row of the platform usage response. */
interface PlatformDayRow {
  date?: string
  data?: Array<{ usage?: PlatformUsageItem[] } | null>
}

/** Pull a day list out of a `biz_data` node (cost wraps days in an array). */
function extractDays(node: unknown): PlatformDayRow[] | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  const days = (node as { days?: unknown }).days
  return Array.isArray(days) ? (days as PlatformDayRow[]) : undefined
}

/** Normalize `biz_data` to the day-list container (cost is an array, amount an object). */
function dayContainer(bizData: unknown): PlatformDayRow[] | undefined {
  if (Array.isArray(bizData)) {
    for (const candidate of bizData) {
      const days = extractDays(candidate)
      if (days !== undefined) return days
    }
    return undefined
  }
  return extractDays(bizData)
}

/** Read the `total` field of a `biz_data` node, or undefined. */
function totalOf(node: unknown): unknown {
  if (typeof node !== 'object' || node === null) return undefined
  return (node as { total?: unknown }).total
}

/** Sum the cost endpoint's monthly `total` array (per-model cost entries). */
function monthCostOf(wire: PlatformUsageWire): number {
  if (wire.code !== 0 || wire.data === undefined || wire.data.biz_code !== 0) return 0
  const bizData = wire.data.biz_data
  let total: unknown
  if (Array.isArray(bizData)) {
    for (const candidate of bizData) {
      total = totalOf(candidate)
      if (total !== undefined) break
    }
  } else {
    total = totalOf(bizData)
  }
  if (!Array.isArray(total)) return 0
  let sum = 0
  for (const model of total) {
    if (typeof model !== 'object' || model === null) continue
    sum += costOf((model as { usage?: PlatformUsageItem[] }).usage)
  }
  return sum
}

/** Parse one endpoint's wire payload into per-day rows. */
export function parsePlatformDays(wire: PlatformUsageWire): PlatformDay[] {
  if (wire.code !== 0 || wire.data === undefined || wire.data.biz_code !== 0) return []
  const days = dayContainer(wire.data.biz_data)
  if (!Array.isArray(days)) return []
  const result: PlatformDay[] = []
  for (const day of days) {
    if (typeof day.date !== 'string' || !Array.isArray(day.data)) continue
    let cost = 0
    let tokens = 0
    const breakdown: DayBreakdown = { cacheHit: 0, cacheMiss: 0, output: 0, requests: 0 }
    for (const model of day.data) {
      if (model === null || typeof model !== 'object' || !Array.isArray(model.usage)) continue
      cost += costOf(model.usage)
      tokens += tokensOf(model.usage)
      const part = breakdownOf(model.usage)
      breakdown.cacheHit += part.cacheHit
      breakdown.cacheMiss += part.cacheMiss
      breakdown.output += part.output
      breakdown.requests += part.requests
    }
    result.push({
      date: day.date,
      cost,
      tokens,
      cacheHitTokens: breakdown.cacheHit,
      cacheMissTokens: breakdown.cacheMiss,
      outputTokens: breakdown.output,
      requests: breakdown.requests,
    })
  }
  return result.sort((a, b) => a.date < b.date ? -1 : 1)
}

/** Request headers the platform dashboard endpoints expect. */
function platformHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'x-app-version': '1.0.0',
    origin: 'https://platform.deepseek.com',
    referer: 'https://platform.deepseek.com/usage',
  }
}

/**
 * Fetch one month's usage of one endpoint kind.
 * @param token - platform session token.
 * @param kind - `cost` or `amount`.
 * @param month - 1-12.
 * @param year - four-digit year.
 * @param signal - caller cancellation.
 * @returns the month's per-day rows (possibly empty on parse failure) plus the
 *   monthly aggregate cost (0 for the amount endpoint).
 * @throws on transport errors, HTTP failures, or an expired-session envelope.
 */
export async function fetchPlatformMonth(
  token: string,
  kind: 'cost' | 'amount',
  month: number,
  year: number,
  signal: AbortSignal,
): Promise<PlatformMonth> {
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${PLATFORM_USAGE_BASE}/${kind}?month=${month}&year=${year}`, {
      method: 'GET',
      headers: platformHeaders(token),
      signal: AbortSignal.any([signal, controller.signal]),
    })
    if (!response.ok) {
      throw new Error(`DeepSeek platform usage (${kind}) returned HTTP ${response.status}`)
    }
    const wire = await response.json() as PlatformUsageWire
    const code = wire.code ?? wire.data?.biz_code
    if (code === 40002 || code === 40003) {
      throw new Error('平台登录已过期：请重新登录 platform.deepseek.com 并更新 userToken')
    }
    if (wire.code !== 0 || wire.data?.biz_code !== 0) {
      throw new Error(`DeepSeek platform usage (${kind}) rejected (code ${String(code ?? 'unknown')})`)
    }
    return {
      days: parsePlatformDays(wire),
      monthCost: kind === 'cost' ? monthCostOf(wire) : 0,
    }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Fetch the official usage rows covering a date range, plus the CURRENT
 * month's aggregate cost. The range may span two months, so both are fetched
 * and merged by date; days outside the range are dropped.
 * @param token - platform session token.
 * @param start - inclusive start date "YYYY-MM-DD".
 * @param end - inclusive end date "YYYY-MM-DD".
 * @param signal - caller cancellation.
 * @returns per-day rows inside the range (ascending) and the current month's cost.
 */
export async function fetchOfficialDays(
  token: string,
  start: string,
  end: string,
  signal: AbortSignal,
): Promise<{ days: PlatformDay[]; monthCost: number }> {
  const [startYear, startMonth] = start.split('-').map(Number)
  const [endYear, endMonth] = end.split('-').map(Number)
  const months = new Set([`${startYear}-${startMonth}`, `${endYear}-${endMonth}`])
  const monthPairs = [...months].map((entry) => {
    const [year, month] = entry.split('-').map(Number)
    return [year, month] as [number, number]
  })
  const [costGroups, amountGroups] = await Promise.all([
    Promise.all(monthPairs.map(([year, month]) =>
      fetchPlatformMonth(token, 'cost', month, year, signal))),
    Promise.all(monthPairs.map(([year, month]) =>
      fetchPlatformMonth(token, 'amount', month, year, signal))),
  ])
  const costRows = costGroups.flatMap(group => group.days)
  const amountRows = amountGroups.flatMap(group => group.days)
  const byDate = new Map<string, PlatformDay>()
  for (const row of costRows) {
    const entry = byDate.get(row.date) ?? {
      date: row.date, cost: 0, tokens: 0,
      cacheHitTokens: 0, cacheMissTokens: 0, outputTokens: 0, requests: 0,
    }
    entry.cost = row.cost
    byDate.set(row.date, entry)
  }
  for (const row of amountRows) {
    const entry = byDate.get(row.date) ?? {
      date: row.date, cost: 0, tokens: 0,
      cacheHitTokens: 0, cacheMissTokens: 0, outputTokens: 0, requests: 0,
    }
    entry.tokens = row.tokens
    entry.cacheHitTokens = row.cacheHitTokens
    entry.cacheMissTokens = row.cacheMissTokens
    entry.outputTokens = row.outputTokens
    entry.requests = row.requests
    byDate.set(row.date, entry)
  }
  // The current month's aggregate cost: the cost endpoint total of the month
  // containing `end` (the report's "today").
  const monthCost = monthPairs.reduce((acc, [year, month], index) =>
    year === endYear && month === endMonth ? costGroups[index]?.monthCost ?? 0 : acc, 0)
  return {
    days: [...byDate.values()]
      .filter(day => day.date >= start && day.date <= end)
      .sort((a, b) => a.date < b.date ? -1 : 1),
    monthCost,
  }
}

/**
 * Fetch the platform account summary: lifetime (累计) consumption.
 * @param token - platform session token.
 * @param signal - caller cancellation.
 * @returns the lifetime cost in the account currency, or undefined on failure.
 */
export async function fetchPlatformSummary(
  token: string,
  signal: AbortSignal,
): Promise<{ lifetimeCost: number } | undefined> {
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch('https://platform.deepseek.com/api/v0/users/get_user_summary', {
      method: 'GET',
      headers: platformHeaders(token),
      signal: AbortSignal.any([signal, controller.signal]),
    })
    if (!response.ok) return undefined
    const wire = await response.json() as {
      code?: number
      data?: { biz_code?: number; biz_data?: { total_costs?: Array<{ amount?: number | string }> } }
    }
    if (wire.code !== 0 || wire.data?.biz_code !== 0) return undefined
    const first = wire.data.biz_data?.total_costs?.[0]
    if (first === undefined) return undefined
    const lifetimeCost = toFinite(first.amount)
    return Number.isFinite(lifetimeCost) && lifetimeCost > 0 ? { lifetimeCost } : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Resolve the platform session token through the credentials seam, then the
 * launch environment.
 * @param ctx - host context.
 * @param ref - the configured credential reference.
 * @returns the token, or undefined when none is available anywhere.
 */
export async function resolvePlatformToken(ctx: Context, ref: CredentialRef): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref)
    if (hit !== undefined && hit.value.length > 0) return hit.value
  }
  const ambient = launchEnvironmentOf(ctx).get(ref)
  if (ambient !== undefined && ambient.value.length > 0) return ambient.value
  return undefined
}
