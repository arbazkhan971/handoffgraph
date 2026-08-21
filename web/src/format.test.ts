// Table-driven tests for the formatting helpers.

import { describe, expect, it } from 'vitest'
import {
  formatCost,
  formatDuration,
  formatTokens,
  formatTime,
  shortID,
  verificationLabel,
} from './format'

describe('formatDuration', () => {
  const cases: Array<[number, string]> = [
    [0, '0ns'],
    [999, '999ns'],
    [1_000, '1µs'],
    [1_500, '1.5µs'],
    [940_000, '940µs'],
    [1_000_000, '1ms'],
    [9_400_000, '9.4ms'],
    [94_000_000, '94ms'],
    [1_500_000_000, '1.5s'],
    [94_000_000_000, '1m 34s'],
    [3_600_000_000_000, '1h 0m'],
    [7_320_000_000_000, '2h 2m'],
    [-1, '—'],
    [Number.NaN, '—'],
  ]
  it.each(cases)('formatDuration(%d) -> %s', (ns, want) => {
    expect(formatDuration(ns)).toBe(want)
  })
})

describe('formatTime', () => {
  it('renders — for zero/invalid timestamps', () => {
    expect(formatTime(0)).toBe('—')
    expect(formatTime(-1)).toBe('—')
    expect(formatTime(Number.NaN)).toBe('—')
  })
  it('renders a HH:MM:SS string for valid timestamps', () => {
    const ns = Date.UTC(2026, 7, 21, 12, 0, 0) * 1_000_000
    expect(formatTime(ns)).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })
})

describe('formatTokens', () => {
  const cases: Array<[number | undefined, string]> = [
    [undefined, '—'],
    [0, '0'],
    [999, '999'],
    [12_400, '12.4k'],
    [999_999, '1000k'],
    [2_300_000, '2.3M'],
  ]
  it.each(cases)('formatTokens(%p) -> %s', (n, want) => {
    expect(formatTokens(n)).toBe(want)
  })
})

describe('shortID', () => {
  const cases: Array<[string | undefined, string]> = [
    [undefined, '—'],
    ['', '—'],
    ['spn_1', 'spn_1'],
    ['spn_01J2F7A000000000000000042', 'spn_…0042'],
    ['ws_01J2F7A000000000000000001', 'ws_…0001'],
  ]
  it.each(cases)('shortID(%p) -> %s', (id, want) => {
    expect(shortID(id)).toBe(want)
  })
})

describe('formatCost', () => {
  const cases: Array<[string | undefined, string | undefined, string]> = [
    [undefined, 'USD', '—'],
    ['', 'USD', '—'],
    ['0.0421', 'USD', '0.0421 USD'],
    ['0.0421', undefined, '0.0421'],
  ]
  it.each(cases)('formatCost(%p, %p) -> %s', (amount, currency, want) => {
    expect(formatCost(amount, currency)).toBe(want)
  })
})

describe('verificationLabel', () => {
  const cases: Array<[string | undefined, string]> = [
    ['verified', 'verified'],
    ['failed', 'failed'],
    ['missing', 'missing'],
    ['unknown', 'unknown'],
    [undefined, 'unknown'],
  ]
  it.each(cases)('verificationLabel(%p) -> %s', (state, want) => {
    expect(verificationLabel(state)).toBe(want)
  })
})
