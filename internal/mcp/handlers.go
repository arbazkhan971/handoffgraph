package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/checkpoint"
	"github.com/handoffgraph/handoffgraph/internal/graph"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/launch"
	"github.com/handoffgraph/handoffgraph/internal/prompts"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/redact"
	"github.com/handoffgraph/handoffgraph/internal/repository"
	"github.com/handoffgraph/handoffgraph/internal/scores"
	"github.com/handoffgraph/handoffgraph/internal/storage"
	"github.com/handoffgraph/handoffgraph/internal/trace"
)

// eventKindFilesClaimed records a file-claim coordination event. It is a
// unique addition to the event vocabulary (the convention forbids inventing
// kinds that *duplicate* the stable spine); the graph reducer ignores kinds
// it does not model, so appending it cannot perturb derived graphs.
const eventKindFilesClaimed protocol.EventKind = "files.claimed"

// allowedVerificationResults is the closed set of record_verification result
// values (matching the checkpoint TestEvidence vocabulary).
var allowedVerificationResults = []string{"passed", "failed", "skipped", "error"}

// newToolset builds the nine v0.4.0 tools in roadmap order.
func newToolset(db *storage.DB) []Tool {
	return newToolsetWithRedaction(db, nil)
}

func newToolsetWithRedaction(db *storage.DB, redactionOptions *redact.Options) []Tool {
	return []Tool{
		{
			Name:        "get_workstream_context",
			Description: "Get the current context of a local workstream: sessions, decisions, verifications, claimed files, latest checkpoint, and graph integrity. Read-only; scoped to workstreams in the local database.",
			InputSchema: schema(map[string]any{
				"workstream_id": strProp("workstream id (ws_...) as listed by `handoffgraph workstream list`"),
			}, "workstream_id"),
			Handler: toolGetWorkstreamContext(db),
		},
		{
			Name:        "get_trace_context",
			Description: "Get one materialized turn trace with its spans for a workstream, including status, verification state, and failures. Read-only; traces from other workstreams are rejected.",
			InputSchema: schema(map[string]any{
				"workstream_id": strProp("workstream id that owns the trace"),
				"trace_id":      strProp("trace id (trc_...) to inspect"),
			}, "workstream_id", "trace_id"),
			Handler: toolGetTraceContext(db),
		},
		{
			Name:        "create_checkpoint",
			Description: "Build and store an evidence-backed checkpoint for a workstream using the deterministic, model-free checkpoint builder.",
			InputSchema: schema(map[string]any{
				"workstream_id": strProp("workstream id to checkpoint"),
				"objective":     strProp("optional objective text recorded on the checkpoint"),
				"status":        strProp("optional checkpoint status (default in_progress)"),
			}, "workstream_id"),
			Handler: toolCreateCheckpoint(db, redactionOptions),
		},
		{
			Name:        "record_decision",
			Description: "Record a decision made during the workstream as DECLARED evidence, optionally referencing event ids from the same workstream.",
			InputSchema: schema(map[string]any{
				"workstream_id": strProp("workstream id the decision belongs to"),
				"decision":      strProp("the decision, in one sentence"),
				"rationale":     strProp("optional rationale"),
				"evidence_refs": arrProp("optional event ids within the same workstream that support the decision"),
			}, "workstream_id", "decision"),
			Handler: toolRecordDecision(db),
		},
		{
			Name:        "record_verification",
			Description: "Record a verification outcome (test, build, or manual check). With an exit_code it is OBSERVED evidence; without one it is DECLARED.",
			InputSchema: schema(map[string]any{
				"workstream_id": strProp("workstream id the verification belongs to"),
				"verification":  strProp("what was verified (e.g. `go test ./internal/mcp/...`)"),
				"result":        enumProp("outcome", allowedVerificationResults...),
				"command":       strProp("optional command that was run"),
				"exit_code":     intProp("optional observed exit code; presence marks the verification OBSERVED"),
			}, "workstream_id", "verification", "result"),
			Handler: toolRecordVerification(db),
		},
		{
			Name:        "get_prompt",
			Description: "Get a managed prompt with all immutable versions, current labels, and resolved version per label. Read-only.",
			InputSchema: schema(map[string]any{
				"name": strProp("prompt name to resolve"),
			}, "name"),
			Handler: toolGetPrompt(db),
		},
		{
			Name:        "record_score",
			Description: "Record a quality score (numeric, category, or boolean) attached to a trace, span, session, checkpoint, or the workstream itself. Exactly one of value/category/bool_value. Scores are source-tagged (default api) and appended as OBSERVED score.recorded events.",
			InputSchema: schema(map[string]any{
				"workstream_id": strProp("workstream id the score belongs to"),
				"name":          strProp("score name (e.g. handoff.validity, human.review)"),
				"target_type":   enumProp("scored object type", "trace", "span", "session", "checkpoint", "workstream"),
				"target_id":     strProp("id of the scored object (trc_.../spn_.../ses_.../cp_.../ws_...)"),
				"value":         map[string]any{"type": "number", "description": "numeric score value (NUMERIC; exactly one of value/category/bool_value)"},
				"category":      strProp("category label (CATEGORY; exactly one of value/category/bool_value)"),
				"bool_value":    map[string]any{"type": "boolean", "description": "boolean verdict (BOOLEAN; exactly one of value/category/bool_value)"},
				"source":        enumProp("who produced the score", "human", "api", "evaluation", "detection"),
				"comment":       strProp("optional explanation"),
			}, "workstream_id", "name", "target_type", "target_id"),
			Handler: toolRecordScore(db),
		},
		{
			Name:        "list_scores",
			Description: "List quality scores recorded for a workstream, optionally filtered by target type/id or score name. Read-only.",
			InputSchema: schema(map[string]any{
				"workstream_id": strProp("workstream id whose scores to list"),
				"target_type":   enumProp("filter by scored object type", "trace", "span", "session", "checkpoint", "workstream"),
				"target_id":     strProp("filter by scored object id"),
				"name":          strProp("filter by score name"),
			}, "workstream_id"),
			Handler: toolListScores(db),
		},
		{
			Name:        "claim_files",
			Description: "Claim files for exclusive work within a workstream so parallel agents can coordinate. Earlier claims on the same paths are reported as conflicts.",
			InputSchema: schema(map[string]any{
				"workstream_id": strProp("workstream id the claim belongs to"),
				"repository_id": strProp("optional repository id; must be associated with the workstream in the local database"),
				"paths":         arrProp("repository-relative file paths to claim"),
			}, "workstream_id", "paths"),
			Handler: toolClaimFiles(db),
		},
		{
			Name:        "handoff_workstream",
			Description: "Create a handoff checkpoint for the workstream and record that it is being handed off, optionally to a named agent.",
			InputSchema: schema(map[string]any{
				"workstream_id": strProp("workstream id to hand off"),
				"reason":        strProp("optional reason for the handoff"),
				"to_agent":      strProp("optional name of the receiving agent"),
			}, "workstream_id"),
			Handler: toolHandoffWorkstream(db, redactionOptions),
		},
		{
			Name:        "accept_handoff",
			Description: "Acknowledge a handoff and classify checkpoint sections as accepted, missing, or unverifiable. A checkpoint reference binds to the newest matching structured continuation.",
			InputSchema: schema(map[string]any{
				"workstream_id": strProp("workstream id whose handoff is accepted"),
				"handoff_id":    strProp("optional exact handoff id (ho_...); checkpoint_id can resolve it when omitted"),
				"checkpoint_id": strProp("optional checkpoint id (cp_...) from the same workstream"),
				"agent":         strProp("optional name of the accepting agent"),
				"accepted":      arrProp("checkpoint sections received and understood"),
				"missing":       arrProp("checkpoint sections that were absent or empty"),
				"unverifiable":  arrProp("checkpoint sections whose evidence could not be verified"),
			}, "workstream_id"),
			Handler: toolAcceptHandoff(db),
		},
		{
			Name:        "complete_workstream",
			Description: "Mark a workstream completed with an optional summary. Returns a tool error (no event) if the workstream is already completed.",
			InputSchema: schema(map[string]any{
				"workstream_id": strProp("workstream id to complete"),
				"summary":       strProp("optional completion summary"),
			}, "workstream_id"),
			Handler: toolCompleteWorkstream(db),
		},
	}
}

