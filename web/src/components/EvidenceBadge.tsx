import type { EvidenceLevel } from '../types'
import { evidenceClass } from '../evidence'

// Evidence provenance is a first-class visual: OBSERVED (solid green),
// DECLARED (dashed blue), INFERRED (dotted amber, italic). An inferred
// value must never look like an observed one.

export function EvidenceBadge({ level }: { level: EvidenceLevel | undefined }) {
  const cls = evidenceClass(level)
  const label = level ?? 'UNLABELED'
  return (
    <span className={`evidence ${cls}`} title={`Provenance: ${label}`}>
      {label}
    </span>
  )
}

/** Provenance label for cost figures — a cost is never shown without it. */
export function CostProvenanceNote({ provenance }: { provenance: string | undefined }) {
  if (!provenance) return null
  return <span className="kind-chip">cost: {provenance}</span>
}
