// Package verify implements the fixture verification harness used by
// `handoffgraph fixture verify`. It lives outside the fixture package so it
// may import storage and graph without creating an import cycle.
package verify

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/handoffgraph/handoffgraph/internal/graph"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// NormalizeFn converts a native provider rollout stream into canonical
// events. Adapters supply their implementation via VerifyOptions so this
// package stays independent of concrete adapters.
type NormalizeFn func(ctx context.Context, r io.Reader) ([]protocol.Event, error)

// Result reports the outcome of verifying a fixture directory.
type Result struct {
	FilesChecked int      `json:"files_checked"`
	Events       int      `json:"events"`
	Failures     []string `json:"failures,omitempty"`
	// Skipped lists native-format files that were not verified because no
	// normalizer was supplied (see VerifyOptions.NormalizeNative).
	Skipped []string `json:"skipped,omitempty"`
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
	// FormatUnknown covers files with no parseable line: neither canonical
	// nor native codex, they fail verification rather than importing as
	// degenerate zero-value events.
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
		}
		if json.Unmarshal([]byte(line), &probe) != nil {
			continue // not JSON at all; keep looking for a parseable line
		}
		if probe.SchemaVersion == protocol.SchemaVersionEvent && strings.HasPrefix(probe.EventID, ids.PrefixEvent) {
			return FormatCanonical
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

// verifyNativeCodex runs a NATIVE-ROLLOUT normalizer over a native rollout
// file and reports per-file checks as verification failures (nil when
// clean). It never touches the event store: native rollout lines are NOT
// canonical events and must not be imported as degenerate zero-value rows.
// The normalizer is injected by the caller (adapter tests) so this package
// stays independent of concrete adapters.
func verifyNativeCodex(ctx context.Context, path string, normalize NormalizeFn) []error {
	f, err := os.Open(path)
	if err != nil {
		return []error{err}
	}
	defer f.Close()

	first, err := normalize(ctx, f)
	if err != nil {
		return []error{fmt.Errorf("native normalize: %w", err)}
	}
	if len(first) == 0 {
		return []error{errors.New("native normalize produced no events")}
	}
	for i := range first {
		ev := &first[i]
		if ev.Provider != protocol.ProviderCodex {
			return []error{fmt.Errorf("event %d: provider = %q, want %q", i+1, ev.Provider, protocol.ProviderCodex)}
		}
		if ev.Provenance != protocol.ProvenanceObserved {
			return []error{fmt.Errorf("event %d (%s): provenance = %q, want OBSERVED", i+1, ev.Kind, ev.Provenance)}
		}
	}

	// IDs must be stable across two Normalize passes (re-import idempotency).
	f2, err := os.Open(path)
	if err != nil {
		return []error{err}
	}
	defer f2.Close()
	second, err := normalize(ctx, f2)
	if err != nil {
		return []error{fmt.Errorf("native normalize (second pass): %w", err)}
	}
	if len(second) != len(first) {
		return []error{fmt.Errorf("normalize passes disagree on count: %d vs %d", len(first), len(second))}
	}
	for i := range first {
		if first[i].EventID != second[i].EventID {
			return []error{fmt.Errorf("event %d id unstable across passes: %s vs %s", i+1, first[i].EventID, second[i].EventID)}
		}
	}
	return nil
}

// VerifyOptions tunes Verify. Zero value verifies canonical fixtures only.
type VerifyOptions struct {
	// NormalizeNative, when set, verifies native rollout files through the
	// provider normalizer instead of skipping them.
	NormalizeNative NormalizeFn
}

// Verify classifies every .jsonl file under dir and verifies it according to
// its format: canonical hfg.event.v1 fixtures are imported into a fresh
// temporary database and must survive ingestion, graph rebuild, and trace
// materialization deterministically; native codex rollout files are verified
// through VerifyOptions.NormalizeNative instead (never imported into the
// event store). It never writes to the user's real database.
func Verify(ctx context.Context, dir string, opts ...VerifyOptions) (*Result, error) {
	res := &Result{}
	var normalize NormalizeFn
	if len(opts) > 0 {
		normalize = opts[0].NormalizeNative
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
			// Native provider rollout: verify through the injected normalizer,
			// never through the event store (zero-value import would collapse
			// every line onto one row via event_id UNIQUE dedup). Without a
			// normalizer the file is reported as skipped, not failed.
			if normalize == nil {
				res.Skipped = append(res.Skipped, base)
				continue
			}
			if errs := verifyNativeCodex(ctx, f, normalize); len(errs) > 0 {
				for _, e := range errs {
					res.Failures = append(res.Failures, fmt.Sprintf("%s: %v", base, e))
				}
				continue
			}
			res.Events += 1
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
				fmt.Sprintf("%s: unrecognized JSONL format (neither %s nor %s)", base, FormatCanonical, FormatNativeCodex))
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
