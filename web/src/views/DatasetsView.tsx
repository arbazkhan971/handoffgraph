// View 5: datasets & experiments — immutable, content-hashed dataset
// versions, the runs recorded against them, and the regression diff between
// two runs.
//
// The comparison is computed server-side by the same function
// `handoffgraph experiment compare` uses, so the panel below can never
// disagree with the command line about what regressed.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchDatasets, fetchExperimentCompare, fetchExperiments } from '../api'
import { DataSourceBadge, EmptyView, ErrorView, LoadingView } from '../components/StateViews'
import { comparisonVerdict, formatStamp } from '../format'
import type {
  DataSource,
  DatasetVersion,
  ExperimentCompare,
  ExperimentComparison,
  ExperimentRun,
} from '../types'

/** Chip class per per-example verdict movement. */
const verdictChip: Record<ReturnType<typeof comparisonVerdict>, string> = {
  regression: 'chip-error',
  recovered: 'chip-ok',
  changed: 'chip-warn',
  same: 'chip-neutral',
}

function statusCell(status: string, p0: number): string {
  return p0 > 0 ? `${status} (p0 ${p0})` : status
}

function runLabel(run: ExperimentRun): string {
  return `${run.id} · ${run.dataset}@${run.version.slice(0, 14)}… · ${run.passed_count}/${run.example_count} ok · ${formatStamp(run.created_at)}`
}

