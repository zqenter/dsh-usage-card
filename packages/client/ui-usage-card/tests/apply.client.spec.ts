// @vitest-environment jsdom
/**
 * Plugin apply and rendered card specs through the real slot test runtime:
 * the footer-action registration, the store's RPC polling, and the wide/rail
 * renderings (Chinese copy pinned).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-usage-card/client'

usePinnedBrowserLanguages('zh-CN')

const BALANCE = {
  isAvailable: true,
  currencies: [{ currency: 'CNY', total: 110.5, granted: 10, toppedUp: 100.5 }],
  fetchedAt: 1,
}

const TODAY = {
  date: '2026-01-15',
  timeZone: 'UTC',
  model: 'deepseek-v4-flash',
  source: 'estimate',
  tokens: { uncachedInput: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 500_000, total: 1_500_000 },
  amount: 6,
  peakAmount: 6,
  offPeakAmount: 0,
  pricedSamples: 2,
  sessionCount: 1,
  pricedAt: 1,
  days: [
    { date: '2026-01-09', amount: 0, peakAmount: 0, offPeakAmount: 0, tokens: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 } },
    { date: '2026-01-10', amount: 2, peakAmount: 1, offPeakAmount: 1, tokens: { uncachedInput: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0, total: 1_000_000 } },
    { date: '2026-01-11', amount: 0, peakAmount: 0, offPeakAmount: 0, tokens: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 } },
    { date: '2026-01-12', amount: 8, peakAmount: 8, offPeakAmount: 0, tokens: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 1_000_000, total: 1_000_000 } },
    { date: '2026-01-13', amount: 0, peakAmount: 0, offPeakAmount: 0, tokens: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 } },
    { date: '2026-01-14', amount: 4, peakAmount: 0, offPeakAmount: 4, tokens: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 1_000_000, total: 1_000_000 } },
    { date: '2026-01-15', amount: 6, peakAmount: 6, offPeakAmount: 0, tokens: { uncachedInput: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 500_000, total: 1_500_000 } },
  ],
}

function fakeConnection(overrides: Partial<Record<'balance' | 'today', unknown>> = {}): ConnectionHandle {
  const rpc = {
    call: vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === 'balance') return { ok: true, value: overrides.balance ?? BALANCE }
      if (endpoint === 'platformToken.status') return { ok: true, value: { configured: false } }
      return { ok: true, value: overrides.today ?? TODAY }
    }),
  }
  return { rpc } as unknown as ConnectionHandle
}

async function bench(connection: ConnectionHandle) {
  const runtime = await SlotTestRuntime.create()
  runtime.provide('connection', connection)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.declare({ 'sidebar.footer.action': { kind: 'list', scope: 'root' } })
  const handle = await runtime.mount({ inject: [...inject], apply })
  return { runtime, handle }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ui-usage-card apply', () => {
  it('declares only the services it uses', () => {
    expect(inject).toEqual(['slots', 'connection', 'locale'])
  })

  it('registers the card into sidebar.footer.action', async () => {
    const { runtime, handle } = await bench(fakeConnection())
    const entries = runtime.slots.entries('sidebar.footer.action')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.options.id).toBe('usage-card')
    expect(entries[0]!.locale).toBe('usage-card')
    await handle.dispose()
    expect(runtime.slots.entries('sidebar.footer.action')).toHaveLength(0)
  })
})

describe('usage card rendering', () => {
  it('renders balance, today tokens/amount, and the period badge when wide; expands to show the chart + breakdown', async () => {
    const { runtime } = await bench(fakeConnection())
    const view = runtime.renderSlot('sidebar.footer.action', { wide: true })
    await waitFor(() => { expect(view.view.getByText('¥110.50')).toBeTruthy() })
    expect(view.view.getByText('余额')).toBeTruthy()
    expect(view.view.getByText(/1\.5M/)).toBeTruthy()
    expect(view.view.getByText(/今日金额/)).toBeTruthy()
    expect(view.view.getByText(/¥6\.00/)).toBeTruthy()
    // Card actions: recharge link on the left, refresh button on the right.
    expect(view.view.getByText('充值')).toBeTruthy()
    expect(view.view.getByLabelText('刷新')).toBeTruthy()
    // The period badge renders one of the two states (峰/谷 also appear in the chart legend).
    expect(view.view.getAllByText(/谷|峰/).length).toBeGreaterThan(0)
    // Collapsed by default: only levels 1-3 — no chart, no breakdown rows.
    expect(view.view.queryByText('近 7 日用量')).toBeNull()
    expect(view.view.queryByText(/命中/)).toBeNull()
    const card = view.view.getByLabelText('刷新').closest('[data-usage-card]')!
    expect(card!.getAttribute('aria-expanded')).toBe('false')
    // Click the card to expand: the 7-day chart and breakdown rows appear.
    fireEvent.click(card!)
    expect(card!.getAttribute('aria-expanded')).toBe('true')
    await waitFor(() => { expect(view.view.getByText('近 7 日用量')).toBeTruthy() })
    // The legend window hint labels the PEAK window correctly.
    expect(view.view.getByText(/9:00–12:00、14:00–18:00/)).toBeTruthy()
    expect(view.view.getByText('01/09')).toBeTruthy()
    expect(view.view.getByText('01/15')).toBeTruthy()
    expect(view.view.getAllByText('峰').length).toBeGreaterThanOrEqual(1) // legend item
    expect(view.view.getByText(/命中/)).toBeTruthy()
    expect(view.view.getByText(/输入/)).toBeTruthy()
    expect(view.view.getByText(/输出/)).toBeTruthy()
    // Estimate mode carries no month/lifetime rows.
    expect(view.view.queryByText(/本月/)).toBeNull()
    // Click again to collapse back to levels 1-3.
    fireEvent.click(card!)
    expect(card!.getAttribute('aria-expanded')).toBe('false')
    expect(view.view.queryByText('近 7 日用量')).toBeNull()
  })

  it('shows month/lifetime consumption with official data when expanded', async () => {
    const official = {
      date: '2026-01-15',
      timeZone: 'UTC',
      model: 'deepseek-v4-flash',
      source: 'official',
      tokens: { uncachedInput: 776_255, cacheRead: 265_971_968, cacheWrite: 0, output: 802_332, total: 267_550_555 },
      amount: 28.23,
      peakAmount: 0,
      offPeakAmount: 0,
      pricedSamples: 0,
      sessionCount: 0,
      monthTotal: 120.5,
      lifetimeTotal: 242.3,
      requests: 1099,
      pricedAt: 1,
      days: [
        { date: '2026-01-15', amount: 28.23, peakAmount: 0, offPeakAmount: 0, tokens: { uncachedInput: 776_255, cacheRead: 265_971_968, cacheWrite: 0, output: 802_332, total: 267_550_555 } },
      ],
    }
    const { runtime } = await bench(fakeConnection({ today: official }))
    const view = runtime.renderSlot('sidebar.footer.action', { wide: true })
    await waitFor(() => { expect(view.view.getByText(/28\.23/)).toBeTruthy() })
    expect(view.view.getByText('官方')).toBeTruthy()
    // Month/lifetime rows only appear once the card is expanded.
    expect(view.view.queryByText(/本月/)).toBeNull()
    const card = view.view.getByLabelText('刷新').closest('[data-usage-card]')!
    fireEvent.click(card!)
    await waitFor(() => { expect(view.view.getByText(/本月/)).toBeTruthy() })
    expect(view.view.getByText(/请求/)).toBeTruthy()
    expect(view.view.getByText(/1,099/)).toBeTruthy()
    expect(view.view.getByText(/累计/)).toBeTruthy()
    expect(view.view.getByText(/¥242\.30/)).toBeTruthy()
  })

  it('spins the refresh button one full rotation per click', async () => {
    const { runtime } = await bench(fakeConnection())
    const view = runtime.renderSlot('sidebar.footer.action', { wide: true })
    await waitFor(() => { expect(view.view.getByLabelText('刷新')).toBeTruthy() })
    vi.useFakeTimers()
    const button = view.view.getByLabelText('刷新')
    expect(button.className).not.toContain('spinning')
    fireEvent.click(button)
    expect(button.className).toContain('spinning')
    // The spin always completes: the timeout backstop clears it after one rotation.
    act(() => { vi.advanceTimersByTime(900) })
    expect(button.className).not.toContain('spinning')
    vi.useRealTimers()
  })

  it('flips to the settings face with the token tutorial and chart colors', async () => {
    const { runtime } = await bench(fakeConnection())
    const view = runtime.renderSlot('sidebar.footer.action', { wide: true })
    await waitFor(() => { expect(view.view.getByLabelText('设置')).toBeTruthy() })
    const card = view.view.getByLabelText('设置').closest('[data-usage-card]')
    expect(card).not.toBeNull()
    expect(card!.className).not.toContain('flipped')
    fireEvent.click(view.view.getByLabelText('设置'))
    expect(card!.className).toContain('flipped')
    // Back face: token field + acquisition tutorial + color rows.
    expect(view.view.getByText('平台 Token')).toBeTruthy()
    expect(view.view.getAllByText(/platform.deepseek.com/).length).toBeGreaterThan(0)
    expect(view.view.getByLabelText('峰色')).toBeTruthy()
    expect(view.view.getByLabelText('谷色')).toBeTruthy()
    expect(view.view.getByLabelText('总额色')).toBeTruthy()
    fireEvent.click(view.view.getByLabelText('完成'))
    expect(card!.className).not.toContain('flipped')
  })

  it('expands and collapses the card on click (state-driven, no hover)', async () => {
    const { runtime } = await bench(fakeConnection())
    const view = runtime.renderSlot('sidebar.footer.action', { wide: true })
    await waitFor(() => { expect(view.view.getByLabelText('刷新')).toBeTruthy() })
    const card = view.view.getByLabelText('刷新').closest('[data-usage-card]')!
    expect(card).not.toBeNull()
    expect(card!.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(card!)
    expect(card!.getAttribute('aria-expanded')).toBe('true')
    await waitFor(() => { expect(view.view.getByText('近 7 日用量')).toBeTruthy() })
    // Clicking a control inside the card (refresh) must NOT collapse it.
    fireEvent.click(view.view.getByLabelText('刷新'))
    expect(card!.getAttribute('aria-expanded')).toBe('true')
    // Clicking the card body collapses again.
    fireEvent.click(card!)
    expect(card!.getAttribute('aria-expanded')).toBe('false')
    expect(view.view.queryByText('近 7 日用量')).toBeNull()
  })

  it('renders a compact pill on the rail', async () => {
    const { runtime } = await bench(fakeConnection())
    const view = runtime.renderSlot('sidebar.footer.action', { wide: false })
    await waitFor(() => { expect(view.view.getByText('¥110.50')).toBeTruthy() })
    expect(view.view.getByText('¥110.50').className).toContain('rail')
  })

  it('shows unavailable on RPC failure', async () => {
    const rpc = {
      call: vi.fn(async () => ({ ok: false, error: { code: 'internal', message: 'boom', details: {} } })),
    }
    const { runtime } = await bench({ rpc } as unknown as ConnectionHandle)
    const view = runtime.renderSlot('sidebar.footer.action', { wide: true })
    await waitFor(() => { expect(view.view.getByText('不可用')).toBeTruthy() })
  })
})
