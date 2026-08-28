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

// ---- Scores (hfg.score.v1, /api/scores) ----

/** Which value slot a score carries. */
export type ScoreDataType = 'NUMERIC' | 'CATEGORY' | 'BOOLEAN'

/** The spine object a score is attached to. */
export type ScoreTargetType = 'trace' | 'span' | 'session' | 'checkpoint' | 'workstream'

/** Who produced the score — human judgment vs machine evaluation. */
export type ScoreSource = 'human' | 'api' | 'evaluation' | 'detection'

/**
 * One recorded score. Exactly one of value / string_value / bool_value is
 * set, selected by data_type.
 *
 * Unlike the trace and span models, `occurred_at` is an RFC3339 timestamp
 * string (Go serializes time.Time), not nanoseconds since the epoch.
 * `provenance` is the event-envelope evidence level: an LLM-judge score
 * arrives INFERRED and must never render like an OBSERVED measurement.
 */
export interface Score {
  schema_version: string
  score_id: string
  workstream_id?: string
  occurred_at: string
  name: string
  data_type: ScoreDataType
  value?: number
  string_value?: string
  bool_value?: boolean
  target_type: ScoreTargetType
  target_id: string
  source: ScoreSource
  provenance?: EvidenceLevel
  comment?: string
}

// ---- Datasets & experiments (/api/datasets, /api/experiments) ----

/**
 * One immutable dataset version. Datasets are content-addressed: `version`
 * and `content_hash` are the same manifest hash, surfaced under both names
 * so identity and integrity can be labeled separately.
 */
export interface DatasetVersion {
  event_id: string
  name: string
  version: string
  example_count: number
  content_hash: string
  created_at: string
}

/** Per-example verdict of the deterministic experiment task. */
export type ExampleStatus = 'ok' | 'detections' | 'invalid'

/** One recorded experiment run over a pinned dataset version. */
export interface ExperimentRun {
  id: string
  dataset: string
  version: string
  passed: boolean
  passed_count: number
  failed_count: number
  example_count: number
  created_at: string
}

/** One example's before/after verdict in a run comparison. */
export interface ExperimentComparison {
  file: string
  from_status: ExampleStatus
  to_status: ExampleStatus
  from_p0: number
  to_p0: number
  regression: boolean
}

/**
 * The regression diff between two runs (a = baseline, b = candidate). Only
 * examples present in both runs appear: an example that exists on one side
 * only is a different dataset version, not a regression.
 */
export interface ExperimentCompare {
  a: ExperimentRun
  b: ExperimentRun
  regressions: number
  items: ExperimentComparison[]
}

// ---- Prompts (/api/prompts, /api/prompts/show) ----

/** A label pointer: `production`, `latest`, or any custom label. */
export interface PromptLabel {
  label: string
  version: number
}

/** One immutable prompt version without its body. */
export interface PromptVersionRef {
  version: number
  hash: string
  created_at: string
  created_by?: string
}

export interface Prompt {
  name: string
  version_count: number
  latest_version: number
  latest_hash: string
  latest_created_at: string
  labels: PromptLabel[]
  versions: PromptVersionRef[]
}

/** One prompt version with its body (size-capped when it was created). */
export interface PromptBody {
  name: string
  version: number
  body: string
  hash: string
  created_at: string
  created_by?: string
  labels: string[]
  latest_version: number
  version_count: number
}

/** Cursor-friendly list envelope used by every list endpoint. */
export interface Envelope<T> {
  items: T[]
  next_cursor: string
}

/** Where the data shown in a view came from. */
export type DataSource = 'live' | 'mock'
