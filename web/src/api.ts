// API client. All requests go to same-origin /api endpoints served by
// internal/webui (the `handoffgraph open` command). When the backend is not
// reachable — e.g. running `npm run dev` with no Go server — every call
// falls back to deterministic mock data and reports `source: 'mock'` so the
// UI can label what it is showing. Mock fallback never mixes with live data
// for a single fetch.

import type { DataSource, Span, Trace, Workstream } from './types'
import { mockSpans, mockTrace, mockTraces, mockWorkstreams } from './mocks'

export interface Loaded<T> {
  data: T
  source: DataSource
}

async function getJSON<T>(path: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' }, signal })
  if (!res.ok) {
    throw new Error(`${path}: HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

// A request that hangs (server accepting connections but not answering)
// should fall back to mock data quickly rather than blocking the view.
const FALLBACK_TIMEOUT_MS = 4000

async function getJSONWithFallback<T>(path: string, fallback: () => T): Promise<Loaded<T>> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FALLBACK_TIMEOUT_MS)
  try {
    return { data: await getJSON<T>(path, ctrl.signal), source: 'live' }
  } catch {
    return { data: fallback(), source: 'mock' }
  } finally {
    clearTimeout(timer)
  }
}

export function fetchWorkstreams(): Promise<Loaded<Workstream[]>> {
  return getJSONWithFallback<Workstream[]>('/api/workstreams', mockWorkstreams)
}

export function fetchTraces(workstreamID?: string): Promise<Loaded<Trace[]>> {
  const path = workstreamID ? `/api/traces?workstream=${encodeURIComponent(workstreamID)}` : '/api/traces'
  return getJSONWithFallback<Trace[]>(path, () =>
    workstreamID ? mockTraces().filter((t) => t.workstream_id === workstreamID) : mockTraces(),
  )
}

export interface TraceDetail {
  trace: Trace
  spans: Span[]
}

export async function fetchTraceDetail(traceID: string): Promise<Loaded<TraceDetail | null>> {
  const loaded = await getJSONWithFallback<TraceDetail | null>(
    `/api/traces/${encodeURIComponent(traceID)}`,
    () => {
      const trace = mockTrace(traceID)
      return trace ? { trace, spans: mockSpans(traceID) } : null
    },
  )
  if (loaded.source !== 'live' || loaded.data === null) return loaded
  // Live path: fetch spans separately with the same fallback rules.
  const spans = await getJSONWithFallback<Span[]>(
    `/api/spans?trace=${encodeURIComponent(traceID)}`,
    () => [],
  )
  return { data: { trace: loaded.data.trace, spans: spans.data }, source: loaded.source }
}
