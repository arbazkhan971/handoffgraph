import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchDatasets,
  fetchExperimentCompare,
  fetchExperiments,
  fetchPromptBody,
  fetchPrompts,
  fetchScores,
  fetchTraceDetail,
  fetchTraces,
  fetchVersion,
  fetchWorkstreams,
} from './api'
import {
  MOCK_VERSION,
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('local debugger API client', () => {
  it('unwraps the cursor envelope returned by /api/workstreams', async () => {
    const workstreams = mockWorkstreams().slice(0, 1)
    const fetchMock = vi.fn(async () => json({ items: workstreams, next_cursor: '' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchWorkstreams()).resolves.toEqual({ data: workstreams, source: 'live' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workstreams',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    )
  })

  it('unwraps trace lists and URL-encodes the workstream filter', async () => {
    const traces = mockTraces().slice(0, 1)
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      json({ items: traces, next_cursor: 'trc_next' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchTraces('ws_one/two')).resolves.toEqual({ data: traces, source: 'live' })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/traces?workstream=ws_one%2Ftwo')
  })

  it('combines the plain trace detail and span-list envelope', async () => {
    const trace = mockTraces()[0]
    const spans = mockSpans(trace.trace_id)
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input).startsWith('/api/traces/')
        ? json(trace)
        : json({ items: spans, next_cursor: '' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchTraceDetail(trace.trace_id)).resolves.toEqual({
      data: { trace, spans },
      source: 'live',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('treats a 404 span page for a known trace as an empty live list', async () => {
    const trace = mockTraces()[0]
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(trace))
      .mockResolvedValueOnce(json({ error: 'trace not found' }, 404))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchTraceDetail(trace.trace_id)).resolves.toEqual({
      data: { trace, spans: [] },
      source: 'live',
    })
  })

  it('falls back as one coherent snapshot when the API is unreachable', async () => {
    const trace = mockTraces()[0]
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchTraceDetail(trace.trace_id)).resolves.toEqual({
      data: { trace: mockTrace(trace.trace_id), spans: mockSpans(trace.trace_id) },
      source: 'mock',
    })
  })

  it('returns a live not-found result and surfaces reachable server errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'trace not found' }, 404)))
    await expect(fetchTraceDetail('trc_missing')).resolves.toEqual({ data: null, source: 'live' })

    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'read failed' }, 500)))
    await expect(fetchWorkstreams()).rejects.toThrow('/api/workstreams: HTTP 500')
  })
})

describe('evaluation-surface API client', () => {
  const listCases: { name: string; path: string; call: () => Promise<unknown>; items: unknown[] }[] = [
    { name: 'scores', path: '/api/scores', call: () => fetchScores(), items: mockScores() },
    { name: 'datasets', path: '/api/datasets', call: () => fetchDatasets(), items: mockDatasets() },
    {
      name: 'experiments',
      path: '/api/experiments',
      call: () => fetchExperiments(),
      items: mockExperiments(),
    },
    { name: 'prompts', path: '/api/prompts', call: () => fetchPrompts(), items: mockPrompts() },
  ]

  it.each(listCases)('unwraps the $name envelope', async ({ path, call, items }) => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => json({ items, next_cursor: '' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(call()).resolves.toEqual({ data: items, source: 'live' })
    expect(fetchMock.mock.calls[0]?.[0]).toBe(path)
  })

  it.each([
    ['both filters', { workstream: 'ws_1', target: 'trc_1' }, '/api/scores?workstream=ws_1&target=trc_1'],
    ['workstream only', { workstream: 'ws_1' }, '/api/scores?workstream=ws_1'],
    ['target only', { target: 'spn_a/b' }, '/api/scores?target=spn_a%2Fb'],
    ['no filters', {}, '/api/scores'],
  ])('builds the score request path with %s', async (_name, filter, want) => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => json({ items: [], next_cursor: '' }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchScores(filter)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(want)
  })

  it('filters mock scores the same way the server filters live ones', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    const target = mockScores()[0].target_id
    await expect(fetchScores({ target })).resolves.toEqual({
      data: mockScores().filter((s) => s.target_id === target),
      source: 'mock',
    })
    await expect(fetchExperiments('handoff-golden')).resolves.toEqual({
      data: mockExperiments().filter((r) => r.dataset === 'handoff-golden'),
      source: 'mock',
    })
  })

  it('fetches a run comparison and falls back to the derived mock diff', async () => {
    const compare = mockExperimentCompare('evt_01J2MOCKEXPERIMENT01', 'evt_01J2MOCKEXPERIMENT02')
    const fetchMock = vi.fn(async (_input: string | URL | Request) => json(compare))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchExperimentCompare('a1', 'b2')).resolves.toEqual({ data: compare, source: 'live' })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/experiments/compare?a=a1&b=b2')

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    await expect(
      fetchExperimentCompare('evt_01J2MOCKEXPERIMENT01', 'evt_01J2MOCKEXPERIMENT02'),
    ).resolves.toEqual({ data: compare, source: 'mock' })
  })

  it.each([
    ['pinned version', 'triage', 2, '/api/prompts/show?name=triage&version=2'],
    ['latest by default', 'triage', undefined, '/api/prompts/show?name=triage'],
    ['encodes the name', 'a/b', undefined, '/api/prompts/show?name=a%2Fb'],
  ])('requests a prompt body: %s', async (_name, prompt, version, want) => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => json(mockPromptBody('triage', 2)))
    vi.stubGlobal('fetch', fetchMock)

    await fetchPromptBody(prompt as string, version as number | undefined)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(want)
  })

  it('treats 404 on an object endpoint as a live "not here" answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'prompt not found' }, 404)))
    await expect(fetchPromptBody('ghost')).resolves.toEqual({ data: null, source: 'live' })
    await expect(fetchExperimentCompare('a', 'b')).resolves.toEqual({ data: null, source: 'live' })

    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'read failed' }, 500)))
    await expect(fetchPromptBody('triage')).rejects.toThrow('HTTP 500')
    await expect(fetchScores()).rejects.toThrow('/api/scores: HTTP 500')
  })
})

describe('fetchVersion', () => {
  it('reports the version the binary serves', async () => {
    const fetchMock = vi.fn(async () => json({ version: 'v1.2.3' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchVersion()).resolves.toEqual({ data: { version: 'v1.2.3' }, source: 'live' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/version',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    )
  })

  it('reports the development build as the binary spells it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ version: 'dev' })))
    await expect(fetchVersion()).resolves.toEqual({ data: { version: 'dev' }, source: 'live' })
  })

  it('falls back to the bundled version when no server answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    await expect(fetchVersion()).resolves.toEqual({ data: mockVersion(), source: 'mock' })
  })

  it('falls back rather than erroring on a server failure — the footer is cosmetic', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'boom' }, 500)))
    await expect(fetchVersion()).resolves.toEqual({ data: mockVersion(), source: 'mock' })
  })

  it('falls back on a malformed or empty version payload', async () => {
    for (const body of [{}, { version: '' }, { version: 42 }, null]) {
      vi.stubGlobal('fetch', vi.fn(async () => json(body)))
      await expect(fetchVersion()).resolves.toEqual({ data: mockVersion(), source: 'mock' })
    }
  })

  it('uses the same fallback literal the footer shows in dev', () => {
    expect(mockVersion()).toEqual({ version: MOCK_VERSION })
    expect(MOCK_VERSION).toMatch(/^v\d+\.\d+\.\d+/)
  })
})