// ---- schema helpers -------------------------------------------------------

func schema(props map[string]any, required ...string) map[string]any {
	s := map[string]any{
		"type":                 "object",
		"properties":           props,
		"additionalProperties": false,
	}
	if len(required) > 0 {
		req := make([]string, 0, len(required))
		req = append(req, required...)
		s["required"] = req
	}
	return s
}

func strProp(desc string) map[string]any {
	return map[string]any{"type": "string", "description": desc}
}

func intProp(desc string) map[string]any {
	return map[string]any{"type": "integer", "description": desc}
}

func arrProp(desc string) map[string]any {
	return map[string]any{
		"type":        "array",
		"items":       map[string]any{"type": "string"},
		"description": desc,
	}
}

func enumProp(desc string, values ...string) map[string]any {
	return map[string]any{
		"type":        "string",
		"enum":        values,
		"description": desc,
	}
}

// ---- shared plumbing ------------------------------------------------------

// loadWorkstream resolves a workstream that exists in the local database and
// returns it with only its own events. Any id that is not present locally is
// rejected: tools never read or write across workstreams.
func loadWorkstream(ctx context.Context, db *storage.DB, id string) (*storage.Workstream, []*protocol.Event, *rpcError) {
	if id == "" {
		return nil, nil, errInvalidParams("workstream_id is required")
	}
	all, err := db.ListWorkstreams(ctx)
	if err != nil {
		return nil, nil, errInternal(err)
	}
	var ws *storage.Workstream
	for _, w := range all {
		if w.ID == id {
			ws = w
			break
		}
	}
	if ws == nil {
		return nil, nil, errInvalidParams(fmt.Sprintf("workstream %q not found in local database", id))
	}
	events, err := db.ListEvents(ctx)
	if err != nil {
		return nil, nil, errInternal(err)
	}
	own := make([]*protocol.Event, 0, len(events))
	for _, ev := range events {
		if ev.WorkstreamID == id {
			own = append(own, ev)
		}
	}
	return ws, own, nil
}

// validRepositoryID enforces repository scoping: an explicit repository id
// must match the workstream's recorded repository or appear on one of the
// workstream's events. Empty means "not specified" and is allowed.
func validRepositoryID(ws *storage.Workstream, events []*protocol.Event, repoID string) *rpcError {
	if repoID == "" {
		return nil
	}
	if ws.RepositoryID != "" {
		if ws.RepositoryID == repoID {
			return nil
		}
		return errInvalidParams(fmt.Sprintf("repository %q is not associated with workstream %s", repoID, ws.ID))
	}
	for _, ev := range events {
		if ev.RepositoryID == repoID {
			return nil
		}
	}
	return errInvalidParams(fmt.Sprintf("repository %q not found in local database", repoID))
}

// appendEvent creates and appends one canonical event. Events are
// append-only; the payload map is marshaled with sorted keys so the stored
// bytes are deterministic.
func appendEvent(ctx context.Context, db *storage.DB, wsID string, kind protocol.EventKind, prov protocol.Provenance, payload map[string]any) (string, *rpcError) {
	now := time.Now().UTC()
	ev := &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       ids.Event(),
		OccurredAt:    now,
		ObservedAt:    now,
		WorkstreamID:  wsID,
		Kind:          kind,
		Provenance:    prov,
	}
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			return "", errInternal(err)
		}
		ev.Payload = raw
	}
	if _, err := db.AppendEvent(ctx, ev); err != nil {
		return "", errInternal(err)
	}
	return ev.EventID, nil
}

// recordedEventResult is the common tail of every event-recording tool.
type recordedEventResult struct {
	EventID      string `json:"event_id"`
	WorkstreamID string `json:"workstream_id"`
	Kind         string `json:"kind"`
	Provenance   string `json:"provenance"`
}

