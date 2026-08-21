package codex

import (
	"strconv"
	"strings"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/ids"
)

// deriveEventID returns a stable event ID for one normalized codex record.
//
// The ID is a pure function of (nativeSessionID, seq, occurredAt,
// contentHash), so re-importing the same payload yields identical event
// IDs and the event store's event_id-unique idempotency holds. The
// provider name prefixes the key so a codex record and a claude payload can
// never collide; the content hash keeps two same-position events with
// different bodies distinct; the sequence keeps repeated identical records
// distinct within one stream.
//
// occurredAt may be zero: rollout-derived records always carry a
// timestamp, but hook payloads do not, and deriving their key from the
// wall clock would make re-import non-idempotent. A zero time derives an
// epoch-time ULID, keeping the ID a pure function of content.
//
// Callers only reach this helper with a non-empty nativeSessionID;
// unidentifiable records get fresh random ids instead (see Normalize),
// because a deterministic key over unknown dimensions would let two
// different sessions collide on one event id and silently drop evidence on
// re-import.
func deriveEventID(nativeSessionID string, seq int64, occurredAt time.Time, contentHash string) string {
	ms := int64(0)
	if !occurredAt.IsZero() {
		ms = occurredAt.UnixMilli()
	}
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
