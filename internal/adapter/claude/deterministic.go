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
// Callers only reach this helper when the payload identified both its
// session and its time; payloads missing either get fresh random ids
// (see buildEvent) because a deterministic key over unknown dimensions
// would let two different sessions collide on one event id and silently
// drop evidence on re-import.
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
