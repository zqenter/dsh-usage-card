/**
 * Default per-model price table for the usage dashboard estimate, in the
 * balance currency per million tokens, at PEAK-hour prices (the off-peak
 * factor halves them inside the 空闲 window). Matches DeepSeek's official
 * 峰谷分时 pricing effective 2026-08-17. Deployments on other plans override
 * `pricing` in the plugin config (or a later patch layer) with their actual
 * billed prices.
 */

import type { ModelPrice } from './usage.ts'

/** Model priced by default when no configured/derived model applies. */
export const DEFAULT_MODEL = 'deepseek-v4-flash'

/** Shipped peak-hour price table: DeepSeek official CNY per million tokens (cache miss / hit / output). */
export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  'deepseek-v4-flash': { inputPerMillion: 3, cacheReadPerMillion: 0.1, outputPerMillion: 9 },
  'deepseek-v4-pro': { inputPerMillion: 9, cacheReadPerMillion: 0.3, outputPerMillion: 27 },
}
