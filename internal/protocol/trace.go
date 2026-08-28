package protocol

// Trace is the materialized read model for a bounded turn trace
// (hfg.trace.v1). Events remain the durable source of truth; this struct is
// derived by the deterministic reducer.
type Trace struct {
	SchemaVersion string `json:"schema_version"`

	TraceID      string `json:"trace_id"`
	WorkstreamID string `json:"workstream_id"`
	SessionID    string `json:"session_id"`
	NativeTurnID string `json:"native_turn_id,omitempty"`
	Provider     string `json:"provider,omitempty"`

	ObjectiveExcerpt string      `json:"objective_excerpt,omitempty"`
	Status           TraceStatus `json:"status"`

	StartedAtNS int64 `json:"started_at_ns"`
	EndedAtNS   int64 `json:"ended_at_ns,omitempty"`
	DurationNS  int64 `json:"duration_ns,omitempty"`

	SpanCount        int64 `json:"span_count"`
	FailedSpanCount  int64 `json:"failed_span_count"`
	ChangedFileCount int64 `json:"changed_file_count"`

	VerificationState VerificationState `json:"verification_state"`

	RootSpanID string `json:"root_span_id,omitempty"`

	// Cost/token fields are only populated when the provider emitted them;
	// the UI must render provenance alongside these values.
	TokenInput      *int64         `json:"token_input,omitempty"`
	TokenOutput     *int64         `json:"token_output,omitempty"`
	TokenCacheRead  *int64         `json:"token_cache_read,omitempty"`
	TokenCacheWrite *int64         `json:"token_cache_write,omitempty"`
	CostAmount      string         `json:"cost_amount,omitempty"` // decimal string, never float
	CostCurrency    string         `json:"cost_currency,omitempty"`
	CostProvenance  CostProvenance `json:"cost_provenance,omitempty"`

	ContentPolicy string `json:"content_policy,omitempty"` // metadata_only | sanitized | full_local | encrypted
}

// Span is the materialized read model for a normalized span. Source
// attributes and large bodies are stored as content-addressed objects and
// referenced here by hash rather than inlined.
type Span struct {
	SpanID       string `json:"span_id"`
	TraceID      string `json:"trace_id"`
	SessionID    string `json:"session_id,omitempty"`
	ParentSpanID string `json:"parent_span_id,omitempty"`

	SourceTraceID string `json:"source_trace_id,omitempty"`
	SourceSpanID  string `json:"source_span_id,omitempty"`

	Kind       SpanKind `json:"kind"`
	SourceKind string   `json:"source_kind,omitempty"`

	Name   string `json:"name"`
	Status string `json:"status"`

	StartedAtNS int64 `json:"started_at_ns"`
	EndedAtNS   int64 `json:"ended_at_ns,omitempty"`
	Sequence    int64 `json:"sequence"`

	Provider string `json:"provider,omitempty"`
	Agent    string `json:"agent,omitempty"`
	Model    string `json:"model,omitempty"`

	ToolName           string `json:"tool_name,omitempty"`
	CommandFingerprint string `json:"command_fingerprint,omitempty"`
	FileIdentityHash   string `json:"file_identity_hash,omitempty"`
	ExitCode           *int   `json:"exit_code,omitempty"`

	InputObjectHash      string `json:"input_object_hash,omitempty"`
	OutputObjectHash     string `json:"output_object_hash,omitempty"`
	AttributesObjectHash string `json:"attributes_object_hash,omitempty"`
	ErrorObjectHash      string `json:"error_object_hash,omitempty"`

	EvidenceLevel       Provenance `json:"evidence_level,omitempty"`
	NormalizerVersion   string     `json:"normalizer_version,omitempty"`
	SourceSchemaVersion string     `json:"source_schema_version,omitempty"`
}
