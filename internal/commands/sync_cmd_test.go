package commands

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

func TestSyncCommandFirstUploadIsNonInteractiveAndRefusesWithoutFlag(t *testing.T) {
	seedEvents(t, func(db *storage.DB) {
		at := time.Date(2026, 8, 30, 9, 0, 0, 0, time.UTC)
		ev := &protocol.Event{
			SchemaVersion: protocol.SchemaVersionEvent,
			EventID:       ids.Event(), OccurredAt: at, ObservedAt: at,
			Kind: protocol.EventLogObserved, Provenance: protocol.ProvenanceObserved,
			Payload: json.RawMessage(`{"message":"ready"}`),
		}
		if _, err := db.AppendEvent(context.Background(), ev); err != nil {
			t.Fatal(err)
		}
	})
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	t.Setenv("HFG_HOSTED_API_URL", server.URL)
	t.Setenv("HFG_DEVICE_TOKEN", "hfg_dev_test_device_token_0123456789abcdef")

	out, _, err := runRegisteredApp(newRegisteredApp(t), "sync")
	if err == nil || !strings.Contains(err.Error(), "--accept-redaction") {
		t.Fatalf("sync error = %v, output=%s", err, out)
	}
	if !strings.Contains(out, "sync preview: 1 event(s)") {
		t.Fatalf("sync output did not show content-free preview: %q", out)
	}
	if requests.Load() != 0 {
		t.Fatalf("sync made %d request(s) without acceptance", requests.Load())
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("HFG_DATA_DIR"), "hosted-sync-state.json")); !os.IsNotExist(err) {
		t.Fatalf("sync state exists after refusal: %v", err)
	}
}

func TestSyncCommandPreviewIsWriteFree(t *testing.T) {
	seedEvents(t, func(db *storage.DB) {
		at := time.Date(2026, 8, 30, 9, 0, 0, 0, time.UTC)
		ev := &protocol.Event{
			SchemaVersion: protocol.SchemaVersionEvent,
			EventID:       ids.Event(), OccurredAt: at, ObservedAt: at,
			Kind: protocol.EventLogObserved, Provenance: protocol.ProvenanceObserved,
			Payload: json.RawMessage(`{"message":"ready"}`),
		}
		if _, err := db.AppendEvent(context.Background(), ev); err != nil {
			t.Fatal(err)
		}
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Fatal("preview made a network request")
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	t.Setenv("HFG_HOSTED_API_URL", server.URL)
	t.Setenv("HFG_DEVICE_TOKEN", "hfg_dev_test_device_token_0123456789abcdef")

	out, _, err := runRegisteredApp(newRegisteredApp(t), "sync", "--preview")
	if err != nil {
		t.Fatalf("sync --preview: %v", err)
	}
	if !strings.Contains(out, "no network request or sync-state write") {
		t.Fatalf("preview output = %q", out)
	}
	for _, name := range []string{"hosted-sync-state.json", "hosted-sync-state.json.lock"} {
		if _, err := os.Stat(filepath.Join(os.Getenv("HFG_DATA_DIR"), name)); !os.IsNotExist(err) {
			t.Fatalf("%s exists after preview: %v", name, err)
		}
	}
}

func TestSyncCommandShowsFirstPreviewBeforeNetwork(t *testing.T) {
	seedEvents(t, func(db *storage.DB) {
		at := time.Date(2026, 8, 30, 9, 0, 0, 0, time.UTC)
		ev := &protocol.Event{
			SchemaVersion: protocol.SchemaVersionEvent,
			EventID:       ids.Event(), OccurredAt: at, ObservedAt: at,
			Kind: protocol.EventLogObserved, Provenance: protocol.ProvenanceObserved,
			Payload: json.RawMessage(`{"message":"ready"}`),
		}
		if _, err := db.AppendEvent(context.Background(), ev); err != nil {
			t.Fatal(err)
		}
	})
	var requested atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested.Store(true)
		var envelope struct {
			Events []json.RawMessage `json:"events"`
		}
		if err := json.NewDecoder(r.Body).Decode(&envelope); err != nil {
			t.Errorf("decode request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"accepted": len(envelope.Events), "batch_id": "batch_test",
			"schema_version": "hfg.event-batch.receipt.v1", "workspace_id": "wsp_test",
		})
	}))
	defer server.Close()
	t.Setenv("HFG_HOSTED_API_URL", server.URL)
	t.Setenv("HFG_DEVICE_TOKEN", "hfg_dev_test_device_token_0123456789abcdef")

	// bytes.Buffer is written synchronously by the callback before client.Do;
	// the ordered output therefore proves the user-visible preview boundary.
	out, _, err := runRegisteredApp(newRegisteredApp(t), "sync", "--accept-redaction")
	if err != nil {
		t.Fatalf("sync --accept-redaction: %v\n%s", err, out)
	}
	previewAt := strings.Index(out, "sync preview before first upload")
	acceptedAt := strings.Index(out, "sync: accepted 1 event")
	if !requested.Load() || previewAt < 0 || acceptedAt < 0 || previewAt >= acceptedAt {
		t.Fatalf("ordered output = %q, requested=%v", out, requested.Load())
	}
}
