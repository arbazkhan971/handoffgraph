// Package ids provides the identifier primitives used across HandoffGraph.
//
// Every durable identifier (event, workstream, session, trace, span,
// checkpoint, repository, handoff) is a ULID: lexicographically sortable by
// creation time, safe to generate concurrently, and string-friendly in JSON.
package ids

import (
	"crypto/rand"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/oklog/ulid/v2"
)

// Prefixes used to make identifiers self-describing. The ULID remains intact
// after the prefix, so the sortable property is preserved within a type.
const (
	PrefixEvent      = "evt_"
	PrefixWorkstream = "ws_"
	PrefixSession    = "ses_"
	PrefixTrace      = "trc_"
	PrefixSpan       = "spn_"
	PrefixCheckpoint = "cp_"
	PrefixRepo       = "repo_"
	PrefixHandoff    = "ho_"
)

var (
	entropy = &lockedEntropy{}
)

// lockedEntropy wraps a cryptographically secure random source so ULID
// generation is safe for concurrent use.
type lockedEntropy struct {
	mu  sync.Mutex
	src *ulid.MonotonicEntropy
}

func (e *lockedEntropy) Read(p []byte) (int, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.ensureSource()
	return e.src.Read(p)
}

// MonotonicRead preserves the oklog/ulid MonotonicReader contract through
// our locking wrapper. Without this method ulid.New only sees io.Reader and
// bypasses same-millisecond monotonic entropy, so sequential IDs can sort in
// reverse order even though ULIDs are required to be lexicographically
// creation-ordered.
func (e *lockedEntropy) MonotonicRead(ms uint64, p []byte) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.ensureSource()
	return e.src.MonotonicRead(ms, p)
}

func (e *lockedEntropy) ensureSource() {
	if e.src == nil {
		e.src = ulid.Monotonic(rand.Reader, 0)
	}
}

// New returns a fresh ULID string with no prefix.
func New() string {
	return ulid.MustNew(ulid.Timestamp(time.Now()), entropy).String()
}

// NewPrefixed returns a fresh ULID string with the given prefix.
func NewPrefixed(prefix string) string {
	return prefix + New()
}

// Event returns a fresh event identifier.
func Event() string { return NewPrefixed(PrefixEvent) }

// Workstream returns a fresh workstream identifier.
func Workstream() string { return NewPrefixed(PrefixWorkstream) }

// Session returns a fresh session identifier.
func Session() string { return NewPrefixed(PrefixSession) }

// Trace returns a fresh trace identifier.
func Trace() string { return NewPrefixed(PrefixTrace) }

// Span returns a fresh span identifier.
func Span() string { return NewPrefixed(PrefixSpan) }

// Checkpoint returns a fresh checkpoint identifier.
func Checkpoint() string { return NewPrefixed(PrefixCheckpoint) }

// Repository returns a fresh repository identifier.
func Repository() string { return NewPrefixed(PrefixRepo) }

// Handoff returns a fresh handoff identifier.
func Handoff() string { return NewPrefixed(PrefixHandoff) }

// IsValid reports whether id is a well-formed HandoffGraph identifier:
// an optional known prefix followed by a valid ULID.
func IsValid(id string) bool {
	core := id
	switch {
	case strings.HasPrefix(id, PrefixEvent):
		core = id[len(PrefixEvent):]
	case strings.HasPrefix(id, PrefixWorkstream):
		core = id[len(PrefixWorkstream):]
	case strings.HasPrefix(id, PrefixSession):
		core = id[len(PrefixSession):]
	case strings.HasPrefix(id, PrefixTrace):
		core = id[len(PrefixTrace):]
	case strings.HasPrefix(id, PrefixSpan):
		core = id[len(PrefixSpan):]
	case strings.HasPrefix(id, PrefixCheckpoint):
		core = id[len(PrefixCheckpoint):]
	case strings.HasPrefix(id, PrefixRepo):
		core = id[len(PrefixRepo):]
	case strings.HasPrefix(id, PrefixHandoff):
		core = id[len(PrefixHandoff):]
	}
	_, err := ulid.ParseStrict(core)
	return err == nil
}

// Validate returns an error if id is not a well-formed identifier.
func Validate(id string) error {
	if IsValid(id) {
		return nil
	}
	return fmt.Errorf("invalid identifier %q", id)
}
