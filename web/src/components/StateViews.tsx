import type { ReactNode } from 'react'
import type { DataSource } from '../types'

// Graceful loading / error / empty states shared by every view.

export function LoadingView({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  )
}

export function ErrorView({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state" role="alert">
      <div className="title">Something went wrong</div>
      <div className="hint">{message}</div>
      {onRetry && (
        <button className="retry-btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  )
}

export function EmptyView({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="state">
      <div className="title">{title}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  )
}

/** Badge shown whenever a view is rendering mock rather than live data. */
export function DataSourceBadge({ source }: { source: DataSource }) {
  if (source !== 'mock') return null
  return (
    <span className="mock-banner" title="API unreachable — showing deterministic mock data">
      MOCK DATA
    </span>
  )
}
