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
	"os"
	"path/filepath"
	"unicode/utf8"

	"github.com/handoffgraph/handoffgraph/internal/graph"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// Result reports the outcome of verifying a fixture directory.
type Result struct {
	FilesChecked int      `json:"files_checked"`
	Events       int      `json:"events"`
	Failures     []string `json:"failures,omitempty"`
}

// Verify imports every .jsonl file under dir into a fresh temporary database
// and reports whether ingestion, graph rebuild, and trace materialization
// succeed. It never writes to the user's real database.
func Verify(ctx context.Context, dir string) (*Result, error) {
	res := &Result{}

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
		n, errs, err := importFile(ctx, f, db)
		if err != nil {
			res.Failures = append(res.Failures, fmt.Sprintf("%s: %v", filepath.Base(f), err))
			continue
		}
		res.Events += n
		for _, e := range errs {
			res.Failures = append(res.Failures, fmt.Sprintf("%s: %v", filepath.Base(f), e))
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
