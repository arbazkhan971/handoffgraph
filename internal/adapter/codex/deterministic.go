package codex

import (
	"strconv"
	"strings"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/ids"
)

// deriveEventID returns a stable event ID for one normalized native line.
//
// The ID is a pure function of (nativeSessionID, seq, occurredAt,
// contentHash), so re-importing the same rollout stream yields identical
// event IDs and the event store's event_id-unique idempotency holds. The
// content hash is included so two lines that differ only in content never
// collide, and the sequence number keeps repeated identical lines distinct.
//
// An empty nativeSessionID is allowed: the key stays deterministic. Note
// that buildEvent routes empty IDs to random ids.Event() instead (see
// codex.go), so deriveEventID is only called with a non-empty session id.
//
// Stability across re-import holds only while the rollout's line order is
// unchanged: inserting a line mid-file shifts the sequence number of every
// subsequent line, forking their event IDs. A re-import after such an edit
// may therefore add duplicate events rather than dedupe — an acceptable
// v0.2.x tradeoff.
func deriveEventID(nativeSessionID string, seq int64, occurredAt time.Time, contentHash string) string {
	ms := occurredAt.UnixMilli()
	if ms < 0 {
		ms = 0
	}
	key := strings.Join([]string{
		"codex",
		nativeSessionID,
		strconv.FormatInt(seq, 10),
		strconv.FormatInt(ms, 10),
		contentHash,
	}, "|")
	return ids.EventDeterministic(key, uint64(ms))
}
