// Package datasets implements versioned evaluation datasets and
// reproducible experiments over them (parity row 27), local-first.
//
// A dataset is a named, immutable, content-addressed version of example
// files (session fixture JSONL). The version hash is the content hash of
// the sorted (name, file-hash) pairs — hash-pinned, exactly like the
// datasets Langfuse/Phoenix model, but the "task" is our own deterministic
// machinery: materialize each example, run the detection pack, record a
// per-example verdict. Re-running an experiment on the same dataset version
// is deterministic; comparing two runs exposes regressions.
//
// Everything derives from dataset.created / experiment.recorded events on
// the append-only spine; bodies (the example files) live in the
// content-addressed object store.
package datasets

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func sha256Sum(data []byte) []byte {
	sum := sha256.Sum256(data)
	return sum[:]
}

func hexEncode(b []byte) string { return hex.EncodeToString(b) }

// maxFileBytes caps one example file (fail-closed beyond).
const maxFileBytes = 8 << 20 // 8 MiB

// InputFile is one candidate example: a name plus raw JSONL bytes.
type InputFile struct {
	Name string
	Data []byte
}

// FileEntry is one validated example inside a dataset version.
type FileEntry struct {
	Name       string `json:"name"`
	Hash       string `json:"hash"`
	EventCount int    `json:"event_count"`
}

// Version is an immutable dataset version.
type Version struct {
	Name    string      `json:"name"`
	Version string      `json:"version"` // content hash of the manifest
	Files   []FileEntry `json:"files"`
}

// ValidateFile enforces the fail-closed example contract: valid UTF-8, JSONL
// events that decode, size cap. It returns the event count and file hash
// (sha256 over the exact bytes — replays must be byte-identical).
func ValidateFile(data []byte) (int, string, error) {
	if len(data) == 0 {
		return 0, "", fmt.Errorf("example file is empty")
	}
	if len(data) > maxFileBytes {
		return 0, "", fmt.Errorf("example file exceeds %d bytes", maxFileBytes)
	}
	if !utf8.Valid(data) {
		return 0, "", fmt.Errorf("example file is not valid UTF-8")
	}
	count := 0
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var ev protocol.Event
		if err := json.Unmarshal(line, &ev); err != nil {
			return 0, "", fmt.Errorf("line %d: %w", count+1, err)
		}
		count++
	}
	if err := sc.Err(); err != nil {
		return 0, "", err
	}
	return count, hashHex(data), nil
}

