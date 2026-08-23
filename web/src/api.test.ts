import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchTraceDetail, fetchTraces, fetchWorkstreams } from './api'
import { mockSpans, mockTrace, mockTraces, mockWorkstreams } from './mocks'

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
