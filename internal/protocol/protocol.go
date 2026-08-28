// Package protocol defines the versioned HandoffGraph wire contracts.
//
// The contracts in this package are the source of truth for what the CLI
// stores and emits. Event payloads are append-only; readers must preserve
// unknown fields rather than drop them (see event.Unknown).
package protocol

// SchemaVersionEvent is the current append-only event envelope contract.
// Events carry this string in their schema_version field.
const SchemaVersionEvent = "hfg.event.v1"

// SchemaVersionCheckpoint is the current portable checkpoint contract.
const SchemaVersionCheckpoint = "hfg.checkpoint.v1"

// SchemaVersionTrace is the current materialized turn-trace read model.
const SchemaVersionTrace = "hfg.trace.v1"

// Provenance labels the source of a statement or observation.
//
// OBSERVED means the value was captured directly from a hook, tool event,
// Git state or command result. DECLARED means a user or agent asserted it.
// INFERRED means a deterministic heuristic or model produced it. The UI must
// render these distinctly; an inferred summary must never look equivalent to
// an observed passing test.
type Provenance string

const (
	ProvenanceObserved Provenance = "OBSERVED"
	ProvenanceDeclared Provenance = "DECLARED"
	ProvenanceInferred Provenance = "INFERRED"
)

// EventKind is a canonical event kind. Required kinds are enumerated in the
// roadmap; adapters normalize provider-native events into this vocabulary.
type EventKind string

// Well-known event kinds. This list is the stable spine of the workstream
// graph; adapters must not invent kinds that duplicate these.
const (
	EventWorkstreamStarted    EventKind = "workstream.started"
	EventWorkstreamCompleted  EventKind = "workstream.completed"
	EventSessionStarted       EventKind = "session.started"
	EventSessionResumed       EventKind = "session.resumed"
	EventSessionCompacted     EventKind = "session.compacted"
	EventSessionEnded         EventKind = "session.ended"
	EventTraceStarted         EventKind = "trace.started"
	EventTraceCompleted       EventKind = "trace.completed"
	EventTraceInterrupted     EventKind = "trace.interrupted"
	EventSpanStarted          EventKind = "span.started"
	EventSpanCompleted        EventKind = "span.completed"
	EventSpanFailed           EventKind = "span.failed"
	EventLogObserved          EventKind = "log.observed"
	EventPromptSubmitted      EventKind = "prompt.submitted"
	EventAssistantCompleted   EventKind = "assistant.completed"
	EventToolStarted          EventKind = "tool.started"
	EventToolCompleted        EventKind = "tool.completed"
	EventToolFailed           EventKind = "tool.failed"
	EventFileRead             EventKind = "file.read"
	EventFileCreated          EventKind = "file.created"
	EventFileEdited           EventKind = "file.edited"
	EventFileDeleted          EventKind = "file.deleted"
	EventCommandStarted       EventKind = "command.started"
	EventCommandCompleted     EventKind = "command.completed"
	EventTestStarted          EventKind = "test.started"
	EventTestCompleted        EventKind = "test.completed"
	EventDecisionRecorded     EventKind = "decision.recorded"
	EventScoreRecorded        EventKind = "score.recorded"
	EventDatasetCreated       EventKind = "dataset.created"
	EventExperimentRecorded   EventKind = "experiment.recorded"
	EventPromptCreated        EventKind = "prompt.created"
	EventPromptLabeled        EventKind = "prompt.labeled"
	EventErrorObserved        EventKind = "error.observed"
	EventCheckpointCreated    EventKind = "checkpoint.created"
	EventHandoffCreated       EventKind = "handoff.created"
	EventHandoffAccepted      EventKind = "handoff.accepted"
	EventVerificationRecorded EventKind = "verification.recorded"
	EventDetectionMatched     EventKind = "detection.matched"
	EventAnnotationCreated    EventKind = "annotation.created"
	EventVoteRecorded         EventKind = "vote.recorded"
	EventConflictDetected     EventKind = "conflict.detected"
)

// SpanKind is the normalized span kind. The source provider's raw kind is
// always preserved alongside the normalized value.
type SpanKind string

const (
	SpanKindWorkflow  SpanKind = "WORKFLOW"
	SpanKindAgent     SpanKind = "AGENT"
	SpanKindModel     SpanKind = "MODEL"
	SpanKindTool      SpanKind = "TOOL"
	SpanKindMCPClient SpanKind = "MCP_CLIENT"
	SpanKindMCPServer SpanKind = "MCP_SERVER"
	SpanKindCommand   SpanKind = "COMMAND"
	SpanKindFileRead  SpanKind = "FILE_READ"
	SpanKindFileWrite SpanKind = "FILE_WRITE"
	SpanKindGit       SpanKind = "GIT"
	SpanKindTest      SpanKind = "TEST"
	SpanKindBuild     SpanKind = "BUILD"
	SpanKindRetrieval SpanKind = "RETRIEVAL"
	SpanKindGuardrail SpanKind = "GUARDRAIL"
	SpanKindLog       SpanKind = "LOG"
	SpanKindOther     SpanKind = "OTHER"
)

// TraceStatus is the lifecycle status of a turn trace.
type TraceStatus string

const (
	TraceRunning     TraceStatus = "RUNNING"
	TraceOK          TraceStatus = "OK"
	TraceError       TraceStatus = "ERROR"
	TraceCancelled   TraceStatus = "CANCELLED"
	TraceInterrupted TraceStatus = "INTERRUPTED"
	TraceCompacted   TraceStatus = "COMPACTED"
	TraceAbandoned   TraceStatus = "ABANDONED"
	TraceUnknown     TraceStatus = "UNKNOWN"
)

// VerificationState summarizes observed verification for a trace.
type VerificationState string

const (
	VerificationVerified VerificationState = "verified"
	VerificationFailed   VerificationState = "failed"
	VerificationMissing  VerificationState = "missing"
	VerificationUnknown  VerificationState = "unknown"
)

// ContentProvenance labels where a captured body came from.
type ContentProvenance string

const (
	ContentProviderEmitted ContentProvenance = "provider_emitted"
	ContentHookObserved    ContentProvenance = "hook_observed"
	ContentToolObserved    ContentProvenance = "tool_observed"
	ContentCommandObserved ContentProvenance = "command_observed"
	ContentUserDeclared    ContentProvenance = "user_declared"
	ContentAgentDeclared   ContentProvenance = "agent_declared"
	ContentModelInferred   ContentProvenance = "model_inferred"
)

// CostProvenance labels the source of a cost figure. Costs must never be
// presented without this label.
type CostProvenance string

const (
	CostProviderReported CostProvenance = "provider_reported"
	CostCatalogEstimate  CostProvenance = "catalog_estimate"
	CostUserSupplied     CostProvenance = "user_supplied"
	CostUnknown          CostProvenance = "unknown"
)

// Provider identifiers supported by the local core.
const (
	ProviderClaude = "claude"
	ProviderCodex  = "codex"
	ProviderPi     = "pi"
	ProviderOTLP   = "otlp"
)

// ValidProviders returns the set of providers the local core recognizes.
func ValidProviders() map[string]bool {
	return map[string]bool{
		ProviderClaude: true,
		ProviderCodex:  true,
		ProviderPi:     true,
		ProviderOTLP:   true,
	}
}
