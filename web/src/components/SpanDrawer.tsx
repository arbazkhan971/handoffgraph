// Span detail drawer: everything materialized about one span, with its
// evidence level rendered distinctly (OBSERVED / DECLARED / INFERRED).

import type { Span } from '../types'
import { formatDuration, formatTime, shortID } from '../format'
import { EvidenceBadge } from './EvidenceBadge'
import { KindChip, SpanStatusChip } from './StatusChip'

export function SpanDrawer({ span }: { span: Span | null }) {
  if (!span) {
    return (
      <aside className="drawer" aria-label="Span details">
        <h3>No span selected</h3>
        <div className="drawer-sub">Select a row or bar in the waterfall.</div>
      </aside>
    )
  }

  const duration =
    span.ended_at_ns && span.ended_at_ns > span.started_at_ns
      ? span.ended_at_ns - span.started_at_ns
      : undefined

  return (
    <aside className="drawer" aria-label="Span details">
      <h3>{span.name}</h3>
      <div className="drawer-sub">
        {shortID(span.span_id, 8)} · {span.kind}
      </div>
      <div className="badges">
        <SpanStatusChip status={span.status} />
        <KindChip kind={span.kind} />
        <EvidenceBadge level={span.evidence_level} />
      </div>
      <table className="kv">
        <tbody>
          <tr>
            <th>kind (source)</th>
            <td>
              {span.kind}
              {span.source_kind ? ` ← ${span.source_kind}` : ''}
            </td>
          </tr>
          <tr>
            <th>status</th>
            <td className={span.status === 'error' || span.status === 'failed' ? 'err' : 'ok'}>
              {span.status}
            </td>
          </tr>
          {span.exit_code !== undefined && span.exit_code !== null && (
            <tr>
              <th>exit code</th>
              <td className={span.exit_code === 0 ? 'ok' : 'err'}>{span.exit_code}</td>
            </tr>
          )}
          <tr>
            <th>started</th>
            <td>
              {formatTime(span.started_at_ns)}
              {span.ended_at_ns && span.ended_at_ns > span.started_at_ns
                ? ` → ${formatTime(span.ended_at_ns)}`
                : ' → (open)'}
            </td>
          </tr>
          <tr>
            <th>duration</th>
            <td>{duration !== undefined ? formatDuration(duration) : '—'}</td>
          </tr>
          <tr>
            <th>parent</th>
            <td>{span.parent_span_id ? shortID(span.parent_span_id, 8) : '— (root)'}</td>
          </tr>
          {span.provider && (
            <tr>
              <th>provider</th>
              <td>{span.provider}</td>
            </tr>
          )}
          {span.model && (
            <tr>
              <th>model</th>
              <td>{span.model}</td>
            </tr>
          )}
          {span.tool_name && (
            <tr>
              <th>tool</th>
              <td>{span.tool_name}</td>
            </tr>
          )}
          {span.command_fingerprint && (
            <tr>
              <th>command fingerprint</th>
              <td>{span.command_fingerprint}</td>
            </tr>
          )}
          {span.file_identity_hash && (
            <tr>
              <th>file identity</th>
              <td>{span.file_identity_hash}</td>
            </tr>
          )}
          <tr>
            <th>sequence</th>
            <td>{span.sequence}</td>
          </tr>
          {span.input_object_hash && (
            <tr>
              <th>input object</th>
              <td>{span.input_object_hash}</td>
            </tr>
          )}
          {span.output_object_hash && (
            <tr>
              <th>output object</th>
              <td>{span.output_object_hash}</td>
            </tr>
          )}
          {span.attributes_object_hash && (
            <tr>
              <th>attributes object</th>
              <td>{span.attributes_object_hash}</td>
            </tr>
          )}
          {span.error_object_hash && (
            <tr>
              <th>error object</th>
              <td>{span.error_object_hash}</td>
            </tr>
          )}
          {span.source_span_id && (
            <tr>
              <th>source span</th>
              <td>{span.source_span_id}</td>
            </tr>
          )}
          {span.normalizer_version && (
            <tr>
              <th>normalizer</th>
              <td>
                {span.normalizer_version}
                {span.source_schema_version ? ` · ${span.source_schema_version}` : ''}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="note">
        Object hashes reference content-addressed bodies; raw payloads are never inlined here.
      </p>
    </aside>
  )
}
