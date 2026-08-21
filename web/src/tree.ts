// Pure span-tree and waterfall geometry logic. The materialized spans from
// /api/spans arrive in a deterministic total order (sequence, started_at_ns,
// span_id); this module turns that flat list into a collapsible tree without
// disturbing the order, so what you see is a pure function of the API
// response.

import type { Span } from './types'

export interface TreeRow {
  span: Span
  /** Nesting depth; roots are 0. */
  depth: number
  /** True when this span has at least one child (so it can be toggled). */
  hasChildren: boolean
  /** True when this row's subtree is collapsed (only meaningful with children). */
  collapsed: boolean
}

/**
 * Builds the parent -> children map. Children keep the input (materializer)
 * order, which is deterministic. Spans whose parent id is not present in the
 * set become roots.
 */
export function buildChildren(spans: Span[]): Map<string, Span[]> {
  const byID = new Set(spans.map((s) => s.span_id))
  const children = new Map<string, Span[]>()
  for (const sp of spans) {
    const parent = sp.parent_span_id ?? ''
    if (parent === '' || !byID.has(parent)) continue
    const list = children.get(parent)
    if (list) list.push(sp)
    else children.set(parent, [sp])
  }
  return children
}

/** Returns the root spans (no parent, or parent not present) in input order. */
export function rootSpans(spans: Span[]): Span[] {
  const byID = new Set(spans.map((s) => s.span_id))
  return spans.filter((sp) => {
    const parent = sp.parent_span_id ?? ''
    return parent === '' || !byID.has(parent)
  })
}

/**
 * Flattens the span tree depth-first into the visible rows, skipping the
 * subtrees of collapsed spans. `collapsedIDs` is the set of span ids the user
 * has collapsed.
 */
export function flattenTree(spans: Span[], collapsedIDs: ReadonlySet<string>): TreeRow[] {
  const children = buildChildren(spans)
  const roots = rootSpans(spans)
  const rows: TreeRow[] = []
  const visit = (sp: Span, depth: number): void => {
    const kids = children.get(sp.span_id) ?? []
    const collapsed = collapsedIDs.has(sp.span_id)
    rows.push({ span: sp, depth, hasChildren: kids.length > 0, collapsed })
    if (collapsed) return
    for (const kid of kids) visit(kid, depth + 1)
  }
  for (const root of roots) visit(root, 0)
  return rows
}

export interface WaterfallWindow {
  /** Trace start in ns (the alignment origin for every bar). */
  startNS: number
  /** Trace end in ns (>= startNS). */
  endNS: number
  /** Total window in ns; guaranteed > 0 so percentages are finite. */
  totalNS: number
}

/**
 * Computes the waterfall time window for a trace. Falls back to the latest
 * span end (or a 1ms sliver) when the trace has no end yet, so RUNNING
 * traces still render.
 */
export function waterfallWindow(
  traceStartNS: number,
  traceEndNS: number | undefined,
  spans: Span[],
): WaterfallWindow {
  let end = traceEndNS ?? 0
  for (const sp of spans) {
    const spEnd = sp.ended_at_ns ?? 0
    if (spEnd > end) end = spEnd
    const spStart = sp.started_at_ns ?? 0
    if (spStart > end) end = spStart
  }
  if (end < traceStartNS) end = traceStartNS
  const total = Math.max(end - traceStartNS, 1_000_000) // >= 1ms
  return { startNS: traceStartNS, endNS: traceStartNS + total, totalNS: total }
}

export interface BarGeometry {
  /** Left offset as a percentage of the timeline width (0..100). */
  leftPct: number
  /** Bar width as a percentage of the timeline width (>= 0). */
  widthPct: number
  /** True when the span never recorded an end (still open). */
  open: boolean
}

/** Positions one span's bar inside the waterfall window. */
export function barGeometry(sp: Span, win: WaterfallWindow): BarGeometry {
  const rel = (sp.started_at_ns - win.startNS) / win.totalNS
  const leftPct = clamp(rel * 100, 0, 100)
  let duration: number
  let open = false
  if (!sp.ended_at_ns || sp.ended_at_ns <= sp.started_at_ns) {
    // Open span: draw it to the current window end so it is visible.
    duration = Math.max(win.endNS - sp.started_at_ns, 0)
    open = true
  } else {
    duration = sp.ended_at_ns - sp.started_at_ns
  }
  const widthPct = clamp((duration / win.totalNS) * 100, 0, 100 - leftPct)
  return { leftPct, widthPct: Math.max(widthPct, leftPct > 0 ? 0.15 : 0), open }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

/**
 * Returns `count` evenly spaced tick offsets (in ms from the window start)
 * for the ruler, e.g. [0, 250, 500] for a 500ms window with 3 ticks.
 */
export function rulerTicks(win: WaterfallWindow, count: number): number[] {
  if (count < 2) return [0]
  const step = win.totalNS / (count - 1)
  const ticks: number[] = []
  for (let i = 0; i < count; i++) ticks.push(Math.round((step * i) / 1_000_000))
  return ticks
}
