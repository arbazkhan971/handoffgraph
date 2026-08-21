// View 2: trace list with status chips, span counts, failed-span counts and
// durations, optionally filtered to one workstream.

import { useCallback, useEffect, useState } from 'react'
import { fetchTraces } from '../api'
import { TraceStatusChip, VerificationChip } from '../components/StatusChip'
import { DataSourceBadge, EmptyView, ErrorView, LoadingView } from '../components/StateViews'
import { formatDuration, formatTime } from '../format'
import type { DataSource, Trace } from '../types'

interface TracesViewProps {
  workstreamID?: string
  onBack?: () => void
  onOpen: (trace: Trace) => void
}

export function TracesView({ workstreamID, onBack, onOpen }: TracesViewProps) {
  const [state, setState] = useState<{
    loading: boolean
    error: string | null
    items: Trace[]
    source: DataSource
  }>({ loading: true, error: null, items: [], source: 'live' })

  const load = useCallback((): void => {
    fetchTraces(workstreamID)
      .then(({ data, source }) => setState({ loading: false, error: null, items: data, source }))
      .catch((err: unknown) =>
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        })),
      )
  }, [workstreamID])

  useEffect(load, [load])

  const retry = (): void => {
    setState({ loading: true, error: null, items: [], source: 'live' })
    load()
  }

  return (
    <div className="panel">
      <div className="panel-header">
        {onBack && (
          <a href="#/workstreams" onClick={onBack} style={{ marginRight: 4 }}>
            ← workstreams
          </a>
        )}
        <h2>Traces{workstreamID ? ` · ${workstreamID}` : ''}</h2>
        <span className="count">{state.items.length} total</span>
        <span style={{ flex: 1 }} />
        <DataSourceBadge source={state.source} />
      </div>
      {state.loading ? (
        <LoadingView rows={5} />
      ) : state.error ? (
        <ErrorView message={state.error} onRetry={retry} />
      ) : state.items.length === 0 ? (
        <EmptyView
          title="No traces"
          hint="Traces are materialized from captured events (hfg.trace.v1). Import events to populate."
        />
      ) : (
        <>
          <div className="trace-grid">
            <span>Status</span>
            <span>Objective / ID</span>
            <span style={{ textAlign: 'right' }}>Spans</span>
            <span style={{ textAlign: 'right' }}>Failed</span>
            <span style={{ textAlign: 'right' }}>Duration</span>
            <span>Verification</span>
          </div>
          {state.items.map((tr) => (
            <button
              type="button"
              className="trace-row"
              key={tr.trace_id}
              onClick={() => onOpen(tr)}
              aria-label={`Open trace ${tr.trace_id}`}
            >
              <span>
                <TraceStatusChip status={tr.status} />
              </span>
              <span className="obj">
                <span className="title">{tr.objective_excerpt || '(no objective recorded)'}</span>
                <br />
                <span className="sub">
                  {tr.trace_id} · {tr.provider || 'unknown'} · {formatTime(tr.started_at_ns)}
                </span>
              </span>
              <span className="num">{tr.span_count}</span>
              <span className={`num${tr.failed_span_count > 0 ? ' err' : ''}`}>
                {tr.failed_span_count}
              </span>
              <span className="num">
                {tr.duration_ns ? formatDuration(tr.duration_ns) : '—'}
              </span>
              <span>
                <VerificationChip state={tr.verification_state} />
              </span>
            </button>
          ))}
        </>
      )}
    </div>
  )
}
