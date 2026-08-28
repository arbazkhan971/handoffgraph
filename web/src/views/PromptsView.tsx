// View 6: prompts — the versioned prompt store. Immutable content-addressed
// versions plus mutable labels (`production`, `latest`, custom) that point at
// one of them, which is what makes a rollback a single label move.
//
// Drill-down: prompt list → version ladder (labels as chips) → body panel.
// Bodies were size-capped when the version was created, so the body panel
// renders the stored text verbatim as preformatted text and never
// interprets it.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchPromptBody, fetchPrompts } from '../api'
import { DataSourceBadge, EmptyView, ErrorView, LoadingView } from '../components/StateViews'
import { formatStamp } from '../format'
import type { DataSource, Prompt, PromptBody, PromptLabel } from '../types'

/** `production` is the deployed pointer; every other label is informational. */
function labelChipClass(label: string): string {
  if (label === 'production') return 'chip-ok'
  if (label === 'latest') return 'chip-running'
  return 'chip-purple'
}

function LabelChips({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null
  return (
    <>
      {labels.map((label) => (
        <span className={`chip ${labelChipClass(label)}`} key={label}>
          {label}
        </span>
      ))}
    </>
  )
}

/** Label chips that also show which version the label currently points at. */
function LabelPointerChips({ labels }: { labels: PromptLabel[] }) {
  return (
    <>
      {labels.map((l) => (
        <span className={`chip ${labelChipClass(l.label)}`} key={l.label}>
          {l.label} → v{l.version}
        </span>
      ))}
    </>
  )
}

export function PromptsView() {
  const [state, setState] = useState<{
    loading: boolean
    error: string | null
    items: Prompt[]
    source: DataSource
  }>({ loading: true, error: null, items: [], source: 'live' })

  // version 0 means "whatever `latest` resolves to" — the same default the
  // /api/prompts/show endpoint applies.
  const [sel, setSel] = useState<{ name: string; version: number; touched: boolean }>({
    name: '',
    version: 0,
    touched: false,
  })

  // `key` records which (name, version) the body belongs to; comparing it
  // with the current selection during render distinguishes "still loading"
  // from "no such version" without a setState inside an effect.
  const [body, setBody] = useState<{
    key: string
    error: string | null
    data: PromptBody | null
    source: DataSource
  }>({ key: '', error: null, data: null, source: 'live' })

  const load = useCallback((): void => {
    fetchPrompts()
      .then(({ data, source }) => {
        setState({ loading: false, error: null, items: data, source })
        setSel((prev) =>
          prev.touched || data.length === 0 ? prev : { name: data[0].name, version: 0, touched: false },
        )
      })
      .catch((err: unknown) =>
        setState((s) => ({ ...s, loading: false, error: errText(err) })),
      )
  }, [])

  useEffect(load, [load])

  const bodyKey = sel.name ? `${sel.name}|${sel.version}` : ''

  const loadBody = useCallback(
    (isCurrent: () => boolean = () => true): void => {
      if (!bodyKey) return
      fetchPromptBody(sel.name, sel.version || undefined)
        .then(({ data, source }) => {
          if (isCurrent()) setBody({ key: bodyKey, error: null, data, source })
        })
        .catch((err: unknown) => {
          if (isCurrent()) setBody({ key: bodyKey, error: errText(err), data: null, source: 'live' })
        })
    },
    [sel.name, sel.version, bodyKey],
  )

  useEffect(() => {
    let live = true
    loadBody(() => live)
    return () => {
      live = false
    }
  }, [loadBody])

  const retry = (): void => {
    setState({ loading: true, error: null, items: [], source: 'live' })
    load()
  }

  const selected = useMemo(() => state.items.find((p) => p.name === sel.name), [state.items, sel.name])
  const settled = body.key === bodyKey
  const shown = settled ? body.data : null
  const shownVersion = shown?.version ?? sel.version

  const labelsFor = (prompt: Prompt, version: number): string[] =>
    prompt.labels.filter((l) => l.version === version).map((l) => l.label)

  return (
    <>
      <div className="panel">
        <div className="panel-header">
          <h2>Prompts</h2>
          <span className="count">{state.items.length} total</span>
          <span style={{ flex: 1 }} />
          <DataSourceBadge source={state.source} />
        </div>
        {state.loading ? (
          <LoadingView rows={3} />
        ) : state.error ? (
          <ErrorView message={state.error} onRetry={retry} />
        ) : state.items.length === 0 ? (
          <EmptyView
            title="No prompts"
            hint={
              <>
                Create one with <code>handoffgraph prompt create &lt;name&gt; --file prompt.txt</code>.
              </>
            }
          />
        ) : (
          state.items.map((p) => (
            <button
              type="button"
              className={`row${p.name === sel.name ? ' selected' : ''}`}
              key={p.name}
              onClick={() => setSel({ name: p.name, version: 0, touched: true })}
              aria-label={`Show prompt ${p.name}`}
            >
              <span className="grow">
                <span className="title">{p.name}</span>
                <br />
                <span className="sub">latest {p.latest_hash}</span>
              </span>
              <LabelPointerChips labels={p.labels} />
              <span className="metric">
                <b>{p.version_count}</b> version(s)
              </span>
              <span className="metric">{formatStamp(p.latest_created_at)}</span>
            </button>
          ))
        )}
      </div>

      {selected && (
        <div className="panel">
          <div className="panel-header">
            <h2>Versions · {selected.name}</h2>
            <span className="count">{selected.version_count} immutable version(s)</span>
          </div>
          <div className="ver-grid">
            <span>Version</span>
            <span>Content hash</span>
            <span>Labels</span>
            <span>Created</span>
            <span>By</span>
          </div>
          {[...selected.versions].reverse().map((v) => (
            <button
              type="button"
              className={`ver-row${v.version === shownVersion ? ' selected' : ''}`}
              key={v.version}
              onClick={() => setSel({ name: selected.name, version: v.version, touched: true })}
              aria-label={`Show ${selected.name} version ${v.version}`}
            >
              <span className="title">v{v.version}</span>
              <span className="id" title={v.hash}>
                {v.hash}
              </span>
              <span className="chips">
                <LabelChips labels={labelsFor(selected, v.version)} />
              </span>
              <span className="id">{formatStamp(v.created_at)}</span>
              <span className="id">{v.created_by || '—'}</span>
            </button>
          ))}
        </div>
      )}

      <div className="panel">
        <div className="panel-header">
          <h2>Body{shown ? ` · ${shown.name} v${shown.version}` : ''}</h2>
          {shown && <LabelChips labels={shown.labels} />}
          <span style={{ flex: 1 }} />
          <DataSourceBadge source={body.source} />
        </div>
        {!sel.name ? (
          <EmptyView title="No prompt selected" hint="Pick a prompt above." />
        ) : settled && body.error ? (
          <ErrorView message={body.error} onRetry={() => loadBody()} />
        ) : !settled ? (
          <LoadingView rows={4} />
        ) : !shown ? (
          <EmptyView title="Version not found" hint="This version is not in the local store." />
        ) : (
          <>
            <div className="facts-row">
              <span>
                hash: <b>{shown.hash}</b>
              </span>
              <span>
                created: <b>{formatStamp(shown.created_at)}</b>
              </span>
              {shown.created_by && (
                <span>
                  by: <b>{shown.created_by}</b>
                </span>
              )}
              <span>
                latest: <b>v{shown.latest_version}</b> of {shown.version_count}
              </span>
            </div>
            <pre className="prompt-body">{shown.body}</pre>
          </>
        )}
      </div>
    </>
  )
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
