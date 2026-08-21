// Package ingest implements the crash-safe spool for hook input and the
// JSONL event importer.
//
// Hook adapters write newline-delimited JSON events to a spool file; the
// collector appends them to SQLite and then truncates the spool. This design
// guarantees that a process interruption between hook receipt and database
// commit never loses an event: on startup, the spool is replayed and any
// truncated trailing line is recovered or discarded safely.
package ingest

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
	"unicode/utf8"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// Spool is an append-only newline-delimited event spool file.
type Spool struct {
	path string
	f    *os.File
}

// OpenSpool opens (or creates) the spool file at path in append mode.
func OpenSpool(path string) (*Spool, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	return &Spool{path: path, f: f}, nil
}

// Append writes a single event as one JSON line followed by a newline.
func (s *Spool) Append(ev *protocol.Event) error {
	b, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	if _, err := s.f.Write(append(b, '\n')); err != nil {
		return err
	}
	return s.f.Sync()
}

// Close closes the spool file.
func (s *Spool) Close() error { return s.f.Close() }

// Path returns the spool file path.
func (s *Spool) Path() string { return s.path }

// Import reads a JSONL file (or the spool) and appends each valid event.
// It returns the events appended and any per-line errors. A truncated final
// line is reported via ErrTruncated but does not abort the batch; valid
// preceding lines are still returned so the caller can persist them.
func Import(ctx context.Context, r io.Reader, appendFn func(context.Context, *protocol.Event) (bool, error)) (appended int, errs []error) {
	scanner := bufio.NewScanner(r)
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
			errs = append(errs, fmt.Errorf("line %d: %w", appended+len(errs)+1, err))
			continue
		}
		if _, err := appendFn(ctx, &ev); err != nil {
			errs = append(errs, fmt.Errorf("append %s: %w", ev.EventID, err))
			continue
		}
		appended++
	}
	if err := scanner.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			errs = append(errs, errors.New("line exceeds maximum length"))
		} else {
			errs = append(errs, err)
		}
	}
	return appended, errs
}

// ImportFile imports a JSONL fixture file.
func ImportFile(ctx context.Context, path string, appendFn func(context.Context, *protocol.Event) (bool, error)) (int, []error, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, nil, err
	}
	defer f.Close()
	n, errs := Import(ctx, f, appendFn)
	return n, errs, nil
}

// ReplaySpool drains the spool file into appendFn and truncates it on
// success. If appendFn fails midway, the remaining lines stay in the spool
// and are retried on the next run.
func ReplaySpool(ctx context.Context, path string, appendFn func(context.Context, *protocol.Event) (bool, error)) (int, []error, error) {
	f, err := os.OpenFile(path, os.O_RDWR, 0o600)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil, nil
		}
		return 0, nil, err
	}
	defer f.Close()

	n, errs := Import(ctx, f, appendFn)
	if len(errs) == 0 {
		if err := f.Truncate(0); err != nil {
			return n, errs, err
		}
		if _, err := f.Seek(0, 0); err != nil {
			return n, errs, err
		}
	}
	return n, errs, nil
}
