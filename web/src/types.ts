// API models mirroring the JSON served by internal/webui (hfg.trace.v1
// read models plus the /api/workstreams envelope). Timestamps are
// nanoseconds since the Unix epoch; durations are nanoseconds.

export interface Workstream {
  id: string
  title: string
  status: string
  created_at: string
  event_count: number
  trace_count: number
}

export interface Trace {
  schema_version: string
  trace_id: string
  workstream_id: string
  session_id: string
  native_turn_id?: string
  provider?: string
  objective_excerpt?: string
  status: TraceStatus
  started_at_ns: number
  ended_at_ns?: number
  duration_ns?: number
  span_count: number
  failed_span_count: number
  changed_file_count: number
  verification_state: VerificationState
  root_span_id?: string
  token_input?: number
  token_output?: number
  token_cache_read?: number
  token_cache_write?: number
  cost_amount?: string
  cost_currency?: string
  cost_provenance?: string
  content_policy?: string
}

export interface Span {
  span_id: string
  trace_id: string
  session_id?: string
  parent_span_id?: string
  source_trace_id?: string
  source_span_id?: string
  kind: SpanKind
  source_kind?: string
  name: string
  status: SpanStatus
  started_at_ns: number
  ended_at_ns?: number
  sequence: number
  provider?: string
  model?: string
  tool_name?: string
  command_fingerprint?: string
  file_identity_hash?: string
  exit_code?: number | null
  input_object_hash?: string
  output_object_hash?: string
  attributes_object_hash?: string
  error_object_hash?: string
  evidence_level?: EvidenceLevel
  normalizer_version?: string
  source_schema_version?: string
}

export type TraceStatus =
  | 'RUNNING'
  | 'OK'
  | 'ERROR'
  | 'CANCELLED'
  | 'INTERRUPTED'
  | 'COMPACTED'
  | 'ABANDONED'
  | 'UNKNOWN'

export type VerificationState = 'verified' | 'failed' | 'missing' | 'unknown'

export type SpanStatus = 'ok' | 'error' | 'running' | 'unknown' | 'failed'

export type SpanKind =
  | 'WORKFLOW'
  | 'AGENT'
  | 'MODEL'
  | 'TOOL'
  | 'MCP_CLIENT'
  | 'MCP_SERVER'
  | 'COMMAND'
  | 'FILE_READ'
  | 'FILE_WRITE'
  | 'GIT'
  | 'TEST'
  | 'BUILD'
  | 'RETRIEVAL'
  | 'GUARDRAIL'
  | 'LOG'
  | 'OTHER'

// OBSERVED = captured directly (hook/tool/git/command); DECLARED = asserted
// by user or agent; INFERRED = produced by a heuristic or model. The UI must
// always render these distinctly — an inferred value must never look like an
// observed one.
export type EvidenceLevel = 'OBSERVED' | 'DECLARED' | 'INFERRED'

/** Cursor-friendly list envelope used by every list endpoint. */
export interface Envelope<T> {
  items: T[]
  next_cursor: string
}

/** Where the data shown in a view came from. */
export type DataSource = 'live' | 'mock'