// BuildVersion validates every input file and hashes the manifest. Files
// are sorted by name so insertion order never changes the version hash.
func BuildVersion(name string, files []InputFile) (*Version, error) {
	if strings.TrimSpace(name) == "" {
		return nil, fmt.Errorf("dataset name is required")
	}
	entries := make([]FileEntry, 0, len(files))
	for _, f := range files {
		if strings.TrimSpace(f.Name) == "" {
			return nil, fmt.Errorf("example name is required")
		}
		count, hash, err := ValidateFile(f.Data)
		if err != nil {
			return nil, fmt.Errorf("example %s: %w", f.Name, err)
		}
		entries = append(entries, FileEntry{Name: f.Name, Hash: hash, EventCount: count})
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("a dataset needs at least one example")
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	manifest, err := json.Marshal(entries)
	if err != nil {
		return nil, err
	}
	return &Version{Name: name, Version: hashHex(manifest), Files: entries}, nil
}

// DatasetRecord is the derived view of one dataset.created event.
type DatasetRecord struct {
	EventID   string      `json:"event_id"`
	Name      string      `json:"name"`
	Version   string      `json:"version"`
	Files     []FileEntry `json:"files"`
	CreatedAt time.Time   `json:"created_at"`
}

// Materialize derives dataset records (sorted by created_at, then event id).
func Materialize(events []*protocol.Event) []DatasetRecord {
	out := []DatasetRecord{}
	for _, ev := range events {
		if ev.Kind != protocol.EventDatasetCreated {
			continue
		}
		var p struct {
			Name    string      `json:"name"`
			Version string      `json:"version"`
			Files   []FileEntry `json:"files"`
		}
		if json.Unmarshal(ev.Payload, &p) != nil || p.Name == "" || p.Version == "" {
			continue
		}
		out = append(out, DatasetRecord{
			EventID: ev.EventID, Name: p.Name, Version: p.Version,
			Files: p.Files, CreatedAt: ev.OccurredAt,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.Before(out[j].CreatedAt)
		}
		return out[i].EventID < out[j].EventID
	})
	return out
}

// LatestByName returns the newest record per dataset name.
func LatestByName(records []DatasetRecord) map[string]DatasetRecord {
	latest := map[string]DatasetRecord{}
	for _, r := range records { // materialize order: ascending time
		latest[r.Name] = r
	}
	return latest
}

// ExampleResult is the outcome of running one example through the
// deterministic experiment task.
type ExampleResult struct {
	Name         string `json:"name"`
	Hash         string `json:"hash"`
	Events       int    `json:"events"`
	Traces       int    `json:"traces"`
	Spans        int    `json:"spans"`
	P0Detections int    `json:"p0_detections"`
	Status       string `json:"status"` // ok | detections | invalid
}

// ExperimentRecord is the derived view of one experiment.recorded event.
type ExperimentRecord struct {
	EventID   string          `json:"event_id"`
	Dataset   string          `json:"dataset"`
	Version   string          `json:"version"`
	Passed    bool            `json:"passed"`
	Results   []ExampleResult `json:"results"`
	CreatedAt time.Time       `json:"created_at"`
}

// MaterializeExperiments derives experiment records (sorted, deterministic).
func MaterializeExperiments(events []*protocol.Event) []ExperimentRecord {
	out := []ExperimentRecord{}
	for _, ev := range events {
		if ev.Kind != protocol.EventExperimentRecorded {
			continue
		}
		var r ExperimentRecord
		if json.Unmarshal(ev.Payload, &r) != nil || r.Dataset == "" || r.Version == "" {
			continue
		}
		r.EventID = ev.EventID
		r.CreatedAt = ev.OccurredAt
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.Before(out[j].CreatedAt)
		}
		return out[i].EventID < out[j].EventID
	})
	return out
}

// Compare diffs two experiment runs by example name. A regression is a
// status downgrade or a new P0 detection.
type Comparison struct {
	File       string `json:"file"`
	FromStatus string `json:"from_status"`
	ToStatus   string `json:"to_status"`
	FromP0     int    `json:"from_p0"`
	ToP0       int    `json:"to_p0"`
	Regression bool   `json:"regression"`
}

// Compare runs a and b (a is the older/baseline run).
func Compare(a, b ExperimentRecord) []Comparison {
	byName := map[string]ExampleResult{}
	for _, r := range a.Results {
		byName[r.Name] = r
	}
	out := []Comparison{}
	names := make([]string, 0, len(b.Results))
	for _, r := range b.Results {
		names = append(names, r.Name)
	}
	sort.Strings(names)
	for _, name := range names {
		br := b.Results[indexOf(b.Results, name)]
		ar, existed := byName[name]
		if !existed {
			continue
		}
		c := Comparison{
			File: name, FromStatus: ar.Status, ToStatus: br.Status,
			FromP0: ar.P0Detections, ToP0: br.P0Detections,
			Regression: rankStatus(br.Status) > rankStatus(ar.Status) || br.P0Detections > ar.P0Detections,
		}
		out = append(out, c)
	}
	return out
}

func rankStatus(s string) int {
	switch s {
	case "ok":
		return 0
	case "detections":
		return 1
	default:
		return 2
	}
}

func indexOf(rs []ExampleResult, name string) int {
	for i := range rs {
		if rs[i].Name == name {
			return i
		}
	}
	return -1
}

func hashHex(data []byte) string {
	sum := sha256Sum(data)
	return "sha256:" + hexEncode(sum)
}
