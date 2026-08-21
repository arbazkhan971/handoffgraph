package protocol

// Checkpoint is the portable, bounded state package (hfg.checkpoint.v1).
//
// A checkpoint is evidence-first: every list item that can be evidenced
// carries references to the events that support it. Fields produced by a
// model must be marked with ProvenanceInferred.
type Checkpoint struct {
	SchemaVersion string `json:"schema_version"`
	CheckpointID  string `json:"checkpoint_id"`
	WorkstreamID  string `json:"workstream_id"`
	Objective     string `json:"objective"`
	Status        string `json:"status"`

	Repository RepositoryState `json:"repository"`

	SourceSessions []SourceSession `json:"source_sessions"`

	Completed        []EvidenceItem    `json:"completed"`
	Decisions        []Decision        `json:"decisions"`
	Files            []FileEvidence    `json:"files"`
	Commands         []CommandEvidence `json:"commands"`
	Tests            []TestEvidence    `json:"tests"`
	FailedApproaches []EvidenceItem    `json:"failed_approaches"`
	Constraints      []EvidenceItem    `json:"constraints"`
	OpenQuestions    []EvidenceItem    `json:"open_questions"`
	NextActions      []EvidenceItem    `json:"next_actions"`

	Integrity Integrity `json:"integrity"`
}

// RepositoryState captures the exact repository identity and worktree state
// at checkpoint time.
type RepositoryState struct {
	Remote string `json:"remote,omitempty"`
	Branch string `json:"branch,omitempty"`
	Head   string `json:"head,omitempty"`
	Dirty  bool   `json:"dirty"`
}

// SourceSession records the native session that contributed evidence.
type SourceSession struct {
	Provider        string `json:"provider"`
	NativeSessionID string `json:"native_session_id"`
	SessionID       string `json:"session_id,omitempty"`
	LastEventID     string `json:"last_event_id,omitempty"`
}

// EvidenceItem is a statement plus the events that support it.
type EvidenceItem struct {
	Text         string     `json:"text"`
	Provenance   Provenance `json:"provenance,omitempty"`
	EvidenceRefs []string   `json:"evidence_refs,omitempty"`
}

// Decision is an explicit choice with rationale and provenance.
type Decision struct {
	Text         string     `json:"text"`
	Rationale    string     `json:"rationale,omitempty"`
	Provenance   Provenance `json:"provenance,omitempty"`
	EvidenceRefs []string   `json:"evidence_refs,omitempty"`
}

// FileEvidence records a changed file with its observed content hash.
type FileEvidence struct {
	Path         string     `json:"path"`
	Status       string     `json:"status,omitempty"` // created | edited | deleted
	ContentHash  string     `json:"content_hash,omitempty"`
	Provenance   Provenance `json:"provenance,omitempty"`
	EvidenceRefs []string   `json:"evidence_refs,omitempty"`
}

// CommandEvidence records a command and its observed outcome.
type CommandEvidence struct {
	Command       string     `json:"command"`
	ExitCode      *int       `json:"exit_code,omitempty"`
	OutputExcerpt string     `json:"output_excerpt,omitempty"`
	Provenance    Provenance `json:"provenance,omitempty"`
	EvidenceRefs  []string   `json:"evidence_refs,omitempty"`
}

// TestEvidence records a test/build observation with an exit status.
type TestEvidence struct {
	Name          string     `json:"name"`
	Result        string     `json:"result,omitempty"` // passed | failed | skipped | error
	ExitCode      *int       `json:"exit_code,omitempty"`
	OutputExcerpt string     `json:"output_excerpt,omitempty"`
	Provenance    Provenance `json:"provenance,omitempty"`
	EvidenceRefs  []string   `json:"evidence_refs,omitempty"`
}

// Integrity carries the graph root/integrity hash and the score.
type Integrity struct {
	GraphRootHash string `json:"graph_root_hash,omitempty"`
	Score         int    `json:"score,omitempty"`
}