export function DatasetsView() {
  const [datasets, setDatasets] = useState<{
    loading: boolean
    error: string | null
    items: DatasetVersion[]
    source: DataSource
  }>({ loading: true, error: null, items: [], source: 'live' })

  const [runs, setRuns] = useState<{
    loading: boolean
    error: string | null
    items: ExperimentRun[]
    source: DataSource
  }>({ loading: true, error: null, items: [], source: 'live' })

  // `touched` keeps a user's pick from being overwritten when the run list
  // reloads; until then the newest two runs of one dataset are preselected.
  const [pair, setPair] = useState<{ a: string; b: string; touched: boolean }>({
    a: '',
    b: '',
    touched: false,
  })

  // `key` records which pair the result belongs to. Comparing it with the
  // current selection during render tells the panel whether it is showing a
  // finished answer or still waiting — no setState inside an effect needed.
  const [cmp, setCmp] = useState<{
    key: string
    error: string | null
    data: ExperimentCompare | null
    source: DataSource
  }>({ key: '', error: null, data: null, source: 'live' })

  const load = useCallback((): void => {
    fetchDatasets()
      .then(({ data, source }) => setDatasets({ loading: false, error: null, items: data, source }))
      .catch((err: unknown) =>
        setDatasets((s) => ({ ...s, loading: false, error: errText(err) })),
      )
    fetchExperiments()
      .then(({ data, source }) => {
        setRuns({ loading: false, error: null, items: data, source })
        setPair((prev) => (prev.touched ? prev : defaultPair(data)))
      })
      .catch((err: unknown) => setRuns((s) => ({ ...s, loading: false, error: errText(err) })))
  }, [])

  useEffect(load, [load])

  const pairKey = pair.a && pair.b && pair.a !== pair.b ? `${pair.a}|${pair.b}` : ''

  // isCurrent drops a response whose selection was replaced while it was in
  // flight, so a slow comparison can never overwrite a newer one.
  const loadCompare = useCallback(
    (isCurrent: () => boolean = () => true): void => {
      if (!pairKey) return
      fetchExperimentCompare(pair.a, pair.b)
        .then(({ data, source }) => {
          if (isCurrent()) setCmp({ key: pairKey, error: null, data, source })
        })
        .catch((err: unknown) => {
          if (isCurrent()) setCmp({ key: pairKey, error: errText(err), data: null, source: 'live' })
        })
    },
    [pair.a, pair.b, pairKey],
  )

  useEffect(() => {
    let live = true
    loadCompare(() => live)
    return () => {
      live = false
    }
  }, [loadCompare])

  const retry = (): void => {
    setDatasets({ loading: true, error: null, items: [], source: 'live' })
    setRuns({ loading: true, error: null, items: [], source: 'live' })
    load()
  }

  // Comparing runs of different datasets is meaningless, so the candidate
  // list is restricted to the baseline's dataset once one is chosen.
  const baseline = useMemo(() => runs.items.find((r) => r.id === pair.a), [runs.items, pair.a])
  const candidates = useMemo(
    () => (baseline ? runs.items.filter((r) => r.dataset === baseline.dataset) : runs.items),
    [runs.items, baseline],
  )

  return (
    <>
      <div className="panel">
        <div className="panel-header">
          <h2>Datasets</h2>
          <span className="count">{datasets.items.length} version(s)</span>
          <span style={{ flex: 1 }} />
          <DataSourceBadge source={datasets.source} />
        </div>
        {datasets.loading ? (
          <LoadingView rows={3} />
        ) : datasets.error ? (
          <ErrorView message={datasets.error} onRetry={retry} />
        ) : datasets.items.length === 0 ? (
          <EmptyView
            title="No datasets"
            hint={
              <>
                Create one with <code>handoffgraph dataset create &lt;name&gt; --file &lt;fixture.jsonl&gt;</code>.
              </>
            }
          />
        ) : (
          <>
            <div className="ds-grid">
              <span>Dataset</span>
              <span>Version</span>
              <span style={{ textAlign: 'right' }}>Examples</span>
              <span>Created</span>
            </div>
            {datasets.items.map((ds) => (
              <div className="ds-row" key={ds.event_id}>
                <span className="title">{ds.name}</span>
                <span className="id" title={ds.content_hash}>
                  {ds.version}
                </span>
                <span className="num">{ds.example_count}</span>
                <span className="id">{formatStamp(ds.created_at)}</span>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2>Experiment runs</h2>
          <span className="count">{runs.items.length} run(s)</span>
          <span style={{ flex: 1 }} />
          <DataSourceBadge source={runs.source} />
        </div>
        {runs.loading ? (
          <LoadingView rows={3} />
        ) : runs.error ? (
          <ErrorView message={runs.error} onRetry={retry} />
        ) : runs.items.length === 0 ? (
          <EmptyView
            title="No experiment runs"
            hint={
              <>
                Run one with <code>handoffgraph experiment run --dataset &lt;name&gt;</code>.
              </>
            }
          />
        ) : (
          <>
            <div className="run-grid">
              <span>Run</span>
              <span>Dataset @ version</span>
              <span style={{ textAlign: 'right' }}>Passed</span>
              <span style={{ textAlign: 'right' }}>Failed</span>
              <span>Verdict</span>
              <span>Created</span>
            </div>
            {runs.items.map((run) => (
              <div
                className={`run-row${run.id === pair.a || run.id === pair.b ? ' selected' : ''}`}
                key={run.id}
              >
                <span className="id" title={run.id}>
                  {run.id}
                  {run.id === pair.a && <span className="kind-chip"> A</span>}
                  {run.id === pair.b && <span className="kind-chip"> B</span>}
                </span>
                <span className="id">
                  {run.dataset}@{run.version}
                </span>
                <span className="num">{run.passed_count}</span>
                <span className={`num${run.failed_count > 0 ? ' err' : ''}`}>{run.failed_count}</span>
                <span>
                  <span className={`chip ${run.passed ? 'chip-ok' : 'chip-error'}`}>
                    <span className="dot" />
                    {run.passed ? 'passed' : 'failed'}
                  </span>
                </span>
                <span className="id">{formatStamp(run.created_at)}</span>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2>Compare runs</h2>
          <span className="count">
            {cmp.key === pairKey && cmp.data
              ? `${cmp.data.regressions} regression(s)`
              : 'pick a baseline and a candidate'}
          </span>
          <span style={{ flex: 1 }} />
          <DataSourceBadge source={cmp.source} />
        </div>
        <div className="filter-bar">
          <label>
            baseline (A)
            <select
              value={pair.a}
              onChange={(e) => setPair((p) => ({ ...p, a: e.target.value, touched: true }))}
            >
              <option value="">—</option>
              {runs.items.map((run) => (
                <option key={run.id} value={run.id}>
                  {runLabel(run)}
                </option>
              ))}
            </select>
          </label>
          <label>
            candidate (B)
            <select
              value={pair.b}
              onChange={(e) => setPair((p) => ({ ...p, b: e.target.value, touched: true }))}
            >
              <option value="">—</option>
              {candidates.map((run) => (
                <option key={run.id} value={run.id}>
                  {runLabel(run)}
                </option>
              ))}
            </select>
          </label>
          <span style={{ flex: 1 }} />
          <span className="filter-note">
            examples present in both runs only — a new example is a new dataset version, not a regression
          </span>
        </div>
        <CompareBody
          settled={cmp.key === pairKey}
          error={cmp.key === pairKey ? cmp.error : null}
          data={cmp.data}
          pair={pair}
          onRetry={() => loadCompare()}
        />
      </div>
    </>
  )
}

// settled says the result in `data` belongs to the current selection; until
// it does, the panel is still waiting on the comparison request.
function CompareBody({
  settled,
  error,
  data,
  pair,
  onRetry,
}: {
  settled: boolean
  error: string | null
  data: ExperimentCompare | null
  pair: { a: string; b: string }
  onRetry: () => void
}) {
  if (!pair.a || !pair.b) {
    return <EmptyView title="Select two runs" hint="Pick a baseline (A) and a candidate (B) above." />
  }
  if (pair.a === pair.b) {
    return <EmptyView title="Same run selected" hint="A comparison needs two different runs." />
  }
  if (error) return <ErrorView message={error} onRetry={onRetry} />
  if (!settled) return <LoadingView rows={3} />
  if (!data) {
    return <EmptyView title="Run not found" hint="One of the selected runs is not in this store." />
  }
  if (data.items.length === 0) {
    return (
      <EmptyView
        title="No shared examples"
        hint="These runs have no example names in common — they ran different dataset versions."
      />
    )
  }
  return (
    <>
      <div className="cmp-grid">
        <span>Example</span>
        <span>Baseline (A)</span>
        <span>Candidate (B)</span>
        <span>Verdict</span>
      </div>
      {data.items.map((row: ExperimentComparison) => {
        const verdict = comparisonVerdict(row)
        return (
          <div className={`cmp-row${verdict === 'regression' ? ' regression' : ''}`} key={row.file}>
            <span className="title">{row.file}</span>
            <span className="id">{statusCell(row.from_status, row.from_p0)}</span>
            <span className="id">{statusCell(row.to_status, row.to_p0)}</span>
            <span>
              <span className={`chip ${verdictChip[verdict]}`}>{verdict}</span>
            </span>
          </div>
        )
      })}
    </>
  )
}

/** Newest run as the candidate, the next newest of the same dataset as the baseline. */
function defaultPair(items: ExperimentRun[]): { a: string; b: string; touched: boolean } {
  if (items.length === 0) return { a: '', b: '', touched: false }
  const newest = items[0] // /api/experiments returns newest first
  const previous = items.slice(1).find((r) => r.dataset === newest.dataset)
  return { a: previous?.id ?? '', b: newest.id, touched: false }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
