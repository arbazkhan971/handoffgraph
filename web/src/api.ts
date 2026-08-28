// API client. All requests go to same-origin /api endpoints served by
// internal/webui (the `handoffgraph open` command). When the backend is not
// reachable — e.g. running `npm run dev` with no Go server — every call
// falls back to deterministic mock data and reports `source: 'mock'` so the
// UI can label what it is showing. Mock fallback never mixes with live data
// for a single fetch.

import type {
  DataSource,
  DatasetVersion,
  Envelope,
  ExperimentCompare,
  ExperimentRun,
  Prompt,
  PromptBody,
  Score,
  Span,
  Trace,
  VersionInfo,
  Workstream,
} from './types'
import {
  mockDatasets,
  mockExperimentCompare,
  mockExperiments,
  mockPromptBody,
  mockPrompts,
  mockScores,
  mockSpans,
  mockTrace,
  mockTraces,
  mockVersion,
  mockWorkstreams,
} from './mocks'

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

/**
 * Fetches a single object (not a list envelope). A live 404 is a real
 * answer — "no such thing here" — and resolves to null rather than throwing,
 * matching the trace-detail contract.
 */
async function fetchObject<T>(path: string, fallback: () => T | null): Promise<Loaded<T | null>> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FALLBACK_TIMEOUT_MS)
  try {
    return { data: await getJSON<T>(path, ctrl.signal), source: 'live' }
  } catch (error) {
    if (error instanceof APIResponseError) {
      if (error.status === 404) return { data: null, source: 'live' }
      throw error
    }
    return { data: fallback(), source: 'mock' }
  } finally {
    clearTimeout(timer)
  }
}

/** Builds `path?k=v` with the empty filters dropped. */
function withQuery(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value)
  }
  const encoded = query.toString()
  return encoded ? `${path}?${encoded}` : path
}

/**
 * The version of the binary serving this UI. Unlike every other call here, a
 * server error is not worth surfacing: the footer falls back to the bundled
 * version rather than turning a cosmetic label into an error state, so any
 * failure — unreachable, timeout, or a 5xx — resolves as `source: 'mock'`.
 */
export async function fetchVersion(): Promise<Loaded<VersionInfo>> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FALLBACK_TIMEOUT_MS)
  try {
    const data = await getJSON<VersionInfo>('/api/version', ctrl.signal)
    if (typeof data?.version !== 'string' || data.version === '') {
      return { data: mockVersion(), source: 'mock' }
    }
    return { data, source: 'live' }
  } catch {
    return { data: mockVersion(), source: 'mock' }
  } finally {
    clearTimeout(timer)
  }
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

// ---- evaluation surfaces: scores, datasets/experiments, prompts ----

export interface ScoreFilter {
  workstream?: string
  target?: string
}

export function fetchScores(filter: ScoreFilter = {}): Promise<Loaded<Score[]>> {
  const path = withQuery('/api/scores', { workstream: filter.workstream, target: filter.target })
  return fetchList(path, () =>
    mockScores().filter(
      (s) =>
        (!filter.workstream || s.workstream_id === filter.workstream) &&
        (!filter.target || s.target_id === filter.target),
    ),
  )
}

export function fetchDatasets(): Promise<Loaded<DatasetVersion[]>> {
  return fetchList('/api/datasets', mockDatasets)
}

export function fetchExperiments(dataset?: string): Promise<Loaded<ExperimentRun[]>> {
  return fetchList(withQuery('/api/experiments', { dataset }), () =>
    dataset ? mockExperiments().filter((r) => r.dataset === dataset) : mockExperiments(),
  )
}

export function fetchExperimentCompare(a: string, b: string): Promise<Loaded<ExperimentCompare | null>> {
  return fetchObject<ExperimentCompare>(withQuery('/api/experiments/compare', { a, b }), () =>
    mockExperimentCompare(a, b),
  )
}

export function fetchPrompts(): Promise<Loaded<Prompt[]>> {
  return fetchList('/api/prompts', mockPrompts)
}

export function fetchPromptBody(name: string, version?: number): Promise<Loaded<PromptBody | null>> {
  const path = withQuery('/api/prompts/show', {
    name,
    version: version === undefined ? undefined : String(version),
  })
  return fetchObject<PromptBody>(path, () => mockPromptBody(name, version))
}
