// @vitest-environment jsdom
/** Pure period/format helpers of the usage card. */

import { describe, expect, it } from 'vitest'
import {
  currencySymbol, currentPeriod, formatAmount, formatClock, formatDayLabel, formatTokens,
  isOffPeak, isPeak, peakWindowLabel,
} from '../src/client/period.ts'

describe('isOffPeak / isPeak', () => {
  const atUtc = (hour: number, minute = 0): number => Date.UTC(2026, 0, 15, hour, minute)

  it('marks Beijing 09:00–12:00 and 14:00–18:00 as peak', () => {
    // 03:00 UTC = 11:00 Beijing → peak; 06:00 UTC = 14:00 Beijing → peak.
    expect(isPeak(atUtc(3))).toBe(true)
    expect(isPeak(atUtc(3, 59))).toBe(true)
    expect(isPeak(atUtc(6))).toBe(true)
    // 01:00 UTC = 09:00 Beijing → peak (window start inclusive).
    expect(isPeak(atUtc(1))).toBe(true)
    // 04:59 UTC = 12:59 Beijing → off-peak; 10:00 UTC = 18:00 Beijing → off-peak.
    expect(isPeak(atUtc(4, 59))).toBe(false)
    expect(isPeak(atUtc(10))).toBe(false)
  })

  it('treats everything else as off-peak (half price)', () => {
    // 05:00 UTC = 13:00 Beijing (午间) → off-peak; 00:00 UTC = 08:00 Beijing → off-peak.
    expect(isOffPeak(atUtc(5))).toBe(true)
    expect(isOffPeak(atUtc(0))).toBe(true)
    expect(isOffPeak(atUtc(4))).toBe(true)
    expect(isOffPeak(atUtc(12))).toBe(true)
    // Inside a peak window is not off-peak.
    expect(isOffPeak(atUtc(3))).toBe(false)
  })
})

describe('currentPeriod', () => {
  it('returns off-peak outside the peak windows and peak inside', () => {
    expect(currentPeriod(Date.UTC(2026, 0, 15, 5))).toBe('off-peak') // 13:00 Beijing
    expect(currentPeriod(Date.UTC(2026, 0, 15, 3))).toBe('peak') // 11:00 Beijing
  })
})

describe('formatTokens', () => {
  it('renders small counts verbatim', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
  })

  it('renders thousands and millions compactly', () => {
    expect(formatTokens(1_000)).toBe('1K')
    expect(formatTokens(1_234)).toBe('1.2K')
    expect(formatTokens(999_999)).toBe('1000K')
    expect(formatTokens(1_500_000)).toBe('1.5M')
    expect(formatTokens(2_500_000)).toBe('2.5M')
    expect(formatTokens(100_000_000)).toBe('100M')
  })
})

describe('currencySymbol / formatAmount', () => {
  it('maps CNY and USD symbols and falls back to the code', () => {
    expect(currencySymbol('CNY')).toBe('¥')
    expect(currencySymbol('USD')).toBe('$')
    expect(currencySymbol('EUR')).toBe('EUR ')
  })

  it('formats with two decimals and the symbol', () => {
    expect(formatAmount(12.345, 'CNY')).toBe('¥12.35')
    expect(formatAmount(0, 'USD')).toBe('$0.00')
    expect(formatAmount(3, 'EUR')).toBe('EUR 3.00')
  })
})

describe('formatClock', () => {
  it('renders the local HH:MM in the given zone', () => {
    const time = Date.UTC(2026, 0, 15, 8, 30)
    expect(formatClock(time, 'UTC')).toBe('08:30')
    expect(formatClock(time, 'Asia/Shanghai')).toBe('16:30')
  })
})

describe('peakWindowLabel', () => {
  it('renders the Beijing peak window', () => {
    expect(peakWindowLabel()).toBe('9:00–12:00、14:00–18:00（北京时间）')
  })
})

describe('formatDayLabel', () => {
  it('renders MM/DD from an ISO local date', () => {
    expect(formatDayLabel('2026-01-15')).toBe('01/15')
    expect(formatDayLabel('2026-12-03')).toBe('12/03')
  })
})
