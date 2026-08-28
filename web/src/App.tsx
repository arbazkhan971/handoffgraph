// App shell + tiny hash router (no router dependency; works served from any
// path). Routes:
//   #/workstreams            workstream list
//   #/traces?workstream=<id> trace list (optionally filtered)
//   #/traces/<trace_id>      trace detail (tree + waterfall + drawer)
//   #/scores?workstream=&target=  score list (quality primitives)
//   #/datasets               dataset versions, experiment runs, run compare
//   #/prompts                versioned prompt store

import { useEffect, useState, type ReactNode } from 'react'
import { WorkstreamsView } from './views/WorkstreamsView'
import { TracesView } from './views/TracesView'
import { TraceDetailView } from './views/TraceDetailView'
import { ScoresView } from './views/ScoresView'
import { DatasetsView } from './views/DatasetsView'
import { PromptsView } from './views/PromptsView'
import { EmptyView } from './components/StateViews'
import type { Trace, Workstream } from './types'

/** Single source of truth for the version shown in the footer. */
const VERSION = 'v0.7.0-beta.1'

/** Top-level destinations, in header order. */
const NAV: { path: string; label: string }[] = [
  { path: '/workstreams', label: 'Workstreams' },
  { path: '/traces', label: 'Traces' },
  { path: '/scores', label: 'Scores' },
  { path: '/datasets', label: 'Datasets' },
  { path: '/prompts', label: 'Prompts' },
]

function useHashPath(): { path: string; query: URLSearchParams } {
  const [hash, setHash] = useState(() => window.location.hash || '#/workstreams')
  useEffect(() => {
    const onHashChange = (): void => setHash(window.location.hash || '#/workstreams')
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  const raw = hash.replace(/^#/, '') || '/workstreams'
  const qIdx = raw.indexOf('?')
  const path = qIdx === -1 ? raw : raw.slice(0, qIdx)
  const query = new URLSearchParams(qIdx === -1 ? '' : raw.slice(qIdx + 1))
  return { path, query }
}

const navigate = (to: string): void => {
  window.location.hash = to
}

export default function App() {
  const { path, query } = useHashPath()

  let view: ReactNode
  let crumb: string

  if (path === '/' || path === '/workstreams' || path === '') {
    crumb = 'Workstreams'
    view = (
      <WorkstreamsView
        onOpen={(ws: Workstream) => navigate(`/traces?workstream=${encodeURIComponent(ws.id)}`)}
      />
    )
  } else if (path === '/traces') {
    const ws = query.get('workstream') ?? undefined
    crumb = ws ? `Traces · ${ws}` : 'Traces'
    view = (
      <TracesView
        workstreamID={ws}
        onBack={ws ? () => navigate('/workstreams') : undefined}
        onOpen={(tr: Trace) => navigate(`/traces/${encodeURIComponent(tr.trace_id)}`)}
      />
    )
  } else if (path.startsWith('/traces/')) {
    const id = decodeURIComponent(path.slice('/traces/'.length))
    crumb = `Trace · ${id}`
    view = <TraceDetailView traceID={id} onBack={() => navigate(query.get('workstream') ? `/traces?workstream=${query.get('workstream')}` : '/traces')} />
  } else if (path === '/scores') {
    const ws = query.get('workstream') ?? undefined
    const target = query.get('target') ?? undefined
    crumb = target ? `Scores · ${target}` : ws ? `Scores · ${ws}` : 'Scores'
    view = (
      <ScoresView
        workstreamID={ws}
        targetID={target}
        onBack={ws || target ? () => navigate('/scores') : undefined}
      />
    )
  } else if (path === '/datasets') {
    crumb = 'Datasets & experiments'
    view = <DatasetsView />
  } else if (path === '/prompts') {
    crumb = 'Prompts'
    view = <PromptsView />
  } else {
    crumb = 'Not found'
    view = (
      <EmptyView
        title="Page not found"
        hint={
          <a href="#/workstreams">Go to workstreams</a>
        }
      />
    )
  }

  return (
    <div className="app">
      <header className="app-header">
        <span className="brand">
          <img src="/favicon.svg" alt="" />
          HandoffGraph
        </span>
        <nav className="app-nav">
          {NAV.map((item) => (
            <a
              key={item.path}
              href={`#${item.path}`}
              className={path === item.path || path.startsWith(`${item.path}/`) ? 'active' : ''}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <span className="crumbs">{crumb}</span>
        <span className="spacer" />
        <span className="kind-chip">session debugger</span>
      </header>
      <main className="app-main">{view}</main>
      <footer className="app-footer">
        <span>local session debugger · localhost only · {VERSION}</span>
        <span>evidence: OBSERVED / DECLARED / INFERRED</span>
      </footer>
    </div>
  )
}
