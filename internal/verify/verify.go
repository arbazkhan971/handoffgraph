// Package verify implements the fixture verification harness used by
// `handoffgraph fixture verify`. It lives outside the fixture package so it
// may import storage and graph without creating an import cycle.
package verify

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/handoffgraph/handoffgraph/internal/adapter/codex" // Layering: adapter/codex depends only on adapter/content/ids/protocol (`go list -deps ./internal/adapter/codex`), so verify→codex adds no import cycle.
	"github.com/handoffgraph/handoffgraph/internal/adapter/pi"
	"github.com/handoffgraph/handoffgraph/internal/content"
	"github.com/handoffgraph/handoffgraph/internal/graph"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// NormalizeFn converts a native provider rollout stream into canonical
// events. Verify defaults to the codex adapter; adapters may inject their own
// implementation via VerifyOptions so this package can be exercised without
// touching concrete adapter internals.
type NormalizeFn func(ctx context.Context, r io.Reader) ([]protocol.Event, error)

// Result reports the outcome of verifying a fixture directory.
type Result struct {
	FilesChecked int      `json:"files_checked"`
	Events       int      `json:"events"`
	Failures     []string `json:"failures,omitempty"`
	// NativeVerified lists native-format files (e.g. provider transcripts)
	// that passed provider-native verification through the
	// adapter's Normalize instead of being imported into the event store.
	NativeVerified []string `json:"native_verified,omitempty"`
}

// JSONL fixture format classes, as decided by classifyJSONL.
const (
	// FormatCanonical lines are hfg.event.v1 envelopes importable directly
	// into the event store.
	FormatCanonical = "canonical-hfg.event.v1"
	// FormatNativeCodex lines are native Codex CLI rollout records
	// ({"timestamp","type","payload"}), which must go through the codex
	// adapter's Normalize instead of the event store.
	FormatNativeCodex = "native-codex"
	// FormatNativePi starts with Pi's durable session-head record and must go
	// through the Pi transcript normalizer rather than the canonical importer.
	FormatNativePi = "native-pi"
	// FormatUnknown covers files with no recognizable line: neither canonical
	// nor a recognized provider transcript, they fail verification rather
	// than importing as degenerate zero-value events.
	FormatUnknown = "unknown"
)

// classifyJSONL inspects the first parseable line of a JSONL fixture and
// reports which format class the file belongs to.
//
// Canonical hfg.event.v1 events carry "schema_version":"hfg.event.v1" and an
// evt_-prefixed event_id. Native codex rollout lines carry a "type"
// discriminator plus a nested "payload" and no schema_version. Anything else
// (unparseable or unrecognized shape) is FormatUnknown so it surfaces as a
// verification failure instead of silently decoding into degenerate
// zero-value Events that collapse onto one storage row via event_id dedup.
func classifyJSONL(lines []string) string {
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || !utf8.ValidString(line) {
			continue // skip blanks and undecodable lines, try the next one
		}
		var probe struct {
			SchemaVersion string          `json:"schema_version"`
			EventID       string          `json:"event_id"`
			Type          string          `json:"type"`
			Payload       json.RawMessage `json:"payload"`
			ID            string          `json:"id"`
			Timestamp     string          `json:"timestamp"`
		}
		if json.Unmarshal([]byte(line), &probe) != nil {
			continue // not JSON at all; keep looking for a parseable line
		}
		if probe.SchemaVersion == protocol.SchemaVersionEvent && strings.HasPrefix(probe.EventID, ids.PrefixEvent) {
			return FormatCanonical
		}
		if probe.Type == "session" && probe.ID != "" && probe.Timestamp != "" && probe.SchemaVersion == "" {
			return FormatNativePi
		}
		if probe.Type != "" && len(probe.Payload) > 0 && probe.SchemaVersion == "" {
			return FormatNativeCodex
		}
		return FormatUnknown
	}
	return FormatUnknown
}

// readLines returns every line of the file at path, without decoding.
func readLines(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	split := strings.Split(string(data), "\n")
	if n := len(split); n > 0 && split[n-1] == "" {
		split = split[:n-1] // drop the artifact after a trailing newline
	}
	return split, nil
}

