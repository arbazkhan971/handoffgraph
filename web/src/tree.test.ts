// Table-driven tests for the span tree flattening and waterfall geometry.

import { describe, expect, it } from 'vitest'
import type { Span } from './types'
import {
  barGeometry,
  buildChildren,
  flattenTree,
  rootSpans,
  rulerTicks,
  waterfallWindow,
} from './tree'

const span = (id: string, parent: string, seq = 0, started = 0, ended?: number): Span => ({
  span_id: id,
  trace_id: 'trc_test',
  parent_span_id: parent || undefined,
  kind: 'OTHER',
  name: id,
  status: 'ok',
  started_at_ns: started,
  ended_at_ns: ended,
  sequence: seq,
})

describe('buildChildren / rootSpans', () => {
  it('groups children under parents and treats unknown parents as roots', () => {
    // a -> b -> c, plus d whose parent is missing from the set.
    const spans = [span('a', ''), span('b', 'a'), span('c', 'b'), span('d', 'ghost')]
    const children = buildChildren(spans)
    expect(children.get('a')).toEqual([spans[1]])
    expect(children.get('b')).toEqual([spans[2]])
    expect(children.has('c')).toBe(false)
    expect(children.has('ghost')).toBe(false)
    expect(rootSpans(spans).map((s) => s.span_id)).toEqual(['a', 'd'])
  })
})

describe('flattenTree', () => {
  const spans = [
    span('a', '', 0),
    span('b', 'a', 1),
    span('c', 'b', 2),
    span('d', 'a', 3),
    span('e', '', 4),
  ]

  it('walks the tree depth-first in materializer order', () => {
    const rows = flattenTree(spans, new Set())
    expect(rows.map((r) => [r.span.span_id, r.depth, r.hasChildren])).toEqual([
      ['a', 0, true],
      ['b', 1, true],
      ['c', 2, false],
      ['d', 1, false],
      ['e', 0, false],
    ])
  })

  it('hides the subtree of a collapsed span but keeps the row', () => {
    const rows = flattenTree(spans, new Set(['b']))
    expect(rows.map((r) => [r.span.span_id, r.depth, r.collapsed])).toEqual([
      ['a', 0, false],
      ['b', 1, true], // collapsed: c hidden
      ['d', 1, false],
      ['e', 0, false],
    ])
  })

  it('shows only the collapsed root subtree when a root is collapsed', () => {
    const rows = flattenTree(spans, new Set(['a']))
    expect(rows.map((r) => r.span.span_id)).toEqual(['a', 'e'])
  })

  it('is deterministic: identical inputs flatten identically', () => {
    const r1 = flattenTree(spans, new Set())
    const r2 = flattenTree([...spans], new Set())
    expect(r1).toEqual(r2)
  })
})

describe('waterfallWindow', () => {
  const MS = 1_000_000

  it('uses the trace end when present', () => {
    const win = waterfallWindow(0, 10 * MS, [])
    expect(win).toEqual({ startNS: 0, endNS: 10 * MS, totalNS: 10 * MS })
  })

  it('extends to the latest span end when the trace is still open', () => {
    const spans = [span('a', '', 0, 0, 5 * MS), span('b', 'a', 1, 2 * MS, 42 * MS)]
    const win = waterfallWindow(0, undefined, spans)
    expect(win.totalNS).toBe(42 * MS)
  })

  it('falls back to a 1ms sliver when nothing has ended', () => {
    const win = waterfallWindow(7 * MS, undefined, [span('a', '', 0, 7 * MS, undefined)])
    expect(win).toEqual({ startNS: 7 * MS, endNS: 8 * MS, totalNS: MS })
  })
})

describe('barGeometry', () => {
  const MS = 1_000_000
  const win = waterfallWindow(0, 100 * MS, [])

  it.each([
    // [start, end, wantLeft%, approxWantWidth%, open]
    [0, 100 * MS, 0, 100, false], // whole window
    [25 * MS, 50 * MS, 25, 25, false], // middle quarter
    [0, 10 * MS, 0, 10, false], // leading tenth
    [90 * MS, 100 * MS, 90, 10, false], // trailing tenth
  ])('positions %d..%d ns at left %d%%, width %d%%', (start, end, wantLeft, wantWidth, wantOpen) => {
    const geo = barGeometry(span('x', '', 0, start, end), win)
    expect(geo.leftPct).toBeCloseTo(wantLeft, 5)
    expect(geo.widthPct).toBeCloseTo(wantWidth, 5)
    expect(geo.open).toBe(wantOpen)
  })

  it('marks open spans and runs them to the window end', () => {
    const geo = barGeometry(span('x', '', 0, 40 * MS, undefined), win)
    expect(geo.open).toBe(true)
    expect(geo.leftPct).toBeCloseTo(40, 5)
    expect(geo.widthPct).toBeCloseTo(60, 5)
  })

  it('clamps bars that overrun the window', () => {
    const geo = barGeometry(span('x', '', 0, 90 * MS, 500 * MS), win)
    expect(geo.leftPct).toBe(90)
    expect(geo.leftPct + geo.widthPct).toBeLessThanOrEqual(100.001)
  })

  it('keeps zero-duration spans minimally visible', () => {
    const geo = barGeometry(span('x', '', 0, 50 * MS, 50 * MS), win)
    expect(geo.leftPct).toBeCloseTo(50, 5)
    expect(geo.widthPct).toBeGreaterThan(0)
  })
})

describe('rulerTicks', () => {
  const MS = 1_000_000

  it('spreads ticks evenly in ms', () => {
    const win = waterfallWindow(0, 100 * MS, [])
    expect(rulerTicks(win, 5)).toEqual([0, 25, 50, 75, 100])
  })

  it('degenerates to a single tick at zero', () => {
    expect(rulerTicks(waterfallWindow(0, 10 * MS, []), 1)).toEqual([0])
  })
})