// buildAndSaveCheckpoint builds a checkpoint from the workstream's own
// events (same builder as `handoffgraph checkpoint`) and persists it.
func buildAndSaveCheckpoint(ctx context.Context, db *storage.DB, wsID string, events []*protocol.Event, objective, status string, redactionOptions *redact.Options) (*protocol.Checkpoint, *rpcError) {
	repoState, _ := repository.State(ctx, ".")
	cp, err := checkpoint.Build(ctx, checkpoint.BuildOptions{
		WorkstreamID: wsID,
		Objective:    objective,
		Status:       status,
		Repo:         repoState,
		Events:       events,
		Redaction:    redactionOptions,
	})
	if err != nil {
		return nil, errInternal(err)
	}
	if err := db.SaveCheckpoint(ctx, cp); err != nil {
		return nil, errInternal(err)
	}
	return cp, nil
}

// checkpointResult is the tool-facing projection of a stored checkpoint.
type checkpointResult struct {
	CheckpointID     string `json:"checkpoint_id"`
	WorkstreamID     string `json:"workstream_id"`
	Status           string `json:"status"`
	Objective        string `json:"objective,omitempty"`
	Score            int    `json:"score"`
	GraphRootHash    string `json:"graph_root_hash"`
	Decisions        int    `json:"decisions"`
	Files            int    `json:"files"`
	Commands         int    `json:"commands"`
	Tests            int    `json:"tests"`
	FailedApproaches int    `json:"failed_approaches"`
	SourceSessions   int    `json:"source_sessions"`
}

func checkpointToResult(cp *protocol.Checkpoint) checkpointResult {
	return checkpointResult{
		CheckpointID:     cp.CheckpointID,
		WorkstreamID:     cp.WorkstreamID,
		Status:           cp.Status,
		Objective:        cp.Objective,
		Score:            cp.Integrity.Score,
		GraphRootHash:    cp.Integrity.GraphRootHash,
		Decisions:        len(cp.Decisions),
		Files:            len(cp.Files),
		Commands:         len(cp.Commands),
		Tests:            len(cp.Tests),
		FailedApproaches: len(cp.FailedApproaches),
		SourceSessions:   len(cp.SourceSessions),
	}
}

