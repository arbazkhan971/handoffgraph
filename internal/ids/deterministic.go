package ids

import (
	"bytes"
	"crypto/sha256"

	"github.com/oklog/ulid/v2"
)

// EventDeterministic returns evt_<ulid> where the ULID is derived
// deterministically from key and timestampMS: same inputs yield the same ID,
// always. The ULID timestamp is timestampMS (clamped to 0 when it would make
// the ULID invalid) and the 80-bit entropy is the first 10 bytes of
// sha256(key). It never panics: ulid.New errors are folded into a zero-time
// ULID, which remains a valid identifier.
//
// Use this for re-import idempotency (e.g. adapter normalization), never for
// genuinely fresh durable records.
func EventDeterministic(key string, timestampMS uint64) string {
	if timestampMS > ulid.MaxTime() {
		// A timestamp beyond the ULID-representable range would fail
		// construction; clamp to epoch so derivation stays total.
		timestampMS = 0
	}
	hash := sha256.Sum256([]byte(key))
	id, err := ulid.New(timestampMS, bytes.NewReader(hash[:10]))
	if err != nil {
		// Unreachable given the clamps above (the entropy reader always
		// yields exactly EncodedEntropy bytes), but stay total rather than
		// panic: fall back to an all-zero-entropy ULID at the clamped time.
		var fallback ulid.ULID
		_ = fallback.SetTime(timestampMS)
		return PrefixEvent + fallback.String()
	}
	return PrefixEvent + id.String()
}
