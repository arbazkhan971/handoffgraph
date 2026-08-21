// View 3: trace detail — header facts, the virtualized span tree + waterfall,
// and the span detail drawer. Selection state is local to this view.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchTraceDetail, type TraceDetail } from '../api'
import { SpanWaterfall } from '../components/SpanWaterfall'
import { SpanDrawer } from '../components/SpanDrawer'
import { CostProvenanceNote } from '../components/EvidenceBadge'
import { TraceStatusChip, VerificationChip } from '../components/StatusChip'
import { DataSourceBadge, EmptyView, ErrorView, LoadingView } from '../components/StateViews'
import { formatCost, formatDuration, formatTime, formatTokens } from '../format'
import type { DataSource, Span } from '../types'

interface TraceDetailViewProps {
  traceID: string
  onBack?: () => void
}

export function TraceDetailView({ traceID, onBack }: TraceDetailViewProps) {
  const [state, setState] = useState<{
    loading: boolean
    error: string | null
    detail: TraceDetail | null
    source: DataSource
  }>({ loading: true, error: null, detail: null, source: 'live' })
  // Selection is keyed by trace id so navigating to another trace starts
  // with no selection without a synchronous setState in an effect.
  const [selection, setSelection] = useState<{ traceID: string; span: Span | null }>({
    traceID,
    span: null,
  })

  const load = useCallback((): void => {
    fetchTraceDetail(traceID)
      .then(({ data, source }) =>
        setState({ loading: false, error: null, detail: data, source }),
      )
      .catch((err: unknown) =>
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        })),
      )
  }, [traceID])

  useEffect(load, [load])

  const retry = (): void => {
    setState({ loading: true, error: null, detail: null, source: 'live' })
    load()
  }

  const onSelect = useCallback(
    (span: Span) => setSelection({ traceID, span }),
    [traceID],
  )

  // Keep the drawer in sync when a newer span list arrives (retry), and
  // drop the selection when the route moved to another trace.
  const selectedSpan = useMemo(() => {
    if (selection.traceID !== traceID || !selection.span || !state.detail) return null
    return state.detail.spans.find((sp) => sp.span_id === selection.span?.span_id) ?? null
  }, [selection, traceID, state.detail])

  if (state.loading) {
    return (
      <div className="panel">
        <div className="panel-header">
          {onBack && <a href="#/traces" onClick={onBack}>← traces</a>}
          <h2>{traceID}</h2>
        </div>
        <LoadingView rows={6} />
      </div>
    )
  }
  if (state.error) {
    return (
      <div className="panel">
        <div className="panel-header">
          <h2>{traceID}</h2>
        </div>
        <ErrorView message={state.error} onRetry={retry} />
      </div>
    )
  }
  if (!state.detail) {
    return (
      <div className="panel">
        <div className="panel-header">
          <h2>{traceID}</h2>
        </div>
        <EmptyView title="Trace not found" hint="It may not be materialized in this store." />
      </div>
    )
  }

  const { trace, spans } = state.detail
  return (
    <div className="panel" style={{ overflow: 'hidden' }}>
      <div className="detail-header">
        {onBack && <a href="#/traces" onClick={onBack}>← traces</a>}
        <h2>{trace.trace_id}</h2>
        <TraceStatusChip status={trace.status} />
        <VerificationChip state={trace.verification_state} />
        <DataSourceBadge source={state.source} />
        <div className="facts">
          <span>
            objective: <b>{trace.objective_excerpt || '—'}</b>
          </span>
          <span>
            started: <b>{formatTime(trace.started_at_ns)}</b>
          </span>
          <span>
            duration:{' '}
            <b>{trace.duration_ns ? formatDuration(trace.duration_ns) : 'open'}</b>
          </span>
          <span>
            spans: <b>{trace.span_count}</b>
          </span>
          <span>
            failed: <b style={{ color: trace.failed_span_count > 0 ? 'var(--error)' : undefined }}>
              {trace.failed_span_count}
            </b>
          </span>
          <span>
            files changed: <b>{trace.changed_file_count}</b>
          </span>
          {trace.provider && (
            <span>
              provider: <b>{trace.provider}</b>
            </span>
          )}
          <span>
            session: <b>{trace.session_id}</b>
          </span>
          {(trace.token_input !== undefined || trace.token_output !== undefined) && (
            <span>
              tokens: <b>in {formatTokens(trace.token_input)} / out {formatTokens(trace.token_output)}</b>
            </span>
          )}
          {trace.cost_amount && (
            <span>
              cost: <b>{formatCost(trace.cost_amount, trace.cost_currency)}</b>{' '}
              <CostProvenanceNote provenance={trace.cost_provenance} />
            </span>
          )}
          {trace.content_policy && (
            <span>
              content policy: <b>{trace.content_policy}</b>
            </span>
          )}
        </div>
      </div>
      <div className="detail-body">
        <SpanWaterfall trace={trace} spans={spans} selectedID={selectedSpan?.span_id ?? null} onSelect={onSelect} />
        <SpanDrawer span={selectedSpan} />
      </div>
    </div>
  )
}
