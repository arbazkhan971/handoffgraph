package claude

import (
	"strconv"
	"strings"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/ids"
)

// deriveEventID returns a stable event ID for one normalized Claude
// payload expansion.
//
// The ID is a pure function of (nativeSessionID, seq, occurredAt,
// contentHash), so re-importing the same payload yields identical event IDs
// and the event store's event_id-unique idempotency holds. The provider
// name prefixes the key so a claude payload and a codex line can never
// collide; the content hash keeps two same-position events with different
// bodies distinct; the sequence keeps repeated identical payloads distinct
// within one stream.
//
// Callers reach this helper whenever the payload identifies its session.
// Missing native timestamps remain the zero time, while the canonical native
// payload hash still makes retries deterministic and keeps distinct callback
// bodies separate. Payloads without a session get fresh random IDs because a
// deterministic key over an unknown session could silently merge evidence.
func deriveEventID(nativeSessionID string, seq int64, occurredAt time.Time, contentHash string) string {
	ms := occurredAt.UnixMilli()
	if ms < 0 {
		ms = 0
	}
	key := strings.Join([]string{
		"claude",
		nativeSessionID,
		strconv.FormatInt(seq, 10),
		strconv.FormatInt(ms, 10),
		contentHash,
	}, "|")
	return ids.EventDeterministic(key, uint64(ms))
}
