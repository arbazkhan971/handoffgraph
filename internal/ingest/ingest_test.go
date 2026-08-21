package ingest

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func newEvent() *protocol.Event {
	return &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       ids.Event(),
		Kind:          protocol.EventSessionStarted,
	}
}

func TestImportValidLines(t *testing.T) {
	var evs []*protocol.Event
	for i := 0; i < 10; i++ {
		evs = append(evs, newEvent())
	}
	var b strings.Builder
	for _, ev := range evs {
		data, _ := ev.MarshalJSON()
		b.Write(data)
		b.WriteString("\n")
	}

	var appended int
	n, errs := Import(context.Background(), strings.NewReader(b.String()), func(ctx context.Context, ev *protocol.Event) (bool, error) {
		appended++
		return true, nil
	})
	if len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	if n != 10 {
		t.Fatalf("appended = %d, want 10", n)
	}
}

func TestImportTruncatedFinalLine(t *testing.T) {
	var b strings.Builder
	ev := newEvent()
	data, _ := ev.MarshalJSON()
	b.Write(data)
	b.WriteString("\n")
	// Truncated trailing line (no newline, partial JSON).
	b.WriteString(`{"schema_version":"hfg.event.v1","event_id":"evt_trunc`)

	var appended int
	n, errs := Import(context.Background(), strings.NewReader(b.String()), func(ctx context.Context, ev *protocol.Event) (bool, error) {
		appended++
		return true, nil
	})
	// The valid first line must be preserved even though the second is bad.
	if n != 1 {
		t.Fatalf("appended = %d, want 1 (valid line before truncation)", n)
	}
	if len(errs) == 0 {
		t.Fatal("expected an error for the truncated line")
	}
}

// TestImportRejectsInvalidUTF8 proves a line containing a raw invalid
// UTF-8 byte is rejected instead of being silently rewritten with the
// Unicode replacement character by encoding/json.
func TestImportRejectsInvalidUTF8(t *testing.T) {
	good, _ := newEvent().MarshalJSON()
	var b bytes.Buffer
	b.Write(good)
	b.WriteString("\n")
	b.WriteString(`{"schema_version":"hfg.event.v1","kind":"log.observed","payload":{"note":"bad `)
	b.WriteByte(0xFF)
	b.WriteString("\"}}\n")

	var appended int
	n, errs := Import(context.Background(), &b, func(ctx context.Context, ev *protocol.Event) (bool, error) {
		appended++
		return true, nil
	})
	if n != 1 || appended != 1 {
		t.Fatalf("appended = %d (n=%d), want 1 — only the valid line may import", appended, n)
	}
	if len(errs) != 1 {
		t.Fatalf("errs = %v, want exactly one invalid-UTF-8 error", errs)
	}
	if !strings.Contains(errs[0].Error(), "invalid UTF-8") {
		t.Errorf("error = %q, want it to mention invalid UTF-8", errs[0].Error())
	}
}

func TestImportSkipsBlankLines(t *testing.T) {
	var b strings.Builder
	ev := newEvent()
	data, _ := ev.MarshalJSON()
	b.WriteString("\n\n")
	b.Write(data)
	b.WriteString("\n\n")
	n, errs := Import(context.Background(), strings.NewReader(b.String()), func(ctx context.Context, ev *protocol.Event) (bool, error) {
		return true, nil
	})
	if len(errs) != 0 {
		t.Fatalf("unexpected errors: %v", errs)
	}
	if n != 1 {
		t.Fatalf("appended = %d, want 1", n)
	}
}

func TestSpoolRoundTrip(t *testing.T) {
	dir := t.TempDir()
	sp, err := OpenSpool(dir + "/spool.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	ev := newEvent()
	if err := sp.Append(ev); err != nil {
		t.Fatal(err)
	}
	sp.Close()

	var got []*protocol.Event
	n, errs, err := ReplaySpool(context.Background(), dir+"/spool.jsonl", func(ctx context.Context, e *protocol.Event) (bool, error) {
		got = append(got, e)
		return true, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(errs) != 0 {
		t.Fatalf("errors: %v", errs)
	}
	if n != 1 || len(got) != 1 {
		t.Fatalf("replayed %d events, want 1", n)
	}
	if got[0].EventID != ev.EventID {
		t.Fatal("event id mismatch after replay")
	}
}
