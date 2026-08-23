// API client. All requests go to same-origin /api endpoints served by
// internal/webui (the `handoffgraph open` command). When the backend is not
// reachable — e.g. running `npm run dev` with no Go server — every call
// falls back to deterministic mock data and reports `source: 'mock'` so the
// UI can label what it is showing. Mock fallback never mixes with live data
// for a single fetch.

import type { DataSource, Envelope, Span, Trace, Workstream } from './types'
import { mockSpans, mockTrace, mockTraces, mockWorkstreams } from './mocks'

export interface Loaded<T> {
  data: T
  source: DataSource
}

class APIResponseError extends Error {
  readonly path: string
  readonly status: number

  constructor(path: string, status: number) {
    super(`${path}: HTTP ${status}`)
    this.name = 'APIResponseError'
    this.path = path
    this.status = status
  }
}

async function getJSON<T>(path: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' }, signal })
  if (!res.ok) {
    throw new APIResponseError(path, res.status)
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
  } catch (error) {
    // A valid HTTP error means the API is reachable and should be surfaced to
    // the error state. Network failures, timeouts, and the Vite dev server's
    // HTML fallback mean there is no usable API, so deterministic mocks are
    // appropriate.
    if (error instanceof APIResponseError) throw error
    return { data: fallback(), source: 'mock' }
  } finally {
    clearTimeout(timer)
  }
}

async function fetchList<T>(path: string, fallback: () => T[]): Promise<Loaded<T[]>> {
  const loaded = await getJSONWithFallback<Envelope<T>>(path, () => ({
    items: fallback(),
    next_cursor: '',
  }))
  if (!Array.isArray(loaded.data.items)) {
    throw new Error(`${path}: invalid list envelope`)
  }
  return { data: loaded.data.items, source: loaded.source }
}

export function fetchWorkstreams(): Promise<Loaded<Workstream[]>> {
  return fetchList('/api/workstreams', mockWorkstreams)
}

export function fetchTraces(workstreamID?: string): Promise<Loaded<Trace[]>> {
  const path = workstreamID ? `/api/traces?workstream=${encodeURIComponent(workstreamID)}` : '/api/traces'
  return fetchList(path, () =>
    workstreamID ? mockTraces().filter((t) => t.workstream_id === workstreamID) : mockTraces(),
  )
}

export interface TraceDetail {
  trace: Trace
  spans: Span[]
}

export async function fetchTraceDetail(traceID: string): Promise<Loaded<TraceDetail | null>> {
  const encodedID = encodeURIComponent(traceID)
  const tracePath = `/api/traces/${encodedID}`
  const spansPath = `/api/spans?trace=${encodedID}`
  const fallback = (): TraceDetail | null => {
    const trace = mockTrace(traceID)
    return trace ? { trace, spans: mockSpans(traceID) } : null
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FALLBACK_TIMEOUT_MS)
  try {
    let trace: Trace
    try {
      trace = await getJSON<Trace>(tracePath, ctrl.signal)
    } catch (error) {
      if (error instanceof APIResponseError && error.status === 404) {
        return { data: null, source: 'live' }
      }
      throw error
    }

    let spans: Span[]
    try {
      const envelope = await getJSON<Envelope<Span>>(spansPath, ctrl.signal)
      if (!Array.isArray(envelope.items)) throw new Error(`${spansPath}: invalid list envelope`)
      spans = envelope.items
    } catch (error) {
      // The local API currently answers 404 for a known trace with no spans.
      // Once the trace lookup succeeded, that response is an empty live list.
      if (error instanceof APIResponseError && error.status === 404) spans = []
      else throw error
    }

    return { data: { trace, spans }, source: 'live' }
  } catch (error) {
    if (error instanceof APIResponseError) throw error
    return { data: fallback(), source: 'mock' }
  } finally {
    clearTimeout(timer)
  }
}