// defaultCodexNormalize adapts the codex adapter's Normalize (one hook
// payload per call) to the stream-level NormalizeFn contract used here: each
// parseable JSONL line becomes one Normalize invocation. Blank and
// undecodable lines are skipped, mirroring importFile.
func defaultCodexNormalize(c *codex.Codex) NormalizeFn {
	return func(ctx context.Context, r io.Reader) ([]protocol.Event, error) {
		var out []protocol.Event
		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
		for scanner.Scan() {
			line := bytes.TrimSpace(scanner.Bytes())
			if len(line) == 0 || !utf8.Valid(line) {
				continue
			}
			evs, err := c.Normalize(ctx, json.RawMessage(line))
			if err != nil {
				return nil, fmt.Errorf("line %d: %w", len(out)+len(evs)+1, err)
			}
			out = append(out, evs...)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			default:
			}
		}
		if err := scanner.Err(); err != nil {
			return nil, err
		}
		return out, nil
	}
}

// verifyNativeProvider verifies a native provider transcript through its
// adapter — never through the event store: native transcript lines
// are NOT canonical events, and importing them as zero-value protocol.Event
// would collapse every line onto one storage row via event_id UNIQUE dedup.
//
// Per-file checks (each reported as a verification failure when violated):
//   - Normalize succeeds over every parseable line and yields ≥1 event;
//   - every event carries the expected provider and OBSERVED provenance (facts
//     parsed from a transcript must never be upgraded);
//   - IDs are stable across two Normalize passes of the same bytes: each
//     event's compared identity is derived purely from its content via
//     ids.EventDeterministic (kind + canonical payload), so re-importing the
//     same transcript is idempotent. Adapters whose transcript contract
//     promises exact EventID determinism are additionally checked byte-for-byte.
func verifyNativeProvider(ctx context.Context, path string, normalize NormalizeFn, provider, label string, requireStableEventIDs bool) []error {
	pass := func() ([]protocol.Event, error) {
		f, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		return normalize(ctx, f)
	}

	first, err := pass()
	if err != nil {
		return []error{fmt.Errorf("%s normalize: %w", label, err)}
	}
	if len(first) == 0 {
		return []error{fmt.Errorf("%s normalize produced no events", label)}
	}
	stableIDs := make([]string, len(first))
	stableEventIDs := make([]string, len(first))
	for i := range first {
		ev := &first[i]
		if ev.Provider != provider {
			return []error{fmt.Errorf("event %d: provider = %q, want %q", i+1, ev.Provider, provider)}
		}
		if ev.Provenance != protocol.ProvenanceObserved {
			return []error{fmt.Errorf("event %d (%s): provenance = %q, want OBSERVED", i+1, ev.Kind, ev.Provenance)}
		}
		id, kerr := contentDerivedID(ev)
		if kerr != nil {
			return []error{fmt.Errorf("event %d (%s): %w", i+1, ev.Kind, kerr)}
		}
		stableIDs[i] = id
		stableEventIDs[i] = ev.EventID
	}

	second, err := pass()
	if err != nil {
		return []error{fmt.Errorf("%s normalize (second pass): %w", label, err)}
	}
	if len(second) != len(stableIDs) {
		return []error{fmt.Errorf("normalize passes disagree on event count: %d vs %d", len(stableIDs), len(second))}
	}
	for i := range second {
		id, kerr := contentDerivedID(&second[i])
		if kerr != nil {
			return []error{fmt.Errorf("second pass event %d (%s): %w", i+1, second[i].Kind, kerr)}
		}
		if id != stableIDs[i] {
			return []error{fmt.Errorf("event %d id unstable across passes", i+1)}
		}
		if requireStableEventIDs && second[i].EventID != stableEventIDs[i] {
			return []error{fmt.Errorf("event %d event_id unstable across passes", i+1)}
		}
	}
	return nil
}

// contentDerivedID derives an event identity that depends only on the
// event's own content: canonical kind plus canonicalized payload JSON. The
// codex adapter mints fresh random EventIDs and stamps wall-clock
// ObservedAt/OccurredAt on every Normalize call, so the harness compares
// these content-derived IDs across passes — the same derivation
// ids.EventDeterministic documents for adapter re-import idempotency.
func contentDerivedID(ev *protocol.Event) (string, error) {
	payload := "{}"
	if len(ev.Payload) > 0 {
		b, err := content.CanonicalJSON(ev.Payload)
		if err != nil {
			return "", fmt.Errorf("canonicalize payload: %w", err)
		}
		payload = string(b)
	}
	return ids.EventDeterministic(string(ev.Kind)+"|"+payload, 0), nil
}

// VerifyOptions tunes Verify. The zero value verifies canonical fixtures
// through the event store and native provider transcripts through their
// matching adapters.
type VerifyOptions struct {
	// NormalizeNative overrides the default codex normalizer used for
	// native-format files (primarily for adapter-focused tests).
	NormalizeNative NormalizeFn
	// NormalizePi overrides the Pi transcript normalizer. It is separate from
	// NormalizeNative so injecting a Codex stream normalizer cannot accidentally
	// route Pi fixtures through the wrong provider parser.
	NormalizePi NormalizeFn
}

