// View 1: workstream list — the entry page of the debugger.

import { useCallback, useEffect, useState } from 'react'
import { fetchWorkstreams } from '../api'
import { DataSourceBadge, EmptyView, ErrorView, LoadingView } from '../components/StateViews'
import type { DataSource, Workstream } from '../types'

interface WorkstreamsViewProps {
  onOpen: (workstream: Workstream) => void
}

export function WorkstreamsView({ onOpen }: WorkstreamsViewProps) {
  // Initial state is loading; every later loading transition happens
  // from a promise callback or the retry event handler, never
  // synchronously inside an effect.
  const [state, setState] = useState<{
    loading: boolean
    error: string | null
    items: Workstream[]
    source: DataSource
  }>({ loading: true, error: null, items: [], source: 'live' })

  const load = useCallback((): void => {
    fetchWorkstreams()
      .then(({ data, source }) => setState({ loading: false, error: null, items: data, source }))
      .catch((err: unknown) =>
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        })),
      )
  }, [])

  useEffect(load, [load])

  const retry = (): void => {
    setState({ loading: true, error: null, items: [], source: 'live' })
    load()
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Workstreams</h2>
        <span className="count">{state.items.length} total</span>
        <span style={{ flex: 1 }} />
        <DataSourceBadge source={state.source} />
      </div>
      {state.loading ? (
        <LoadingView rows={4} />
      ) : state.error ? (
        <ErrorView message={state.error} onRetry={retry} />
      ) : state.items.length === 0 ? (
        <EmptyView
          title="No workstreams yet"
          hint={
            <>
              Run <code>handoffgraph workstream new &quot;…&quot;</code> or import events with{' '}
              <code>handoffgraph event import &lt;file&gt;</code>.
            </>
          }
        />
      ) : (
        state.items.map((ws) => (
          <button
            type="button"
            className="row"
            key={ws.id}
            onClick={() => onOpen(ws)}
            aria-label={`Open traces for ${ws.title}`}
          >
            <span className="grow">
              <span className="title">{ws.title}</span>
              <br />
              <span className="sub">{ws.id}</span>
            </span>
            <span className="chip chip-neutral">{ws.status}</span>
            <span className="metric">
              <b>{ws.event_count}</b> events
            </span>
            <span className="metric">
              <b>{ws.trace_count}</b> traces
            </span>
            <span className="metric">{ws.created_at.replace('T', ' ').replace('Z', '')}</span>
          </button>
        ))
      )}
    </div>
  )
}
