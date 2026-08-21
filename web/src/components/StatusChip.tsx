import type { SpanStatus, TraceStatus, VerificationState } from '../types'

// Status chips: color + label per trace/span state. Colors are reused across
// trace and span chips via a shared class map so the language stays
// consistent between views.

type ChipClass = 'chip-ok' | 'chip-error' | 'chip-running' | 'chip-warn' | 'chip-purple' | 'chip-neutral'

const traceChip: Record<TraceStatus, ChipClass> = {
  RUNNING: 'chip-running',
  OK: 'chip-ok',
  ERROR: 'chip-error',
  CANCELLED: 'chip-neutral',
  INTERRUPTED: 'chip-warn',
  COMPACTED: 'chip-purple',
  ABANDONED: 'chip-neutral',
  UNKNOWN: 'chip-neutral',
}

const spanChip: Record<SpanStatus, ChipClass> = {
  ok: 'chip-ok',
  error: 'chip-error',
  failed: 'chip-error',
  running: 'chip-running',
  unknown: 'chip-neutral',
}

export function TraceStatusChip({ status }: { status: TraceStatus }) {
  const cls = traceChip[status] ?? 'chip-neutral'
  return (
    <span className={`chip ${cls}`}>
      <span className="dot" />
      {status}
    </span>
  )
}

export function SpanStatusChip({ status }: { status: SpanStatus }) {
  const cls = spanChip[status] ?? 'chip-neutral'
  return (
    <span className={`chip ${cls}`}>
      <span className="dot" />
      {status}
    </span>
  )
}

const verificationChip: Record<string, ChipClass> = {
  verified: 'chip-ok',
  failed: 'chip-error',
  missing: 'chip-warn',
  unknown: 'chip-neutral',
}

export function VerificationChip({ state }: { state: VerificationState }) {
  const cls = verificationChip[state] ?? 'chip-neutral'
  return <span className={`chip ${cls}`}>tests: {state}</span>
}

export function KindChip({ kind }: { kind: string }) {
  return <span className="kind-chip">{kind}</span>
}