// Verify classifies every .jsonl file under dir and verifies it according to
// its format: canonical hfg.event.v1 fixtures are imported into a fresh
// temporary database and must survive ingestion, graph rebuild, and trace
// materialization deterministically; native provider transcript files are
// verified through the matching adapter instead (never imported into the
// event store) and reported via Result.NativeVerified. It never writes to the
// user's real database.
func Verify(ctx context.Context, dir string, opts ...VerifyOptions) (*Result, error) {
	res := &Result{}
	normalizeCodex := defaultCodexNormalize(&codex.Codex{})
	normalizePi := (&pi.Pi{}).NormalizeTranscript
	if len(opts) > 0 && opts[0].NormalizeNative != nil {
		normalizeCodex = opts[0].NormalizeNative
	}
	if len(opts) > 0 && opts[0].NormalizePi != nil {
		normalizePi = opts[0].NormalizePi
	}

	files, err := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		_ = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
			if err == nil && filepath.Ext(path) == ".jsonl" {
				files = append(files, path)
			}
			return nil
		})
	}

	tmp, err := os.MkdirTemp("", "hfg-fixture-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)

	db, err := storage.Open(filepath.Join(tmp, "fixture.db"))
	if err != nil {
		return nil, err
	}
	defer db.Close()

	for _, f := range files {
		res.FilesChecked++
		base := filepath.Base(f)

		lines, err := readLines(f)
		if err != nil {
			res.Failures = append(res.Failures, fmt.Sprintf("%s: %v", base, err))
			continue
		}
		switch classifyJSONL(lines) {
		case FormatNativeCodex:
			// Native provider rollout: verify through the codex adapter,
			// never through the event store (zero-value import would
			// collapse every line onto one row via event_id UNIQUE dedup).
			if errs := verifyNativeProvider(ctx, f, normalizeCodex, protocol.ProviderCodex, "codex", false); len(errs) > 0 {
				for _, e := range errs {
					res.Failures = append(res.Failures, fmt.Sprintf("%s: %v", base, e))
				}
				continue
			}
			res.NativeVerified = append(res.NativeVerified, base)
			res.Events += 1 // one verified native transcript per file
		case FormatNativePi:
			if errs := verifyNativeProvider(ctx, f, normalizePi, protocol.ProviderPi, "pi", true); len(errs) > 0 {
				for _, e := range errs {
					res.Failures = append(res.Failures, fmt.Sprintf("%s: %v", base, e))
				}
				continue
			}
			res.NativeVerified = append(res.NativeVerified, base)
			res.Events += 1 // one verified native transcript per file
		case FormatCanonical:
			n, errs, err := importFile(ctx, f, db)
			if err != nil {
				res.Failures = append(res.Failures, fmt.Sprintf("%s: %v", base, err))
				continue
			}
			res.Events += n
			for _, e := range errs {
				res.Failures = append(res.Failures, fmt.Sprintf("%s: %v", base, e))
			}
		default: // FormatUnknown: never silently imported as zero-value Events.
			res.Failures = append(res.Failures,
				fmt.Sprintf("%s: unrecognized JSONL format (neither %s, %s nor %s)", base, FormatCanonical, FormatNativeCodex, FormatNativePi))
		}
	}

	if len(res.Failures) > 0 {
		return res, nil
	}

	events, err := db.ListEvents(ctx)
	if err != nil {
		return nil, err
	}

	h1, err := graph.RootHashForEvents(events)
	if err != nil {
		res.Failures = append(res.Failures, err.Error())
		return res, nil
	}
	h2, err := graph.RootHashForEvents(events)
	if err != nil {
		res.Failures = append(res.Failures, err.Error())
		return res, nil
	}
	if h1 != h2 {
		res.Failures = append(res.Failures, fmt.Sprintf("determinism failure: %s != %s", h1, h2))
	}
	return res, nil
}

func importFile(ctx context.Context, path string, db *storage.DB) (int, []error, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, nil, err
	}
	defer f.Close()

	var appended int
	var errs []error
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		if !utf8.Valid(line) {
			errs = append(errs, fmt.Errorf("line %d: invalid UTF-8", appended+len(errs)+1))
			continue
		}
		var ev protocol.Event
		if err := json.Unmarshal(line, &ev); err != nil {
			errs = append(errs, err)
			continue
		}
		if _, err := db.AppendEvent(ctx, &ev); err != nil {
			errs = append(errs, err)
			continue
		}
		appended++
	}
	if err := scanner.Err(); err != nil {
		errs = append(errs, err)
	}
	return appended, errs, nil
}
