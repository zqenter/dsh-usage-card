/**
 * Balance plane of the usage dashboard: resolves the DeepSeek connection
 * facts (base URL + API key) the same way the LLM provider does, and fetches
 * `GET /user/balance` through the host (the key never leaves the host).
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type { BalanceView } from './api.ts'

/** DeepSeek API key environment variable default (mirrors llm-deepseek). */
export const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
/** Public DeepSeek API base (mirrors llm-deepseek's PUBLIC_BASE_URL). */
export const PUBLIC_BASE_URL = 'https://api.deepseek.com'
/** Environment variable naming this provider's endpoint, honored only from trusted layers. */
const BASE_URL_ENV = 'DEEPSEEK_BASE_URL'

/** Resolved connection facts for one billing operation. */
export interface BillingConnectionOptions {
  /** Endpoint base; `/user/balance` is appended. */
  baseURL: string
  /** Credential reference resolved per request through the credentials seam. */
  apiKeyEnv: CredentialRef
}

/**
 * Resolve validated connection facts from raw config and the launch
 * environment — the one explicit resolve step, mirroring llm-deepseek's
 * `resolveAdapterOptions` so a changed key or endpoint reaches the next
 * request without restarting anything.
 * @param apiKeyEnv - configured credential reference (defaults to DEEPSEEK_API_KEY).
 * @param baseURL - configured endpoint base (falls back to $DEEPSEEK_BASE_URL, then the public API).
 * @param environment - this run's environment layers (the launch snapshot).
 * @returns the resolved connection facts.
 */
export function resolveBillingOptions(
  apiKeyEnv: string | undefined,
  baseURL: string | undefined,
  environment: LaunchEnvironmentSnapshot,
): BillingConnectionOptions {
  return {
    apiKeyEnv: credentialRef(apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL: baseURL ?? environment.get(BASE_URL_ENV)?.value ?? PUBLIC_BASE_URL,
  }
}

/**
 * Resolve the bearer token for the connection facts. Throws when no key is
 * available anywhere (credentials seam first, then the launch environment).
 * @param ctx - the plugin's host context.
 * @param connection - the resolved connection facts.
 * @returns the API key.
 */
export async function resolveApiKey(
  ctx: Context,
  connection: BillingConnectionOptions,
): Promise<string> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit = await credentials.resolve(connection.apiKeyEnv)
    if (hit !== undefined && hit.value.length > 0) return hit.value
  }
  const ambient = launchEnvironmentOf(ctx).get(connection.apiKeyEnv)
  if (ambient !== undefined && ambient.value.length > 0) return ambient.value
  throw new Error(
    `host-billing: no API key for the balance endpoint; store ${connection.apiKeyEnv} through the credentials service or export it in the launching environment`,
  )
}

/** One currency row of DeepSeek's `/user/balance` response. */
export interface BalanceWireInfo {
  currency: string
  total_balance: string
  granted_balance: string
  topped_up_balance: string
}

/** Wire shape of `GET /user/balance` (unknown fields ignored). */
export interface BalanceWire {
  is_available: boolean
  balance_infos?: BalanceWireInfo[]
}

/** Parse a wire balance payload into the normalized view. */
export function normalizeBalance(wire: BalanceWire, fetchedAt: number): BalanceView {
  return {
    isAvailable: wire.is_available,
    currencies: (wire.balance_infos ?? []).map(info => ({
      currency: info.currency,
      total: Number(info.total_balance),
      granted: Number(info.granted_balance),
      toppedUp: Number(info.topped_up_balance),
    })),
    fetchedAt,
  }
}

/**
 * Fetch the account balance from the provider.
 * @param ctx - host context (for credentials + environment).
 * @param connection - resolved connection facts.
 * @param signal - caller cancellation.
 * @returns the normalized balance view.
 * @throws with a readable message on transport or provider failure.
 */
export async function fetchBalance(
  ctx: Context,
  connection: BillingConnectionOptions,
  signal: AbortSignal,
): Promise<BalanceView> {
  const apiKey = await resolveApiKey(ctx, connection)
  let response: Response
  try {
    response = await fetch(`${connection.baseURL}/user/balance`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(`host-billing: balance request to ${connection.baseURL} failed: ${String(error)}`)
  }
  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const parsed = await response.json() as { error?: { message?: string } }
      if (parsed.error?.message) detail = parsed.error.message
    } catch {
      // Only swallow error-body parsing: the status still identifies the failure.
    }
    throw new Error(`host-billing: balance request rejected (${detail})`)
  }
  const wire = await response.json() as BalanceWire
  return normalizeBalance(wire, Date.now())
}
