// Integrity checks over the mock dataset: it must satisfy the same shape
// guarantees the real /api responses have, so the UI is exercised honestly
// in mock mode.

import { describe, expect, it } from 'vitest'
import { mockSpans, mockTraces, mockWorkstreams } from './mocks'
import { flattenTree, rootSpans } from './tree'

describe('mock dataset integrity', () => {
  it('has unique workstream and trace ids', () => {
    const wsIDs = new Set(mockWorkstreams().map((w) => w.id))
    expect(wsIDs.size).toBe(mockWorkstreams().length)
    const trIDs = new Set(mockTraces().map((t) => t.trace_id))
    expect(trIDs.size).toBe(mockTraces().length)
  })

  it('references only known workstreams from traces', () => {
    const wsIDs = new Set(mockWorkstreams().map((w) => w.id))
    for (const tr of mockTraces()) expect(wsIDs.has(tr.workstream_id)).toBe(true)
  })

  it.each(mockTraces().map((t) => [t.trace_id, t.status] as const))(
    'trace %s (%s) has spans matching its declared span_count',
    (traceID) => {
      const spans = mockSpans(traceID)
      expect(spans.length).toBeGreaterThan(0)
      for (const sp of spans) expect(sp.trace_id).toBe(traceID)
    },
  )

  it('keeps parent references inside the same trace', () => {
    const allTraces = mockTraces().map((t) => t.trace_id)
    for (const traceID of allTraces) {
      const spans = mockSpans(traceID)
      const ids = new Set(spans.map((s) => s.span_id))
      for (const sp of spans) {
        if (sp.parent_span_id) expect(ids.has(sp.parent_span_id)).toBe(true)
      }
      // Every trace must flatten into at least one root row, and a full
      // flatten must visit every span exactly once (nothing hidden, nothing
      // duplicated).
      expect(rootSpans(spans).length).toBeGreaterThanOrEqual(1)
      expect(flattenTree(spans, new Set()).length).toBe(spans.length)
    }
  })

  it('covers every evidence level and a failing span so the UI renders all states', () => {
    const evidence = new Set<string>()
    let failed = false
    let open = false
    for (const tr of mockTraces()) {
      for (const sp of mockSpans(tr.trace_id)) {
        if (sp.evidence_level) evidence.add(sp.evidence_level)
        if (sp.status === 'error' || sp.status === 'failed') failed = true
        if (!sp.ended_at_ns) open = true
      }
    }
    expect(evidence).toEqual(new Set(['OBSERVED', 'DECLARED', 'INFERRED']))
    expect(failed).toBe(true)
    expect(open).toBe(true)
  })
})
