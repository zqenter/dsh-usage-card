# @deepseek-ai/dsh-client-ui-usage-card

English | [中文](README.zh.md)

The **sidebar usage dashboard card**: occupies the `sidebar.footer.action` list slot, so it renders **above the Settings button** at the sidebar foot, in both widths — the full card when the sidebar is wide, a compact period dot + balance pill on the 56px rail.

The card shows:

- **余额 (Balance)** — from `billing.balance`, fetched through the host ([dsh-host-billing](../../host/billing/README.md)) so the API key never reaches the browser.
- **峰谷时段 (Peak/off-peak period)** — computed against DeepSeek’s official 峰谷 window (peak: Beijing 09:00–12:00, 14:00–18:00; everything else off-peak at half price); off-peak renders the green "谷 · 半价" badge. The 7-day chart stacks each day’s peak (gray) and off-peak (green) cost.
- **今日 Tokens / 今日金额 (Today's tokens and cost)** — from `billing.today`, a per-event priced estimate over the configured price table (the amount is an estimate, labelled as such).

Data is polled every 60 seconds through the `/billing` loopback RPC channel (refreshed immediately on reconnect) via a small shared store; clicking the card refreshes.

## Model Experience

None; the card is pure GUI, nothing reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Estimate currency** — the cost figure is priced in the balance currency by the host's default price table; a deployment with different prices configures `dsh-host-billing`'s `pricing`.
- **Period badge lags up to the refresh interval** — the badge recomputes on each store update (every 60s), so a period change is reflected within one refresh cycle.
