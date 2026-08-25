/**
 * The sidebar usage card: occupies the `sidebar.footer.action` list slot, so
 * it renders above the Settings button in both sidebar widths — the full card
 * when wide, a compact period dot + balance pill on the 56px rail.
 *
 * Visual hierarchy: balance and today's cost are the level-1 metrics (large),
 * today's tokens are level 2, and everything else (peak/off-peak badge with
 * its window hint, source note, updated stamp, chart legend) is level 3. The
 * 7-day usage chart stacks each day's estimated peak and off-peak cost (or
 * official totals) with user-configurable bar colors.
 *
 * The ⚙ button flips the card (3D) to a settings face: the optional platform
 * token (saved through the host's credentials service, with an acquisition
 * tutorial while blank) and the chart bar colors (stored locally; blank means
 * "follow the theme"). Data arrives through the injected store (RPC-polled);
 * the period badge is computed from the current clock against DeepSeek's
 * official 峰谷 window.
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react'
import { clsx } from 'clsx'
import type {
  InjectFace, PropsLocale, PropsRuntime, SnapshotSelectorHook,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { DayUsage } from '@deepseek-ai/dsh-host-billing/api'
import type { UsageCardStore, UsageCardState } from './usage-card-store.ts'
import {
  currentPeriod, formatAmount, formatClock, formatDayLabel, formatTokens, peakWindowLabel,
} from './period.ts'
import css from './UsageCard.module.css'

/** Registrant business face: the shared store and its bound snapshot hook. */
export interface UsageCardInjected {
  /** Polls balance + today usage; the card's refresh button calls this. */
  store: UsageCardStore
  /** uSES selector hook over the store's snapshot. */
  useSnapshot: SnapshotSelectorHook<UsageCardState>
  /** Browser RPC caller (the settings face persists the platform token through it). */
  rpc: ClientConnectionRpc
}

/** DeepSeek platform top-up page (the card's recharge button target). */
export const RECHARGE_URL = 'https://platform.deepseek.com/top_up'
/** Duration of the refresh-button spin (one full rotation). */
export const REFRESH_SPIN_MS = 800
/** Duration of the card flip animation (matches the CSS transition). */
export const FLIP_MS = 420

/** Composed props: the footer-action owner share (`wide`) + injected face + locale seat. */
export type UsageCardProps =
  PropsRuntime<'sidebar.footer.action'>
  & InjectFace<UsageCardInjected>
  & PropsLocale<'usage-card'>

/** Chart bar colors; an empty value means "follow the theme". */
interface ChartColors {
  peak: string
  off: string
  total: string
}

const COLORS_STORAGE_KEY = 'dsh-usage-card-colors'
/** The three configurable chart channels and their settings-label keys. */
const COLOR_KEYS = ['peak', 'off', 'total'] as const
/** Token acquisition tutorial steps (order matters). */
const TUTORIAL_KEYS = [
  'settings.tutorial1', 'settings.tutorial2', 'settings.tutorial3',
  'settings.tutorial4', 'settings.tutorial5', 'settings.tutorial6',
] as const
const COLOR_LABELS: Record<(typeof COLOR_KEYS)[number], 'settings.colorPeak' | 'settings.colorOff' | 'settings.colorTotal'> = {
  peak: 'settings.colorPeak',
  off: 'settings.colorOff',
  total: 'settings.colorTotal',
}
const COLOR_HINTS: Record<(typeof COLOR_KEYS)[number], 'settings.colorHintPeak' | 'settings.colorHintOff' | 'settings.colorHintTotal'> = {
  peak: 'settings.colorHintPeak',
  off: 'settings.colorHintOff',
  total: 'settings.colorHintTotal',
}
/** Color-picker display values used while a channel follows the theme. */
const DEFAULT_CHART_COLORS: Required<ChartColors> = { peak: '#9aa3b2', off: '#34b36b', total: '#416ee6' }
const EMPTY_COLORS: ChartColors = { peak: '', off: '', total: '' }

/** Load the stored chart colors (best-effort; corrupt values fall back to theme). */
function loadColors(): ChartColors {
  try {
    const raw = window.localStorage.getItem(COLORS_STORAGE_KEY)
    if (raw === null) return EMPTY_COLORS
    const parsed = JSON.parse(raw) as Partial<ChartColors>
    return {
      peak: typeof parsed.peak === 'string' ? parsed.peak : '',
      off: typeof parsed.off === 'string' ? parsed.off : '',
      total: typeof parsed.total === 'string' ? parsed.total : '',
    }
  } catch {
    return EMPTY_COLORS
  }
}

