// Pure formatting helpers shared by every view. Kept free of React so they
// can be table-tested directly.

import type { ExperimentComparison, Score } from './types'

/** Formats a nanosecond duration for list/detail views. */
export function formatDuration(ns: number): string {
  if (!Number.isFinite(ns)) return '—'
  if (ns < 0) return '—'
  if (ns < 1_000) return `${ns}ns`
  const us = ns / 1_000
  if (us < 1_000) return `${round(us, us < 10 ? 1 : 0)}µs`
  const ms = us / 1_000
  if (ms < 1_000) return `${round(ms, ms < 10 ? 1 : 0)}ms`
  const s = ms / 1_000
  if (s < 60) return `${round(s, s < 10 ? 2 : 1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s - m * 60)
  if (m < 60) return `${m}m ${rem}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m - h * 60}m`
}

function round(v: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(v * f) / f
}

/** Formats nanoseconds since the Unix epoch as a local time string. */
export function formatTime(ns: number): string {
  if (!Number.isFinite(ns) || ns <= 0) return '—'
  return new Date(ns / 1_000_000).toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** Humanizes a token count (12_400 -> "12.4k"). */
export function formatTokens(n: number | undefined): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—'
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${round(n / 1_000, 1)}k`
  return `${round(n / 1_000_000, 1)}M`
}

/**
 * Shortens an ID for display, keeping the prefix and a stable suffix:
 * "spn_01J2F7A000000000000000042" -> "spn_…042".
 */
export function shortID(id: string | undefined, keep = 4): string {
  if (!id) return '—'
  if (id.length <= keep + 4) return id
  return `${id.slice(0, id.indexOf('_') + 1)}…${id.slice(-keep)}`
}

/** Formats a decimal cost string with its currency ("0.0421" + "USD"). */
export function formatCost(amount: string | undefined, currency: string | undefined): string {
  if (!amount) return '—'
  return currency ? `${amount} ${currency}` : amount
}

/**
 * Formats an RFC3339 timestamp (the string form used by /api/scores,
 * /api/datasets, /api/experiments and /api/prompts) for a dense table:
 * fractional seconds and the zone marker are dropped, the date is kept.
 */
export function formatStamp(ts: string | undefined): string {
  if (!ts) return '—'
  return ts.replace(/\.\d+/, '').replace('T', ' ').replace('Z', '')
}

/**
 * Renders a score from the single value slot its data_type selects. A slot
 * that does not match the declared data type is never read, so a malformed
 * record shows "—" instead of a value borrowed from another type.
 */
export function formatScoreValue(score: Score): string {
  switch (score.data_type) {
    case 'NUMERIC':
      return typeof score.value === 'number' && Number.isFinite(score.value) ? String(score.value) : '—'
    case 'CATEGORY':
      return score.string_value ? score.string_value : '—'
    case 'BOOLEAN':
      return typeof score.bool_value === 'boolean' ? String(score.bool_value) : '—'
    default:
      return '—'
  }
}

/**
 * Labels one example's movement between two experiment runs. `regression` is
 * decided by the server (status downgrade or a new P0 detection); a change
 * in the other direction is a recovery, and equal verdicts are unchanged.
 */
export function comparisonVerdict(cmp: ExperimentComparison): 'regression' | 'recovered' | 'changed' | 'same' {
  if (cmp.regression) return 'regression'
  if (cmp.from_status === cmp.to_status && cmp.from_p0 === cmp.to_p0) return 'same'
  if (cmp.to_p0 < cmp.from_p0 || (cmp.from_status !== 'ok' && cmp.to_status === 'ok')) return 'recovered'
  return 'changed'
}

export function verificationLabel(state: string | undefined): string {
  switch (state) {
    case 'verified':
      return 'verified'
    case 'failed':
      return 'failed'
    case 'missing':
      return 'missing'
    default:
      return 'unknown'
  }
}
