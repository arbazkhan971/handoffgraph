// Shared evidence-provenance styling. Kept outside component files so the
// badge component stays the only export of its module (fast refresh) and
// other components (waterfall bars) can reuse the same visual language.

import type { EvidenceLevel } from './types'

/**
 * CSS class for an evidence level:
 * OBSERVED = solid, DECLARED = dashed, INFERRED = dotted.
 * The same class names style both badges and waterfall bars.
 */
export function evidenceClass(level: EvidenceLevel | undefined): string {
  switch (level) {
    case 'OBSERVED':
      return 'evidence-observed'
    case 'DECLARED':
      return 'evidence-declared'
    case 'INFERRED':
      return 'evidence-inferred'
    default:
      return 'evidence-unknown'
  }
}
