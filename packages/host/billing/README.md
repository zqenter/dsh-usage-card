# @deepseek-ai/dsh-host-billing

English | [中文](README.zh.md)

The **data plane of the usage dashboard**: this host plugin registers the `/billing` loopback RPC channel that the [browser usage card](../../client/ui-usage-card/README.md) reads.

- `balance` — fetches `GET /user/balance` from the configured DeepSeek endpoint **through the host**, so the API key never reaches the browser. Connection facts resolve exactly like `llm-deepseek` (`$DEEPSEEK_BASE_URL` or `https://api.deepseek.com`, key through the credentials seam then the launch environment), per request.
- `today` — folds the last 7 local days of provider-reported token usage across every session (attached sessions read from memory, cold sessions loaded from persistence), priced per event under DeepSeek's official **峰谷分时 schedule** (effective 2026-08-17): peak hours are Beijing time 09:00–12:00 and 14:00–18:00, everything else is off-peak at half price. The amount is an **estimate**: the harness records token usage per step but no billed price, so each usage event is priced at the configured per-model PEAK-hour price table (default: DeepSeek's official v4-flash/v4-pro CNY prices), with `offPeakFactor` (default 0.5) applied outside the peak windows. The report (with its 7-day series) is cached per (time zone, date, model) for `refreshCacheMs`.

The day window is computed in the caller's IANA time zone (the card sends its own), with DST-length days handled by midnight bisection.

## Configuration

Two tiers — the default works with **only the API key** (no extra setup); the platform token is optional and unlocks exact official numbers.

**Tier 1 — default (local estimate, zero extra config).** With only `DEEPSEEK_API_KEY` set, `today` prices the harness's own logged token usage at the official peak/off-peak price table. Everything works out of the box; the card labels the figures 估算/estimate.

**Tier 2 — official platform data (optional).** Adding a platform session token makes `today` serve the exact per-day figures from the DeepSeek platform dashboard (today's cost, token breakdown by cache-hit/input/output, the 7-day history, month and lifetime consumption). The API key **cannot** access these — DeepSeek exposes no public usage endpoint (verified: `/user/usage`, `/dashboard/billing/usage`, … all 404; only `/user/balance` works with the key).

Getting the token (one-time, ~30 seconds):
1. Log in to `https://platform.deepseek.com` in a browser.
2. DevTools → Application → Local Storage → `https://platform.deepseek.com` → copy the `userToken` value.
3. Add it to the credentials file (`~/.dsh/.credentials.yaml`), or export the env var — the plugin re-reads the credentials file live:

```yaml
DEEPSEEK_PLATFORM_TOKEN: <userToken>
```

When the token is absent, expired, or the platform endpoints fail, the card automatically falls back to Tier 1 and keeps working.

```yaml
- id: billing
  name: '@deepseek-ai/dsh-host-billing'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY   # credential ref; default DEEPSEEK_API_KEY
    platformTokenEnv: DEEPSEEK_PLATFORM_TOKEN  # optional: official data
    baseURL: https://api.deepseek.com  # default: $DEEPSEEK_BASE_URL, then the public API
    defaultModel: deepseek-v4-flash    # which price table prices the estimate
    pricing:                           # PEAK-hour prices, CNY per million tokens
      deepseek-v4-flash: { inputPerMillion: 3, cacheReadPerMillion: 0.1, outputPerMillion: 9 }
      deepseek-v4-pro:   { inputPerMillion: 9, cacheReadPerMillion: 0.3, outputPerMillion: 27 }
    offPeakFactor: 0.5       # multiplier outside peak windows (official: half price)
    refreshCacheMs: 10000    # report cache TTL
```

## Model Experience

None; the plugin serves the GUI, nothing reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request (the balance endpoint is an account read).

## Known Limitations and Deferred Work

- **Estimate, not a bill** — the Tier-1 amount prices tokens at the configured table; a provider that changes pricing, or a deployment with different per-model prices, must update `pricing`. The authoritative figure is the provider's own usage dashboard — DeepSeek exposes no public usage-cost API (the private platform endpoints require the session token).
- **No per-request model attribution** — the estimate prices every event at `defaultModel`; per-model pricing awaits per-step model tracking in the session log.
- **7-day history is local in Tier 1** — the estimate chart covers what the harness's own session logs recorded; usage from before the harness started (or outside it) is not visible. Tier 2 shows the platform's full history.
