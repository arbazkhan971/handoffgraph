// Virtualized span tree + waterfall timeline.
//
// The tree (left column) and the waterfall bars (right column) share one
// virtualized row list: only the visible window of rows is mounted, so a
// trace with tens of thousands of spans still scrolls smoothly. Every bar is
// positioned as a percentage of the trace window computed in tree.ts, so all
// bars align to the trace start; overlaps between spans and idle gaps are
// visible as-is. Dynamic positions are applied through React's style prop
// (CSSOM writes), which is not blocked by the strict CSP.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Span, Trace } from '../types'
import { barGeometry, flattenTree, rulerTicks, waterfallWindow } from '../tree'
import { formatDuration, formatTime, shortID } from '../format'
import { evidenceClass } from '../evidence'

const ROW_H = 30
const OVERSCAN = 8
const TICK_COUNT = 7

interface SpanWaterfallProps {
  trace: Trace
  spans: Span[]
  selectedID: string | null
  onSelect: (span: Span) => void
}

export function SpanWaterfall({ trace, spans, selectedID, onSelect }: SpanWaterfallProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(400)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Track the scroll viewport height so the visible row window is correct
  // on mount and on resize.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => setViewportH(el.clientHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const rows = useMemo(() => flattenTree(spans, collapsed), [spans, collapsed])
  const win = useMemo(
    () => waterfallWindow(trace.started_at_ns, trace.ended_at_ns, spans),
    [trace.started_at_ns, trace.ended_at_ns, spans],
  )
  const ticks = useMemo(() => rulerTicks(win, TICK_COUNT), [win])

  const total = rows.length
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const last = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN)
  const visible = rows.slice(first, last)

  const toggle = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="detail-main">
      <div className="wf-header">
        <div className="label-col">
          <span>
            {total} span{total === 1 ? '' : 's'}
            {collapsed.size > 0 ? ` · ${collapsed.size} collapsed` : ''}
          </span>
        </div>
        <div className="timeline-col">
          <span>timeline · aligned to trace start {formatTime(trace.started_at_ns)}</span>
          <div className="wf-ruler">
            {ticks.map((ms, i) => (
              <div
                key={i}
                className="wf-tick"
                style={{ left: `${(i / (TICK_COUNT - 1)) * 100}%` }}
              >
                {i > 0 && <span>+{formatDuration(ms * 1_000_000)}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div
        className="wf-scroll"
        ref={scrollRef}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        {total === 0 ? (
          <div className="state">
            <div className="title">No spans</div>
            <div className="hint">This trace has no materialized spans.</div>
          </div>
        ) : (
          <div className="wf-viewport" style={{ height: total * ROW_H }}>
            {visible.map((row, i) => {
              const idx = first + i
              const sp = row.span
              const geo = barGeometry(sp, win)
              const selected = sp.span_id === selectedID
              return (
                <div
                  key={sp.span_id}
                  className={`wf-row${selected ? ' selected' : ''}`}
                  style={{ top: idx * ROW_H, height: ROW_H }}
                >
                  <div
                    className="label-col wf-label"
                    style={{ paddingLeft: 8 + row.depth * 14 }}
                    onClick={() => onSelect(sp)}
                  >
                    <button
                      type="button"
                      className={`wf-toggle${row.hasChildren ? '' : ' leaf'}`}
                      aria-label={
                        row.collapsed ? `Expand ${sp.name}` : `Collapse ${sp.name}`
                      }
                      aria-expanded={row.hasChildren && !row.collapsed}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggle(sp.span_id)
                      }}
                    >
                      {row.hasChildren ? (row.collapsed ? '▸' : '▾') : '·'}
                    </button>
                    <span className="wf-name" title={`${sp.kind} · ${sp.span_id}`}>
                      {sp.status === 'error' || sp.status === 'failed' ? (
                        <span className="errmark">✖ </span>
                      ) : geo.open ? (
                        <span className="openmark">◌ </span>
                      ) : null}
                      {sp.name}
                      {sp.exit_code != null ? ` (exit ${sp.exit_code})` : ''}
                      {row.hasChildren && row.collapsed ? ' …' : ''}
                    </span>
                    <span className="kind-chip">{sp.kind}</span>
                  </div>
                  <div className="wf-timeline">
                    <div
                      className={`wf-bar status-${sp.status} ${evidenceClass(sp.evidence_level)}`}
                      style={{ left: `${geo.leftPct}%`, width: `${geo.widthPct}%` }}
                      title={`${sp.name} · ${formatDuration(
                        (sp.ended_at_ns ?? win.endNS) - sp.started_at_ns,
                      )} · ${sp.evidence_level ?? 'UNLABELED'} · ${shortID(sp.span_id)}`}
                      onClick={() => onSelect(sp)}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
