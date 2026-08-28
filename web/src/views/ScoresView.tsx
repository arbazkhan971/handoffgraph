// View 4: scores — the universal quality primitive (numeric metric,
// categorical label, boolean verdict) attached to any spine object.
//
// Two filter layers: the workstream/target filters are server-side (they are
// part of the /api/scores request), while data type, source and the name
// substring narrow the fetched page locally so typing never re-queries.
// Provenance is rendered on every row: an INFERRED (LLM-judge) score must
// never look like an OBSERVED measurement.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchScores } from '../api'
import { EvidenceBadge } from '../components/EvidenceBadge'
import { DataSourceBadge, EmptyView, ErrorView, LoadingView } from '../components/StateViews'
import { formatScoreValue, formatStamp } from '../format'
import type { DataSource, Score, ScoreDataType, ScoreSource } from '../types'

interface ScoresViewProps {
  workstreamID?: string
  targetID?: string
  onBack?: () => void
}

const DATA_TYPES: ScoreDataType[] = ['NUMERIC', 'CATEGORY', 'BOOLEAN']
const SOURCES: ScoreSource[] = ['human', 'api', 'evaluation', 'detection']

/** Boolean verdicts read as pass/fail; the other types stay literal. */
function valueClass(score: Score): string {
  if (score.data_type !== 'BOOLEAN') return 'score-value'
  return score.bool_value ? 'score-value ok' : 'score-value err'
}

export function ScoresView({ workstreamID, targetID, onBack }: ScoresViewProps) {
  const [state, setState] = useState<{
    loading: boolean
    error: string | null
    items: Score[]
    source: DataSource
  }>({ loading: true, error: null, items: [], source: 'live' })
  const [dataType, setDataType] = useState<ScoreDataType | 'ALL'>('ALL')
  const [source, setSource] = useState<ScoreSource | 'ALL'>('ALL')
  const [needle, setNeedle] = useState('')

  const load = useCallback((): void => {
    fetchScores({ workstream: workstreamID, target: targetID })
      .then(({ data, source: from }) =>
        setState({ loading: false, error: null, items: data, source: from }),
      )
      .catch((err: unknown) =>
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        })),
      )
  }, [workstreamID, targetID])

  useEffect(load, [load])

  const retry = (): void => {
    setState({ loading: true, error: null, items: [], source: 'live' })
    load()
  }

  const shown = useMemo(() => {
    const trimmed = needle.trim().toLowerCase()
    return state.items.filter((s) => {
      if (dataType !== 'ALL' && s.data_type !== dataType) return false
      if (source !== 'ALL' && s.source !== source) return false
      if (!trimmed) return true
      return s.name.toLowerCase().includes(trimmed) || s.target_id.toLowerCase().includes(trimmed)
    })
  }, [state.items, dataType, source, needle])

  const scope = targetID ?? workstreamID

  return (
    <div className="panel">
      <div className="panel-header">
        {onBack && (
          <a href="#/workstreams" onClick={onBack} style={{ marginRight: 4 }}>
            ← workstreams
          </a>
        )}
        <h2>Scores{scope ? ` · ${scope}` : ''}</h2>
        <span className="count">
          {shown.length === state.items.length
            ? `${state.items.length} total`
            : `${shown.length} of ${state.items.length}`}
        </span>
        <span style={{ flex: 1 }} />
        <DataSourceBadge source={state.source} />
      </div>

      <div className="filter-bar">
        <label>
          type
          <select value={dataType} onChange={(e) => setDataType(e.target.value as ScoreDataType | 'ALL')}>
            <option value="ALL">all</option>
            {DATA_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          source
          <select value={source} onChange={(e) => setSource(e.target.value as ScoreSource | 'ALL')}>
            <option value="ALL">all</option>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          filter
          <input
            type="search"
            value={needle}
            placeholder="name or target id"
            onChange={(e) => setNeedle(e.target.value)}
          />
        </label>
        <span style={{ flex: 1 }} />
        <span className="filter-note">
          provenance is shown per row — INFERRED values are judgments, not measurements
        </span>
      </div>

      {state.loading ? (
        <LoadingView rows={5} />
      ) : state.error ? (
        <ErrorView message={state.error} onRetry={retry} />
      ) : state.items.length === 0 ? (
        <EmptyView
          title="No scores recorded"
          hint={
            <>
              Record one with <code>handoffgraph score record --name quality --value 0.9 --target &lt;id&gt;</code>.
            </>
          }
        />
      ) : shown.length === 0 ? (
        <EmptyView title="No scores match these filters" hint="Widen the type, source or text filter." />
      ) : (
        <>
          <div className="score-grid">
            <span>Name</span>
            <span>Value</span>
            <span>Type</span>
            <span>Target</span>
            <span>Source</span>
            <span>Provenance</span>
            <span>Recorded</span>
          </div>
          {shown.map((s) => (
            <div className="score-row" key={s.score_id}>
              <span className="obj">
                <span className="title">{s.name}</span>
                {s.comment && <span className="sub">{s.comment}</span>}
              </span>
              <span className={valueClass(s)}>{formatScoreValue(s)}</span>
              <span>
                <span className="kind-chip">{s.data_type}</span>
              </span>
              <span className="id" title={s.target_id}>
                <span className="kind-chip">{s.target_type}</span> {s.target_id}
              </span>
              <span className="id">{s.source}</span>
              <span>
                <EvidenceBadge level={s.provenance} />
              </span>
              <span className="id">{formatStamp(s.occurred_at)}</span>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