/** Render the usage dashboard card for the sidebar foot. */
export function UsageCard({ wide, store, useSnapshot, rpc, t }: UsageCardProps) {
  const state = useSnapshot(state => state)
  // One-shot refresh spin: each click plays a full rotation regardless of how
  // fast the RPC round trip is (an infinite animation tied to the loading
  // status would stutter on sub-second refreshes). Always cleared: reduced
  // motion disables the animation, so a timeout backstop guarantees the class
  // never sticks.
  const [spinning, setSpinning] = useState(false)
  useEffect(() => {
    if (!spinning) return
    const timer = window.setTimeout(() => { setSpinning(false) }, REFRESH_SPIN_MS + 50)
    return () => { window.clearTimeout(timer) }
  }, [spinning])

  // Click-to-expand: collapsed shows levels 1-3 only; clicking the card grows
  // it and appends the token breakdown + month/lifetime rows and the 7-day
  // chart. Click-driven, not hover: the host app made hover unreliable in
  // Chrome (a click inside the window killed the popover until the cursor left
  // and re-entered), so the extra data lives behind an explicit tap instead.
  const [expanded, setExpanded] = useState(false)
  const toggleExpanded = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (flipped) return
    const target = event.target as Element | null
    // Clicks on the card's own controls (recharge/refresh/gear/inputs) never
    // expand or collapse the card.
    if (target?.closest?.('a, button, input')) return
    setExpanded(value => !value)
  }
  const [flipped, setFlipped] = useState(false)
  // The back face stays mounted through the flip-out animation, then unmounts
  // so the card shrinks back to the front's height (adaptive, no scrollbar).
  const [renderBack, setRenderBack] = useState(false)
  const flipTimer = useRef<number | undefined>(undefined)
  const flipTo = (next: boolean): void => {
    if (flipTimer.current !== undefined) {
      window.clearTimeout(flipTimer.current)
      flipTimer.current = undefined
    }
    setFlipped(next)
    if (next) setRenderBack(true)
    else {
      flipTimer.current = window.setTimeout(() => {
        setRenderBack(false)
        flipTimer.current = undefined
      }, FLIP_MS + 30)
    }
  }
  const [colors, setColors] = useState<ChartColors>(loadColors)
  const [tokenConfigured, setTokenConfigured] = useState<boolean | undefined>(undefined)
  const [tokenInput, setTokenInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [tokenNotice, setTokenNotice] = useState<string | null>(null)

  // Learn whether a platform token is already configured.
  useEffect(() => {
    let cancelled = false
    void rpc.call('/billing', 'platformToken.status', {}, undefined).then((result) => {
      if (cancelled || !result.ok) return
      const value = result.value as { configured?: unknown }
      if (typeof value.configured === 'boolean') setTokenConfigured(value.configured)
    })
    return () => { cancelled = true }
  }, [rpc])

  const setColor = (key: keyof ChartColors, value: string): void => {
    const next = { ...colors, [key]: value }
    setColors(next)
    try {
      window.localStorage.setItem(COLORS_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Storage unavailable (private mode): the picker still works for this session.
    }
  }

  const saveToken = async (): Promise<void> => {
    const token = tokenInput.trim()
    if (token.length === 0) return
    setSaving(true)
    setTokenError(null)
    setTokenNotice(null)
    const result = await rpc.call('/billing', 'platformToken.set', { token }, undefined)
    setSaving(false)
    if (!result.ok) {
      setTokenError(result.error.message)
      return
    }
    setTokenConfigured(true)
    setTokenInput('')
    setTokenNotice(t('settings.tokenSaved'))
    void store.refresh()
  }

  const clearToken = async (): Promise<void> => {
    const result = await rpc.call('/billing', 'platformToken.clear', {}, undefined)
    if (result.ok) {
      setTokenConfigured(false)
      setTokenNotice(t('settings.tokenCleared'))
      void store.refresh()
    }
  }

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const period = currentPeriod(Date.now())
  const currency = state.balance?.currencies[0]?.currency ?? 'CNY'
  const balance = state.balance?.currencies[0]
  const balanceText = state.status === 'error'
    ? t('card.unavailable')
    : balance === undefined
      ? t('card.loading')
      : formatAmount(balance.total, currency)
  const today = state.today
  const amountText = today === undefined ? t('card.loading') : formatAmount(today.amount, currency)
  const tokensText = today === undefined ? '—' : formatTokens(today.tokens.total)
  const windowLabel = peakWindowLabel()
  const badgeHint = t(period === 'off-peak' ? 'period.offPeakHint' : 'period.peakHint', { window: windowLabel })
  const badgeText = t(period === 'off-peak' ? 'period.offPeak' : 'period.peak')
  const updated = state.refreshedAt === null
    ? undefined
    : t('card.updatedAt', { time: formatClock(state.refreshedAt, timeZone) })
  const days = today?.days ?? []

  if (!wide) {
    // Sidebar collapsed (rail): show the balance only.
    return (
      <button
        type="button"
        className={css.rail}
        onClick={() => { void store.refresh() }}
        title={badgeHint}
        aria-label={`${t('balance.label')} ${balanceText} · ${badgeText}`}
      >
        <span className={css.railBalance}>{balanceText}</span>
      </button>
    )
  }

  const colorStyle = {
    ...(colors.peak !== '' ? { '--usage-bar-peak': colors.peak } : {}),
    ...(colors.off !== '' ? { '--usage-bar-off': colors.off } : {}),
    ...(colors.total !== '' ? { '--usage-bar-total': colors.total } : {}),
  } as CSSProperties

  return (
    <div
      className={clsx(css.card, flipped && css.flipped)}
      data-usage-card
      style={colorStyle}
      onClick={toggleExpanded}
      aria-expanded={expanded}
    >
      <div className={css.cardInner}>
        {/* ── Front: the dashboard ─────────────────────────────────────────── */}
        <div className={css.faceFront}>
          {/* Card actions: recharge on the left, refresh on the right. */}
          <span className={css.actions}>
            <a
              className={css.recharge}
              href={RECHARGE_URL}
              target="_blank"
              rel="noreferrer"
              title={t('card.rechargeHint')}
            >
              <span className={css.rechargePlus}>+</span>
              {t('card.recharge')}
            </a>
            <button
              type="button"
              className={clsx(css.refreshBtn, spinning && css.spinning)}
              onClick={() => { setSpinning(true); void store.refresh() }}
              title={t('card.retry')}
              aria-label={t('card.refresh')}
            >
              ↻
            </button>
          </span>

          {/* Level 1: balance and today's cost, side by side. */}
          <span className={css.l1}>
            <span className={css.metric}>
              <span className={css.metricLabel}>{t('balance.label')}</span>
              <span className={css.metricValue}>{balanceText}</span>
            </span>
            <span className={css.metric}>
              <span className={css.metricLabel}>{t('today.amount')}</span>
              <span className={css.metricValue}>{amountText}</span>
            </span>
          </span>

          {/* Level 2: today's tokens. */}
          <span className={css.l2}>
            <span>{t('today.tokens')}</span>
            <span className={css.tokensValue}>{tokensText}</span>
          </span>

          {/* Level 3: period badge (with window hint), source note, updated stamp. */}
          <span className={css.l3}>
            <span className={clsx(css.badge, period === 'off-peak' && css.badgeOff)} title={badgeHint}>
              {badgeText}
            </span>
            <span className={css.estimate} title={today?.source === 'official' ? undefined : t('card.estimateHint')}>
              {today?.source === 'official' ? t('today.official') : t('today.estimate')}
            </span>
            <span className={css.l3Right}>
              {updated !== undefined && <span className={css.updated}>{updated}</span>}
              <button
                type="button"
                className={css.settingsGear}
                onClick={() => { flipTo(true) }}
                title={t('settings.title')}
                aria-label={t('settings.title')}
              >
                ⚙
              </button>
            </span>
          </span>

          {/* 7-day usage chart: stacked peak/off-peak for estimates, total bars for official data. */}
          {expanded && days.length > 0 && (
            <span className={css.chartBlock}>
              <span className={css.chartTitle}>{t('chart.label')}</span>
              <UsageChart days={days} />
              <span className={css.legend}>
                <span className={css.legendItem}>
                  <i className={clsx(css.legendDot, css.dotPeak)} />
                  {t('chart.peak')}
                </span>
                <span className={css.legendItem}>
                  <i className={clsx(css.legendDot, css.dotOff)} />
                  {t('chart.offPeak')}
                </span>
                <span className={css.windowHint}>{t('chart.peak')} {windowLabel}</span>
              </span>
              {today?.source !== 'official' && days.slice(0, -1).every(day => day.amount === 0) && (
                <span className={css.noHistory}>{t('chart.noHistory')}</span>
              )}
            </span>
          )}

          {/* Expanded breakdown: cache hit / input / output (+ requests). */}
          {expanded && today !== undefined && (
            <span className={css.breakdown}>
              <span>{t('bd.cacheHit')} {formatTokens(today.tokens.cacheRead)}</span>
              <span>{t('bd.input')} {formatTokens(today.tokens.uncachedInput)}</span>
              <span>{t('bd.output')} {formatTokens(today.tokens.output)}</span>
              {today.requests !== undefined && (
                <span>{t('bd.requests')} {today.requests.toLocaleString()}</span>
              )}
            </span>
          )}

          {/* Expanded month/lifetime consumption (official data only). */}
          {expanded && (today?.monthTotal !== undefined || today?.lifetimeTotal !== undefined) && (
            <span className={css.breakdown}>
              {today?.monthTotal !== undefined && (
                <span>{t('bd.month')} {formatAmount(today.monthTotal, currency)}</span>
              )}
              {today?.lifetimeTotal !== undefined && (
                <span>{t('bd.lifetime')} {formatAmount(today.lifetimeTotal, currency)}</span>
              )}
            </span>
          )}

        </div>

        {/* ── Back: settings (platform token + chart colors) ───────────────── */}
        {renderBack && (
          <div className={css.faceBack}>
            <span className={css.settingsHeader}>
              <span className={css.settingsTitle}>{t('settings.title')}</span>
              <button
                type="button"
                className={css.settingsClose}
                onClick={() => { flipTo(false) }}
                aria-label={t('settings.done')}
              >
                ✕
              </button>
            </span>

            <span className={css.settingsSection}>
              <span className={css.settingsLabel}>{t('settings.tokenLabel')}</span>
              {tokenConfigured === true ? (
                <span className={css.tokenState}>
                  <span className={css.tokenOk}>✓ {t('settings.tokenSet')}</span>
                  <button
                    type="button"
                    className={css.settingsBtn}
                    onClick={() => { void clearToken() }}
                  >
                    {t('settings.tokenClear')}
                  </button>
                </span>
              ) : (
                <>
                  <input
                    className={css.tokenInput}
                    value={tokenInput}
                    onChange={(event) => { setTokenInput(event.target.value) }}
                    placeholder={t('settings.tokenPlaceholder')}
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className={css.settingsBtnPrimary}
                    onClick={() => { void saveToken() }}
                    disabled={saving || tokenInput.trim() === ''}
                  >
                    {saving ? t('settings.saving') : t('settings.tokenSave')}
                  </button>
                  {tokenError !== null && <span className={css.settingsError}>{tokenError}</span>}
                  {tokenNotice !== null && <span className={css.settingsNotice}>{tokenNotice}</span>}
                  <ol className={css.tutorial}>
                    {TUTORIAL_KEYS.map(key => <li key={key}>{t(key)}</li>)}
                  </ol>
                </>
              )}
            </span>

            <span className={css.settingsSection}>
              <span className={css.settingsLabel}>{t('settings.colorsLabel')}</span>
              {COLOR_KEYS.map((key) => {
                const labelKey = COLOR_LABELS[key]
                return (
                  <span key={key} className={css.colorRow}>
                    <span className={css.colorName} title={t(COLOR_HINTS[key])}>
                      {t(labelKey)}
                    </span>
                    <input
                      type="color"
                      className={css.colorInput}
                      value={colors[key] || DEFAULT_CHART_COLORS[key]}
                      onChange={(event) => { setColor(key, event.target.value) }}
                      aria-label={t(labelKey)}
                    />
                    <button
                      type="button"
                      className={css.colorReset}
                      onClick={() => { setColor(key, '') }}
                      title={t('settings.colorReset')}
                    >
                      ↺
                    </button>
                  </span>
                )
              })}
              <span className={css.colorNote}>{t('settings.colorsNote')}</span>
            </span>

            <button
              type="button"
              className={css.backBtn}
              onClick={() => { flipTo(false) }}
            >
              {t('settings.done')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** One bar column of the 7-day chart (heights relative to the max day). */
function UsageChart({ days }: { days: readonly DayUsage[] }) {
  const max = Math.max(...days.map(day => day.amount), 0.01)
  return (
    <span className={css.chart} role="img" aria-label="7-day usage">
      {days.map((day, index) => {
        const last = index === days.length - 1
        const peakHeight = (day.peakAmount / max) * 100
        const offHeight = (day.offPeakAmount / max) * 100
        const totalHeight = (day.amount / max) * 100
        const hasSplit = day.peakAmount > 0 || day.offPeakAmount > 0
        // Split days stack peak + off-peak; days without a split (no local
        // logs to derive it from) fall back to a single total bar.
        const title = hasSplit
          ? `${day.date} · peak ¥${day.peakAmount.toFixed(2)} · off-peak ¥${day.offPeakAmount.toFixed(2)}`
          : `${day.date} · ¥${day.amount.toFixed(2)}`
        return (
          <span key={day.date} className={css.chartCol} title={title}>
            <span className={css.chartTrack}>
              <span className={css.chartBars}>
                {hasSplit ? (
                  <>
                    {day.peakAmount > 0 && (
                      <span className={css.barPeak} style={{ height: `${peakHeight}%` }} />
                    )}
                    {day.offPeakAmount > 0 && (
                      <span className={css.barOff} style={{ height: `${offHeight}%` }} />
                    )}
                  </>
                ) : day.amount > 0 && (
                  <span className={css.barTotal} style={{ height: `${totalHeight}%` }} />
                )}
              </span>
              {last && <span className={css.todayMark} />}
            </span>
            <span className={clsx(css.chartLabel, last && css.chartLabelToday)}>
              {formatDayLabel(day.date)}
            </span>
          </span>
        )
      })}
    </span>
  )
}
