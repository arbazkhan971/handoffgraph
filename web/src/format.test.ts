// Table-driven tests for the formatting helpers.

import { describe, expect, it } from 'vitest'
import {
  comparisonVerdict,
  formatCost,
  formatDuration,
  formatScoreValue,
  formatStamp,
  formatTokens,
  formatTime,
  shortID,
  verificationLabel,
} from './format'
import type { ExperimentComparison, Score, ScoreDataType } from './types'

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

describe('formatStamp', () => {
  const cases: Array<[string | undefined, string]> = [
    [undefined, '—'],
    ['', '—'],
    ['2026-08-21T12:00:00Z', '2026-08-21 12:00:00'],
    ['2026-08-21T12:00:00.482Z', '2026-08-21 12:00:00'],
  ]
  it.each(cases)('formatStamp(%p) -> %s', (ts, want) => {
    expect(formatStamp(ts)).toBe(want)
  })
})

describe('formatScoreValue', () => {
  const score = (dataType: ScoreDataType, slots: Partial<Score>): Score => ({
    schema_version: 'hfg.score.v1',
    score_id: 'evt_1',
    occurred_at: '2026-08-21T12:00:00Z',
    name: 'quality',
    data_type: dataType,
    target_type: 'trace',
    target_id: 'trc_1',
    source: 'evaluation',
    ...slots,
  })

  const cases: Array<[string, Score, string]> = [
    ['numeric', score('NUMERIC', { value: 0.62 }), '0.62'],
    ['numeric zero', score('NUMERIC', { value: 0 }), '0'],
    ['numeric missing', score('NUMERIC', {}), '—'],
    ['category', score('CATEGORY', { string_value: 'regression' }), 'regression'],
    ['category empty', score('CATEGORY', { string_value: '' }), '—'],
    ['boolean true', score('BOOLEAN', { bool_value: true }), 'true'],
    ['boolean false', score('BOOLEAN', { bool_value: false }), 'false'],
    ['boolean missing', score('BOOLEAN', {}), '—'],
    // A slot that does not match the declared type is never borrowed.
    ['numeric never reads the string slot', score('NUMERIC', { string_value: 'nine' }), '—'],
    ['category never reads the numeric slot', score('CATEGORY', { value: 9 }), '—'],
  ]
  it.each(cases)('formatScoreValue(%s) -> %s', (_name, value, want) => {
    expect(formatScoreValue(value)).toBe(want)
  })
})

describe('comparisonVerdict', () => {
  const cmp = (from: string, to: string, fromP0: number, toP0: number, regression: boolean) =>
    ({
      file: 'a.jsonl',
      from_status: from,
      to_status: to,
      from_p0: fromP0,
      to_p0: toP0,
      regression,
    }) as ExperimentComparison

  const cases: Array<[string, ExperimentComparison, string]> = [
    ['unchanged', cmp('ok', 'ok', 0, 0, false), 'same'],
    ['new detection', cmp('ok', 'detections', 0, 1, true), 'regression'],
    ['still failing, worse', cmp('detections', 'detections', 1, 3, true), 'regression'],
    ['fixed', cmp('detections', 'ok', 1, 0, false), 'recovered'],
    ['fewer detections', cmp('detections', 'detections', 3, 1, false), 'recovered'],
    ['invalid example became parseable but still detects', cmp('invalid', 'detections', 0, 0, false), 'changed'],
  ]
  it.each(cases)('comparisonVerdict(%s) -> %s', (_name, value, want) => {
    expect(comparisonVerdict(value)).toBe(want)
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