// payloadString extracts a string field from an event payload.
func payloadString(ev *protocol.Event, key string) string {
	if len(ev.Payload) == 0 {
		return ""
	}
	var m map[string]any
	if err := json.Unmarshal(ev.Payload, &m); err != nil {
		return ""
	}
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

// payloadStrings extracts a string-slice field from an event payload.
func payloadStrings(ev *protocol.Event, key string) []string {
	if len(ev.Payload) == 0 {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal(ev.Payload, &m); err != nil {
		return nil
	}
	raw, ok := m[key].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, it := range raw {
		if s, ok := it.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// nsRFC3339 renders a nanosecond timestamp, or "" when zero.
func nsRFC3339(ns int64) string {
	if ns == 0 {
		return ""
	}
	return time.Unix(0, ns).UTC().Format(time.RFC3339Nano)
}

// deriveWorkstreamStatus derives a lifecycle status from the workstream's
// own events. It is a derived value, so callers must label it INFERRED.
func deriveWorkstreamStatus(events []*protocol.Event) string {
	status := "active"
	for _, ev := range events {
		// Completion is terminal. All other lifecycle state is folded in event
		// order so a handoff acknowledgement returns the workstream to active
		// instead of leaving MCP context stale at handed_off.
		if status == "completed" {
			continue
		}
		switch ev.Kind {
		case protocol.EventWorkstreamCompleted:
			status = "completed"
		case protocol.EventHandoffCreated:
			status = "handed_off"
		case protocol.EventHandoffAccepted:
			status = "active"
		}
	}
	return status
}

// ---- tool 1: get_workstream_context ---------------------------------------

type getWorkstreamContextArgs struct {
	WorkstreamID string `json:"workstream_id"`
}

type provenancedValue struct {
	Value      string `json:"value"`
	Provenance string `json:"provenance"`
}

type sessionSummary struct {
	SessionID       string `json:"session_id"`
	Provider        string `json:"provider,omitempty"`
	NativeSessionID string `json:"native_session_id,omitempty"`
	Events          int    `json:"events"`
}

type checkpointSummary struct {
	CheckpointID  string `json:"checkpoint_id"`
	Status        string `json:"status,omitempty"`
	Score         int    `json:"score"`
	GraphRootHash string `json:"graph_root_hash,omitempty"`
}

type graphSummary struct {
	NodeCount int    `json:"node_count"`
	EdgeCount int    `json:"edge_count"`
	RootHash  string `json:"root_hash"`
}

type workstreamContextResult struct {
	WorkstreamID     string             `json:"workstream_id"`
	Title            string             `json:"title"`
	CreatedAt        string             `json:"created_at"`
	Status           provenancedValue   `json:"status"`
	EventCount       int                `json:"event_count"`
	Sessions         []sessionSummary   `json:"sessions"`
	Decisions        int                `json:"decisions"`
	Verifications    int                `json:"verifications"`
	ClaimedFiles     []string           `json:"claimed_files"`
	LatestCheckpoint *checkpointSummary `json:"latest_checkpoint"`
	Graph            graphSummary       `json:"graph"`
}

func toolGetWorkstreamContext(db *storage.DB) func(context.Context, json.RawMessage) (any, error) {
	return func(ctx context.Context, args json.RawMessage) (any, error) {
		var in getWorkstreamContextArgs
		if e := decodeStrict(args, "arguments", &in); e != nil {
			return nil, e
		}
		ws, events, e := loadWorkstream(ctx, db, in.WorkstreamID)
		if e != nil {
			return nil, e
		}

		out := workstreamContextResult{
			WorkstreamID: ws.ID,
			Title:        ws.Title,
			CreatedAt:    ws.CreatedAt.UTC().Format(time.RFC3339),
			// The status is derived from events, never asserted: label it
			// INFERRED so it can never be mistaken for an observed value.
			Status:       provenancedValue{Value: deriveWorkstreamStatus(events), Provenance: string(protocol.ProvenanceInferred)},
			EventCount:   len(events),
			Sessions:     []sessionSummary{},
			ClaimedFiles: []string{},
		}

		sessions := map[string]*sessionSummary{}
		claims := map[string]bool{}
		for _, ev := range events {
			if ev.SessionID != "" {
				s, ok := sessions[ev.SessionID]
				if !ok {
					s = &sessionSummary{
						SessionID:       ev.SessionID,
						Provider:        ev.Provider,
						NativeSessionID: ev.NativeSessionID,
					}
					sessions[ev.SessionID] = s
				}
				s.Events++
			}
			switch ev.Kind {
			case protocol.EventDecisionRecorded:
				out.Decisions++
			case protocol.EventVerificationRecorded:
				out.Verifications++
			case eventKindFilesClaimed:
				for _, p := range payloadStrings(ev, "paths") {
					claims[p] = true
				}
			}
		}
		for _, id := range sortedKeys(sessions) {
			out.Sessions = append(out.Sessions, *sessions[id])
		}
		for p := range claims {
			out.ClaimedFiles = append(out.ClaimedFiles, p)
		}
		sort.Strings(out.ClaimedFiles)

		g := graph.Reduce(events)
		hash, err := graph.RootHash(g)
		if err != nil {
			return nil, errInternal(err)
		}
		out.Graph = graphSummary{NodeCount: len(g.Nodes), EdgeCount: len(g.Edges), RootHash: hash}

		cps, err := db.ListCheckpoints(ctx, ws.ID)
		if err != nil {
			return nil, errInternal(err)
		}
		if len(cps) > 0 {
			latest := cps[len(cps)-1]
			out.LatestCheckpoint = &checkpointSummary{
				CheckpointID:  latest.CheckpointID,
				Status:        latest.Status,
				Score:         latest.Integrity.Score,
				GraphRootHash: latest.Integrity.GraphRootHash,
			}
		}
		return out, nil
	}
}

// sortedKeys returns the sorted keys of a string-keyed map so output never
// leaks map iteration order.
func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// ---- tool 2: get_trace_context ---------------------------------------------

type getTraceContextArgs struct {
	WorkstreamID string `json:"workstream_id"`
	TraceID      string `json:"trace_id"`
}

type spanSummary struct {
	SpanID       string `json:"span_id"`
	ParentSpanID string `json:"parent_span_id,omitempty"`
	Kind         string `json:"kind"`
	Name         string `json:"name"`
	Status       string `json:"status"`
	StartedAt    string `json:"started_at"`
	EndedAt      string `json:"ended_at,omitempty"`
	ToolName     string `json:"tool_name,omitempty"`
	ExitCode     *int   `json:"exit_code,omitempty"`
}

type traceContextResult struct {
	TraceID           string        `json:"trace_id"`
	WorkstreamID      string        `json:"workstream_id"`
	SessionID         string        `json:"session_id,omitempty"`
	Provider          string        `json:"provider,omitempty"`
	ObjectiveExcerpt  string        `json:"objective_excerpt,omitempty"`
	Status            string        `json:"status"`
	StartedAt         string        `json:"started_at"`
	EndedAt           string        `json:"ended_at,omitempty"`
	DurationMS        int64         `json:"duration_ms"`
	SpanCount         int64         `json:"span_count"`
	FailedSpanCount   int64         `json:"failed_span_count"`
	ChangedFileCount  int64         `json:"changed_file_count"`
	VerificationState string        `json:"verification_state"`
	RootSpanID        string        `json:"root_span_id,omitempty"`
	Spans             []spanSummary `json:"spans"`
}

func toolGetTraceContext(db *storage.DB) func(context.Context, json.RawMessage) (any, error) {
	return func(ctx context.Context, args json.RawMessage) (any, error) {
		var in getTraceContextArgs
		if e := decodeStrict(args, "arguments", &in); e != nil {
			return nil, e
		}
		if in.TraceID == "" {
			return nil, errInvalidParams("trace_id is required")
		}
		_, events, e := loadWorkstream(ctx, db, in.WorkstreamID)
		if e != nil {
			return nil, e
		}

		res := trace.Materialize(events)
		var tr *protocol.Trace
		for _, t := range res.Traces {
			if t.TraceID == in.TraceID {
				tr = t
				break
			}
		}
		if tr == nil {
			// Unknown here covers cross-workstream traces too: only this
			// workstream's events were materialized, so another
			// workstream's trace id can never resolve.
			return nil, errInvalidParams(fmt.Sprintf("trace %q not found in workstream %q", in.TraceID, in.WorkstreamID))
		}

		spans := []spanSummary{}
		for _, sp := range res.Spans {
			if sp.TraceID != tr.TraceID {
				continue
			}
			spans = append(spans, spanSummary{
				SpanID:       sp.SpanID,
				ParentSpanID: sp.ParentSpanID,
				Kind:         string(sp.Kind),
				Name:         sp.Name,
				Status:       sp.Status,
				StartedAt:    nsRFC3339(sp.StartedAtNS),
				EndedAt:      nsRFC3339(sp.EndedAtNS),
				ToolName:     sp.ToolName,
				ExitCode:     sp.ExitCode,
			})
		}

		return traceContextResult{
			TraceID:           tr.TraceID,
			WorkstreamID:      tr.WorkstreamID,
			SessionID:         tr.SessionID,
			Provider:          tr.Provider,
			ObjectiveExcerpt:  tr.ObjectiveExcerpt,
			Status:            string(tr.Status),
			StartedAt:         nsRFC3339(tr.StartedAtNS),
			EndedAt:           nsRFC3339(tr.EndedAtNS),
			DurationMS:        tr.DurationNS / int64(time.Millisecond),
			SpanCount:         tr.SpanCount,
			FailedSpanCount:   tr.FailedSpanCount,
			ChangedFileCount:  tr.ChangedFileCount,
			VerificationState: string(tr.VerificationState),
			RootSpanID:        tr.RootSpanID,
			Spans:             spans,
		}, nil
	}
}

// ---- tool 3: create_checkpoint ----------------------------------------------

type createCheckpointArgs struct {
	WorkstreamID string `json:"workstream_id"`
	Objective    string `json:"objective,omitempty"`
	Status       string `json:"status,omitempty"`
}

func toolCreateCheckpoint(db *storage.DB, redactionOptions *redact.Options) func(context.Context, json.RawMessage) (any, error) {
	return func(ctx context.Context, args json.RawMessage) (any, error) {
		var in createCheckpointArgs
		if e := decodeStrict(args, "arguments", &in); e != nil {
			return nil, e
		}
		_, events, e := loadWorkstream(ctx, db, in.WorkstreamID)
		if e != nil {
			return nil, e
		}
		cp, e := buildAndSaveCheckpoint(ctx, db, in.WorkstreamID, events, in.Objective, in.Status, redactionOptions)
		if e != nil {
			return nil, e
		}
		return checkpointToResult(cp), nil
	}
}

// ---- tool 4: record_decision -------------------------------------------------

type recordDecisionArgs struct {
	WorkstreamID string   `json:"workstream_id"`
	Decision     string   `json:"decision"`
	Rationale    string   `json:"rationale,omitempty"`
	EvidenceRefs []string `json:"evidence_refs,omitempty"`
}

type recordDecisionResult struct {
	recordedEventResult
	Decision string `json:"decision"`
}

func toolRecordDecision(db *storage.DB) func(context.Context, json.RawMessage) (any, error) {
	return func(ctx context.Context, args json.RawMessage) (any, error) {
		var in recordDecisionArgs
		if e := decodeStrict(args, "arguments", &in); e != nil {
			return nil, e
		}
		if in.Decision == "" {
			return nil, errInvalidParams("decision is required")
		}
		ws, events, e := loadWorkstream(ctx, db, in.WorkstreamID)
		if e != nil {
			return nil, e
		}
		known := map[string]bool{}
		for _, ev := range events {
			known[ev.EventID] = true
		}
		for _, ref := range in.EvidenceRefs {
			if ref == "" {
				return nil, errInvalidParams("evidence_refs entries must be non-empty")
			}
			if !known[ref] {
				return nil, errInvalidParams(fmt.Sprintf("evidence ref %q not found in workstream %s", ref, ws.ID))
			}
		}

		payload := map[string]any{"decision": in.Decision}
		if in.Rationale != "" {
			payload["rationale"] = in.Rationale
		}
		if len(in.EvidenceRefs) > 0 {
			payload["evidence_refs"] = in.EvidenceRefs
		}
		eventID, e := appendEvent(ctx, db, ws.ID, protocol.EventDecisionRecorded, protocol.ProvenanceDeclared, payload)
		if e != nil {
			return nil, e
		}
		return recordDecisionResult{
			recordedEventResult: recordedEventResult{
				EventID:      eventID,
				WorkstreamID: ws.ID,
				Kind:         string(protocol.EventDecisionRecorded),
				Provenance:   string(protocol.ProvenanceDeclared),
			},
			Decision: in.Decision,
		}, nil
	}
}

// ---- tool 5: record_verification ----------------------------------------------

type recordVerificationArgs struct {
	WorkstreamID string `json:"workstream_id"`
	Verification string `json:"verification"`
	Result       string `json:"result"`
	Command      string `json:"command,omitempty"`
	ExitCode     *int   `json:"exit_code,omitempty"`
}

type recordVerificationResult struct {
	recordedEventResult
	Verification string `json:"verification"`
	Result       string `json:"result"`
}

func toolRecordVerification(db *storage.DB) func(context.Context, json.RawMessage) (any, error) {
	return func(ctx context.Context, args json.RawMessage) (any, error) {
		var in recordVerificationArgs
		if e := decodeStrict(args, "arguments", &in); e != nil {
			return nil, e
		}
		if in.Verification == "" {
			return nil, errInvalidParams("verification is required")
		}
		if !containsString(allowedVerificationResults, in.Result) {
			return nil, errInvalidParams(fmt.Sprintf("result must be one of %v", allowedVerificationResults))
		}
		ws, _, e := loadWorkstream(ctx, db, in.WorkstreamID)
		if e != nil {
			return nil, e
		}

		// An exit code was observed, not declared: only then is the
		// verification labelled OBSERVED.
		prov := protocol.ProvenanceDeclared
		if in.ExitCode != nil {
			prov = protocol.ProvenanceObserved
		}

		payload := map[string]any{
			"verification": in.Verification,
			"result":       in.Result,
		}
		if in.Command != "" {
			payload["command"] = in.Command
		}
		if in.ExitCode != nil {
			payload["exit_code"] = *in.ExitCode
		}
		eventID, e := appendEvent(ctx, db, ws.ID, protocol.EventVerificationRecorded, prov, payload)
		if e != nil {
			return nil, e
		}
		return recordVerificationResult{
			recordedEventResult: recordedEventResult{
				EventID:      eventID,
				WorkstreamID: ws.ID,
				Kind:         string(protocol.EventVerificationRecorded),
				Provenance:   string(prov),
			},
			Verification: in.Verification,
			Result:       in.Result,
		}, nil
	}
}

func containsString(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

// ---- tool 6: claim_files --------------------------------------------------------

type claimFilesArgs struct {
	WorkstreamID string   `json:"workstream_id"`
	RepositoryID string   `json:"repository_id,omitempty"`
	Paths        []string `json:"paths"`
}

type claimConflict struct {
	Path      string   `json:"path"`
	ClaimedBy []string `json:"claimed_by"`
}

type claimFilesResult struct {
	recordedEventResult
	Paths        []string        `json:"paths"`
	Conflicts    []claimConflict `json:"conflicts"`
	RepositoryID string          `json:"repository_id,omitempty"`
}

func toolClaimFiles(db *storage.DB) func(context.Context, json.RawMessage) (any, error) {
	return func(ctx context.Context, args json.RawMessage) (any, error) {
		var in claimFilesArgs
		if e := decodeStrict(args, "arguments", &in); e != nil {
			return nil, e
		}
		if len(in.Paths) == 0 {
			return nil, errInvalidParams("paths is required and must not be empty")
		}
		for _, p := range in.Paths {
			if p == "" {
				return nil, errInvalidParams("paths entries must be non-empty")
			}
		}
		ws, events, e := loadWorkstream(ctx, db, in.WorkstreamID)
		if e != nil {
			return nil, e
		}
		if e := validRepositoryID(ws, events, in.RepositoryID); e != nil {
			return nil, e
		}

		paths := sortedUnique(in.Paths)

		// Report conflicts with earlier claims in the same workstream; the
		// new claim is still recorded because the log is append-only.
		claims := map[string][]string{}
		for _, ev := range events {
			if ev.Kind != eventKindFilesClaimed {
				continue
			}
			for _, p := range payloadStrings(ev, "paths") {
				claims[p] = append(claims[p], ev.EventID)
			}
		}
		conflicts := []claimConflict{}
		for _, p := range paths {
			if claimants := claims[p]; len(claimants) > 0 {
				sort.Strings(claimants)
				conflicts = append(conflicts, claimConflict{Path: p, ClaimedBy: claimants})
			}
		}

		payload := map[string]any{"paths": paths}
		if in.RepositoryID != "" {
			payload["repository_id"] = in.RepositoryID
		}
		eventID, e := appendEvent(ctx, db, ws.ID, eventKindFilesClaimed, protocol.ProvenanceDeclared, payload)
		if e != nil {
			return nil, e
		}
		return claimFilesResult{
			recordedEventResult: recordedEventResult{
				EventID:      eventID,
				WorkstreamID: ws.ID,
				Kind:         string(eventKindFilesClaimed),
				Provenance:   string(protocol.ProvenanceDeclared),
			},
			Paths:        paths,
			Conflicts:    conflicts,
			RepositoryID: in.RepositoryID,
		}, nil
	}
}

func sortedUnique(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, s := range in {
		if seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

// ---- tool 7: handoff_workstream ---------------------------------------------------

type handoffWorkstreamArgs struct {
	WorkstreamID string `json:"workstream_id"`
	Reason       string `json:"reason,omitempty"`
	ToAgent      string `json:"to_agent,omitempty"`
}

type handoffWorkstreamResult struct {
	recordedEventResult
	Checkpoint checkpointResult `json:"checkpoint"`
	Reason     string           `json:"reason,omitempty"`
	ToAgent    string           `json:"to_agent,omitempty"`
}

func toolHandoffWorkstream(db *storage.DB, redactionOptions *redact.Options) func(context.Context, json.RawMessage) (any, error) {
	return func(ctx context.Context, args json.RawMessage) (any, error) {
		var in handoffWorkstreamArgs
		if e := decodeStrict(args, "arguments", &in); e != nil {
			return nil, e
		}
		ws, events, e := loadWorkstream(ctx, db, in.WorkstreamID)
		if e != nil {
			return nil, e
		}

		// The handoff package is a checkpoint: build and store it so the
		// receiving agent has an evidence-backed starting point.
		cp, e := buildAndSaveCheckpoint(ctx, db, ws.ID, events, "", "handed_off", redactionOptions)
		if e != nil {
			return nil, e
		}

		payload := map[string]any{"checkpoint_id": cp.CheckpointID}
		if in.Reason != "" {
			payload["reason"] = in.Reason
		}
		if in.ToAgent != "" {
			payload["to_agent"] = in.ToAgent
		}
		eventID, e := appendEvent(ctx, db, ws.ID, protocol.EventHandoffCreated, protocol.ProvenanceDeclared, payload)
		if e != nil {
			return nil, e
		}
		return handoffWorkstreamResult{
			recordedEventResult: recordedEventResult{
				EventID:      eventID,
				WorkstreamID: ws.ID,
				Kind:         string(protocol.EventHandoffCreated),
				Provenance:   string(protocol.ProvenanceDeclared),
			},
			Checkpoint: checkpointToResult(cp),
			Reason:     in.Reason,
			ToAgent:    in.ToAgent,
		}, nil
	}
}

// ---- tool 8: accept_handoff ---------------------------------------------------------

type acceptHandoffArgs struct {
	WorkstreamID string   `json:"workstream_id"`
	HandoffID    string   `json:"handoff_id,omitempty"`
	CheckpointID string   `json:"checkpoint_id,omitempty"`
	Agent        string   `json:"agent,omitempty"`
	Accepted     []string `json:"accepted,omitempty"`
	Missing      []string `json:"missing,omitempty"`
	Unverifiable []string `json:"unverifiable,omitempty"`
}

type acceptHandoffResult struct {
	recordedEventResult
	HandoffID    string   `json:"handoff_id,omitempty"`
	CheckpointID string   `json:"checkpoint_id,omitempty"`
	Agent        string   `json:"agent,omitempty"`
	Accepted     []string `json:"accepted,omitempty"`
	Missing      []string `json:"missing,omitempty"`
	Unverifiable []string `json:"unverifiable,omitempty"`
}

func toolAcceptHandoff(db *storage.DB) func(context.Context, json.RawMessage) (any, error) {
	return func(ctx context.Context, args json.RawMessage) (any, error) {
		var in acceptHandoffArgs
		if e := decodeStrict(args, "arguments", &in); e != nil {
			return nil, e
		}
		ws, _, e := loadWorkstream(ctx, db, in.WorkstreamID)
		if e != nil {
			return nil, e
		}
		if in.CheckpointID != "" {
			cps, err := db.ListCheckpoints(ctx, ws.ID)
			if err != nil {
				return nil, errInternal(err)
			}
			found := false
			for _, cp := range cps {
				if cp.CheckpointID == in.CheckpointID {
					found = true
					break
				}
			}
			if !found {
				return nil, errInvalidParams(fmt.Sprintf("checkpoint %q not found in workstream %s", in.CheckpointID, ws.ID))
			}
		}

		// A v0.6 continuation records a structured handoff.created payload.
		// Resolve it by exact handoff id or by the machine-readable checkpoint
		// reference printed in the continuation prompt, then append acceptance
		// through the shared launch layer so `handoff status` observes it.
		handoffs, err := launch.ListHandoffs(ctx, db)
		if err != nil {
			return nil, errInternal(err)
		}
		var matched *launch.HandoffRecord
		for i := len(handoffs) - 1; i >= 0; i-- {
			r := handoffs[i]
			if r.WorkstreamID != ws.ID {
				continue
			}
			if in.HandoffID != "" && r.ID != in.HandoffID {
				continue
			}
			if in.CheckpointID != "" && r.SourceCheckpoint != in.CheckpointID {
				continue
			}
			matched = r
			break
		}
		if in.HandoffID != "" && matched == nil {
			return nil, errInvalidParams(fmt.Sprintf("handoff %q not found in workstream %s", in.HandoffID, ws.ID))
		}
		if matched != nil {
			if in.Agent != "" && in.Agent != matched.TargetAgent {
				return nil, errInvalidParams(fmt.Sprintf("handoff %s targets agent %q, not %q", matched.ID, matched.TargetAgent, in.Agent))
			}
			rec, eventID, acceptErr := launch.AcceptHandoffWithEvent(ctx, db, matched.ID, in.Accepted, in.Missing, in.Unverifiable)
			if acceptErr != nil {
				return nil, errInternal(acceptErr)
			}
			return acceptHandoffResult{
				recordedEventResult: recordedEventResult{
					EventID:      eventID,
					WorkstreamID: ws.ID,
					Kind:         string(protocol.EventHandoffAccepted),
					Provenance:   string(protocol.ProvenanceDeclared),
				},
				HandoffID:    rec.ID,
				CheckpointID: rec.SourceCheckpoint,
				Agent:        rec.TargetAgent,
				Accepted:     rec.Accepted,
				Missing:      rec.Missing,
				Unverifiable: rec.Unverifiable,
			}, nil
		}

		// Backward-compatible v0.4 acknowledgement: a workstream handoff made
		// without a structured continuation still records its scoped event.
		payload := map[string]any{}
		if in.CheckpointID != "" {
			payload["checkpoint_id"] = in.CheckpointID
		}
		if in.Agent != "" {
			payload["agent"] = in.Agent
		}
		if len(in.Accepted) > 0 {
			payload["accepted"] = sortedUnique(in.Accepted)
		}
		if len(in.Missing) > 0 {
			payload["missing"] = sortedUnique(in.Missing)
		}
		if len(in.Unverifiable) > 0 {
			payload["unverifiable"] = sortedUnique(in.Unverifiable)
		}
		eventID, e := appendEvent(ctx, db, ws.ID, protocol.EventHandoffAccepted, protocol.ProvenanceDeclared, payload)
		if e != nil {
			return nil, e
		}
		return acceptHandoffResult{
			recordedEventResult: recordedEventResult{
				EventID:      eventID,
				WorkstreamID: ws.ID,
				Kind:         string(protocol.EventHandoffAccepted),
				Provenance:   string(protocol.ProvenanceDeclared),
			},
			CheckpointID: in.CheckpointID,
			Agent:        in.Agent,
			Accepted:     sortedUnique(in.Accepted),
			Missing:      sortedUnique(in.Missing),
			Unverifiable: sortedUnique(in.Unverifiable),
		}, nil
	}
}

// ---- tool 9: complete_workstream -------------------------------------------------------

type completeWorkstreamArgs struct {
	WorkstreamID string `json:"workstream_id"`
	Summary      string `json:"summary,omitempty"`
}

type completeWorkstreamResult struct {
	recordedEventResult
	Summary string `json:"summary,omitempty"`
}

func toolCompleteWorkstream(db *storage.DB) func(context.Context, json.RawMessage) (any, error) {
	return func(ctx context.Context, args json.RawMessage) (any, error) {
		var in completeWorkstreamArgs
		if e := decodeStrict(args, "arguments", &in); e != nil {
			return nil, e
		}
		ws, events, e := loadWorkstream(ctx, db, in.WorkstreamID)
		if e != nil {
			return nil, e
		}
		if deriveWorkstreamStatus(events) == "completed" {
			// Domain failure, not a protocol error: the caller gets a tool
			// result with isValidTool=false and no event is appended.
			return nil, &ToolError{Msg: fmt.Sprintf("workstream %s is already completed", ws.ID)}
		}

		payload := map[string]any{}
		if in.Summary != "" {
			payload["summary"] = in.Summary
		}
		eventID, e := appendEvent(ctx, db, ws.ID, protocol.EventWorkstreamCompleted, protocol.ProvenanceDeclared, payload)
		if e != nil {
			return nil, e
		}
		return completeWorkstreamResult{
			recordedEventResult: recordedEventResult{
				EventID:      eventID,
				WorkstreamID: ws.ID,
				Kind:         string(protocol.EventWorkstreamCompleted),
				Provenance:   string(protocol.ProvenanceDeclared),
			},
			Summary: in.Summary,
		}, nil
	}
}

// ---- prompts (parity rows 33-34) -------------------------------------------

// toolGetPrompt resolves one named prompt from the derived view: versions,
// labels, resolution table.
func toolGetPrompt(db *storage.DB) func(context.Context, json.RawMessage) (any, error) {
	return func(ctx context.Context, args json.RawMessage) (any, error) {
		var in struct {
			Name string `json:"name"`
		}
		if e := decodeStrict(args, "arguments", &in); e != nil {
			return nil, e
		}
		if in.Name == "" {
			return nil, errInvalidParams("name is required")
		}
		events, e := listEvents(ctx, db)
		if e != nil {
			return nil, e
		}
		byName := prompts.Materialize(events)
		pr, ok := byName[in.Name]
		if !ok {
			return nil, errInvalidParams(fmt.Sprintf("prompt %q not found", in.Name))
		}
		return map[string]any{
			"name":       pr.Name,
			"versions":   pr.Versions,
			"labels":     pr.Labels,
			"resolution": pr.Resolve(),
		}, nil
	}
}

// listEvents is a small helper so read tools share one path.
func listEvents(ctx context.Context, db *storage.DB) ([]*protocol.Event, *rpcError) {
	events, err := db.ListEvents(ctx)
	if err != nil {
		return nil, errInternal(err)
	}
	return events, nil
}

// ---- score recording + listing (parity P1, matrix row 24) -------------------

type recordScoreArgs struct {
	WorkstreamID string   `json:"workstream_id"`
	Name         string   `json:"name"`
	TargetType   string   `json:"target_type"`
	TargetID     string   `json:"target_id"`
	Value        *float64 `json:"value,omitempty"`
	Category     string   `json:"category,omitempty"`
	BoolValue    *bool    `json:"bool_value,omitempty"`
	Source       string   `json:"source,omitempty"`
	Comment      string   `json:"comment,omitempty"`
}

type recordScoreResult struct {
	recordedEventResult
	Name       string `json:"name"`
	DataType   string `json:"data_type"`
	Value      string `json:"value"`
	TargetType string `json:"target_type"`
	TargetID   string `json:"target_id"`
	Source     string `json:"source"`
}

// toolRecordScore records a score.recorded event — the universal quality
// primitive: a numeric metric, categorical label, or boolean verdict
// attached to any spine object, always source-tagged. Exactly one value
// slot must be supplied, matching the declared target-type shape.
func toolRecordScore(db *storage.DB) func(context.Context, json.RawMessage) (any, error) {
	return func(ctx context.Context, args json.RawMessage) (any, error) {
		var in recordScoreArgs
		if e := decodeStrict(args, "arguments", &in); e != nil {
			return nil, e
		}
		supplied := 0
		if in.Value != nil {
			supplied++
		}
		if in.Category != "" {
			supplied++
		}
		if in.BoolValue != nil {
			supplied++
		}
		if supplied != 1 {
			return nil, errInvalidParams("supply exactly one of value (number), category (string), bool_value (boolean)")
		}
		source := in.Source
		if source == "" {
			source = string(protocol.ScoreSourceAPI)
		}
		input := scores.Input{
			Name:        in.Name,
			DataType:    dataTypeFor(in.Value, in.Category, in.BoolValue),
			Value:       in.Value,
			StringValue: in.Category,
			BoolValue:   in.BoolValue,
			TargetType:  protocol.ScoreTargetType(strings.ToLower(in.TargetType)),
			TargetID:    in.TargetID,
			Source:      protocol.ScoreSource(strings.ToLower(source)),
			Comment:     in.Comment,
		}
		ws, _, e := loadWorkstream(ctx, db, in.WorkstreamID)
		if e != nil {
			return nil, e
		}
		ev, err := scores.NewEvent(ids.Event(), ws.ID, input, time.Now().UTC())
		if err != nil {
			return nil, errInvalidParams(err.Error())
		}
		if _, err := db.AppendEvent(ctx, ev); err != nil {
			return nil, errInternal(err)
		}
		return recordScoreResult{
			recordedEventResult: recordedEventResult{
				EventID:      ev.EventID,
				WorkstreamID: ws.ID,
				Kind:         string(protocol.EventScoreRecorded),
				Provenance:   string(ev.Provenance),
			},
			Name:       input.Name,
			DataType:   string(input.DataType),
			Value:      scoreValueDisplay(input),
			TargetType: string(input.TargetType),
			TargetID:   input.TargetID,
			Source:     string(input.Source),
		}, nil
	}
}

// dataTypeFor picks the score data type from the supplied value slot.
func dataTypeFor(value *float64, category string, boolValue *bool) protocol.ScoreDataType {
	switch {
	case value != nil:
		return protocol.ScoreDataTypeNumeric
	case category != "":
		return protocol.ScoreDataTypeCategory
	case boolValue != nil:
		return protocol.ScoreDataTypeBoolean
	default:
		return ""
	}
}

// scoreValueDisplay renders the value slot for tool output.
func scoreValueDisplay(in scores.Input) string {
	switch in.DataType {
	case protocol.ScoreDataTypeNumeric:
		if in.Value != nil {
			return strconv.FormatFloat(*in.Value, 'g', -1, 64)
		}
	case protocol.ScoreDataTypeCategory:
		return in.StringValue
	case protocol.ScoreDataTypeBoolean:
		if in.BoolValue != nil {
			return strconv.FormatBool(*in.BoolValue)
		}
	}
	return ""
}

type listScoresArgs struct {
	WorkstreamID string `json:"workstream_id"`
	TargetType   string `json:"target_type,omitempty"`
	TargetID     string `json:"target_id,omitempty"`
	Name         string `json:"name,omitempty"`
}

// toolListScores derives the score read model for a workstream and returns
// the deterministic, optionally filtered view.
func toolListScores(db *storage.DB) func(context.Context, json.RawMessage) (any, error) {
	return func(ctx context.Context, args json.RawMessage) (any, error) {
		var in listScoresArgs
		if e := decodeStrict(args, "arguments", &in); e != nil {
			return nil, e
		}
		_, events, e := loadWorkstream(ctx, db, in.WorkstreamID)
		if e != nil {
			return nil, e
		}
		all := scores.Materialize(events)
		out := make([]*protocol.Score, 0, len(all))
		for _, s := range all {
			if in.TargetType != "" && string(s.TargetType) != strings.ToLower(in.TargetType) {
				continue
			}
			if in.TargetID != "" && s.TargetID != in.TargetID {
				continue
			}
			if in.Name != "" && s.Name != in.Name {
				continue
			}
			out = append(out, s)
		}
		return map[string]any{"scores": out, "count": len(out)}, nil
	}
}
