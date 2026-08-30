package hostedsync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/redact"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

const testDeviceToken = "hfg_dev_test_device_token_0123456789abcdef"

func openSyncDB(t *testing.T, payloads ...json.RawMessage) *storage.DB {
	t.Helper()
	db, err := storage.Open(filepath.Join(t.TempDir(), "events.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	base := time.Date(2026, 8, 30, 8, 0, 0, 0, time.UTC)
	for i, payload := range payloads {
		ev := &protocol.Event{
			SchemaVersion: protocol.SchemaVersionEvent,
			EventID:       ids.Event(),
			OccurredAt:    base.Add(time.Duration(i) * time.Second),
			ObservedAt:    base.Add(time.Duration(i) * time.Second),
			Kind:          protocol.EventLogObserved,
			Provider:      protocol.ProviderCodex,
			Provenance:    protocol.ProvenanceObserved,
			Payload:       payload,
		}
		if _, err := db.AppendEvent(context.Background(), ev); err != nil {
			t.Fatalf("AppendEvent(%d): %v", i, err)
		}
	}
	return db
}

func syncEngine(t *testing.T) *redact.Engine {
	t.Helper()
	engine, err := redact.New(redact.Options{DenyPaths: []string{".env", "api_key"}})
	if err != nil {
		t.Fatal(err)
	}
	return engine
}

func runOptions(serverURL, statePath string) Options {
	return Options{
		Endpoint:  serverURL,
		Token:     testDeviceToken,
		StoreID:   "test-store",
		StatePath: statePath,
		Now:       func() time.Time { return time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC) },
	}
}

func TestDefaultBatchFitsBasicHostedEntitlement(t *testing.T) {
	payloads := make([]json.RawMessage, 101)
	for i := range payloads {
		payloads[i] = json.RawMessage(fmt.Sprintf(`{"index":%d}`, i))
	}
	db := openSyncDB(t, payloads...)
	var batchSizes []int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		var envelope struct {
			Events []json.RawMessage `json:"events"`
		}
		if err := json.Unmarshal(body, &envelope); err != nil {
			t.Fatal(err)
		}
		if len(envelope.Events) > 100 {
			http.Error(w, "batch_events_exceeded", http.StatusTooManyRequests)
			return
		}
		batchSizes = append(batchSizes, len(envelope.Events))
		successReceipt(w, body, "wsp_01JAAAAAAAAAAAAAAAAAAAAAAA")
	}))
	defer server.Close()

	opts := runOptions(server.URL, filepath.Join(t.TempDir(), "state.json"))
	opts.AcceptRedaction = true
	report, err := Run(context.Background(), db, syncEngine(t), server.Client(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if report.AcceptedEvents != 101 || report.BatchesSent != 2 {
		t.Fatalf("report = %+v, want 101 events in 2 basic-safe batches", report)
	}
	if got, want := fmt.Sprint(batchSizes), "[100 1]"; got != want {
		t.Fatalf("batch sizes = %s, want %s", got, want)
	}
}

func successReceipt(w http.ResponseWriter, body []byte, workspace string) {
	var envelope struct {
		Events []json.RawMessage `json:"events"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		http.Error(w, "bad test request", http.StatusBadRequest)
		return
	}
	for _, raw := range envelope.Events {
		var event protocol.Event
		if err := json.Unmarshal(raw, &event); err != nil || event.Redaction == nil ||
			event.Redaction.Version != redact.RedactionVersion ||
			(event.Redaction.Status != redact.StatusClean && event.Redaction.Status != redact.StatusRedacted) {
			http.Error(w, "missing successful redaction attestation", http.StatusBadRequest)
			return
		}
	}
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"accepted": len(envelope.Events), "batch_id": "batch_test",
		"schema_version": receiptSchemaVersion, "workspace_id": workspace,
	})
}

func TestFirstUploadRefusesWithoutAcceptanceAndPreviewWritesNothing(t *testing.T) {
	db := openSyncDB(t,
		json.RawMessage(`{"message":"ordinary"}`),
		json.RawMessage(`{"api_key":"sk-abcdefghijklmnopqrstuvwxyz012345"}`),
	)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.Error(w, "must not be called", http.StatusInternalServerError)
	}))
	defer server.Close()
	statePath := filepath.Join(t.TempDir(), "state.json")
	opts := runOptions(server.URL, statePath)

	report, err := Run(context.Background(), db, syncEngine(t), server.Client(), opts)
	if !errors.Is(err, ErrPreviewAcceptanceRequired) {
		t.Fatalf("Run error = %v, want preview acceptance refusal", err)
	}
	if report.Preview.Events != 2 || report.Preview.Redacted != 1 || report.Preview.Clean != 1 {
		t.Fatalf("preview = %+v", report.Preview)
	}
	if requests.Load() != 0 {
		t.Fatalf("network requests = %d, want 0", requests.Load())
	}
	if _, err := os.Stat(statePath); !os.IsNotExist(err) {
		t.Fatalf("state exists after refused first upload: %v", err)
	}

	opts.PreviewOnly = true
	opts.StatePath = filepath.Join(t.TempDir(), "preview-state.json")
	report, err = Run(context.Background(), db, syncEngine(t), server.Client(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if report.Mode != "preview" || requests.Load() != 0 {
		t.Fatalf("preview report=%+v requests=%d", report, requests.Load())
	}
	if _, err := os.Stat(opts.StatePath); !os.IsNotExist(err) {
		t.Fatalf("state exists after --preview: %v", err)
	}
	if _, err := os.Stat(opts.StatePath + ".lock"); !os.IsNotExist(err) {
		t.Fatalf("lock exists after --preview: %v", err)
	}
}

func TestAcceptedSyncRedactsBodyAndRepeatIsUpToDate(t *testing.T) {
	secret := "sk-abcdefghijklmnopqrstuvwxyz012345"
	db := openSyncDB(t,
		json.RawMessage(`{"message":"ordinary"}`),
		json.RawMessage(`{"api_key":`+fmt.Sprintf("%q", secret)+`}`),
	)
	var mu sync.Mutex
	var bodies [][]byte
	var keys []string
	var previewShown atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !previewShown.Load() {
			http.Error(w, "preview was not shown before network", http.StatusInternalServerError)
			return
		}
		body, _ := ioReadAll(r)
		mu.Lock()
		bodies = append(bodies, body)
		keys = append(keys, r.Header.Get("Idempotency-Key"))
		mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer "+testDeviceToken {
			http.Error(w, "bad auth", http.StatusUnauthorized)
			return
		}
		successReceipt(w, body, "wsp_tenant_a")
	}))
	defer server.Close()
	statePath := filepath.Join(t.TempDir(), "state.json")
	opts := runOptions(server.URL, statePath)
	opts.AcceptRedaction = true
	opts.BeforeFirstUpload = func(report Report) error {
		if report.Preview.Events != 2 || report.Preview.Redacted != 1 {
			return fmt.Errorf("unexpected preflight preview: %+v", report.Preview)
		}
		previewShown.Store(true)
		return nil
	}

	first, err := Run(context.Background(), db, syncEngine(t), server.Client(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if first.AcceptedEvents != 2 || first.BatchesSent != 1 || first.Cursor != 2 || !first.UpToDate {
		t.Fatalf("first report = %+v", first)
	}
	stateBytes, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stateBytes), testDeviceToken) || strings.Contains(string(stateBytes), secret) || strings.Contains(string(stateBytes), opts.StoreID) {
		t.Fatalf("hosted state persisted a raw credential, payload secret, or store identity: %s", stateBytes)
	}
	mu.Lock()
	if len(bodies) != 1 || strings.Contains(string(bodies[0]), secret) || !strings.Contains(string(bodies[0]), redact.Mask) {
		t.Fatalf("hosted body did not redact secret: %q", bodies)
	}
	if len(keys) != 1 || keys[0] != idempotencyKey(bodies[0]) {
		t.Fatalf("idempotency keys = %v", keys)
	}
	mu.Unlock()

	opts.AcceptRedaction = false
	opts.BeforeFirstUpload = nil
	second, err := Run(context.Background(), db, syncEngine(t), server.Client(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if !second.UpToDate || second.AcceptedEvents != 0 || second.Cursor != 2 || second.Preview.Events != 0 {
		t.Fatalf("repeat report = %+v", second)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 1 {
		t.Fatalf("repeat sync made %d total requests, want 1", len(bodies))
	}
}

func TestDifferentLocalStoreCannotInheritCursorOrAcceptance(t *testing.T) {
	firstDB := openSyncDB(t, json.RawMessage(`{"store":"first"}`))
	secondDB := openSyncDB(t, json.RawMessage(`{"store":"second"}`))
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		body, _ := ioReadAll(r)
		successReceipt(w, body, "wsp_tenant_a")
	}))
	defer server.Close()
	statePath := filepath.Join(t.TempDir(), "state.json")
	opts := runOptions(server.URL, statePath)
	opts.StoreID = "/canonical/store/one.db"
	opts.AcceptRedaction = true
	if _, err := Run(context.Background(), firstDB, syncEngine(t), server.Client(), opts); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 1 {
		t.Fatalf("first store requests = %d", requests.Load())
	}

	opts.StoreID = "/canonical/store/two.db"
	opts.AcceptRedaction = false
	report, err := Run(context.Background(), secondDB, syncEngine(t), server.Client(), opts)
	if !errors.Is(err, ErrPreviewAcceptanceRequired) {
		t.Fatalf("second store error = %v, want fresh acceptance", err)
	}
	if report.Cursor != 0 || report.Preview.Events != 1 || requests.Load() != 1 {
		t.Fatalf("second store inherited state: report=%+v requests=%d", report, requests.Load())
	}
}

func TestBatchingSplitsAtHostedByteLimit(t *testing.T) {
	large := strings.Repeat("a", 140_000)
	db := openSyncDB(t,
		json.RawMessage(`{"message":`+fmt.Sprintf("%q", large)+`}`),
		json.RawMessage(`{"message":`+fmt.Sprintf("%q", large)+`}`),
	)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := ioReadAll(r)
		if len(body) > maxBodyBytes {
			http.Error(w, "too large", http.StatusRequestEntityTooLarge)
			return
		}
		requests.Add(1)
		successReceipt(w, body, "wsp_tenant_a")
	}))
	defer server.Close()
	opts := runOptions(server.URL, filepath.Join(t.TempDir(), "state.json"))
	opts.BatchSize = 2
	opts.AcceptRedaction = true

	report, err := Run(context.Background(), db, syncEngine(t), server.Client(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if report.AcceptedEvents != 2 || report.BatchesSent != 2 || requests.Load() != 2 {
		t.Fatalf("byte-bounded report=%+v requests=%d", report, requests.Load())
	}
}

func TestSingleEventOverBasicByteLimitFailsBeforeNetwork(t *testing.T) {
	large := strings.Repeat("a", 300_000)
	db := openSyncDB(t, json.RawMessage(`{"message":`+fmt.Sprintf("%q", large)+`}`))
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.Error(w, "must not be called", http.StatusInternalServerError)
	}))
	defer server.Close()
	opts := runOptions(server.URL, filepath.Join(t.TempDir(), "state.json"))
	opts.AcceptRedaction = true

	_, err := Run(context.Background(), db, syncEngine(t), server.Client(), opts)
	if err == nil || !strings.Contains(err.Error(), "Basic 256 KiB") {
		t.Fatalf("Run error = %v, want Basic byte-limit refusal", err)
	}
	if requests.Load() != 0 {
		t.Fatalf("network requests = %d, want 0", requests.Load())
	}
}

func TestEventsCapturedDuringRequestWaitForNextExplicitSync(t *testing.T) {
	db := openSyncDB(t, json.RawMessage(`{"n":1}`))
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		current := requests.Add(1)
		body, _ := ioReadAll(r)
		if current == 1 {
			at := time.Date(2026, 8, 30, 9, 0, 1, 0, time.UTC)
			ev := &protocol.Event{
				SchemaVersion: protocol.SchemaVersionEvent,
				EventID:       ids.Event(), OccurredAt: at, ObservedAt: at,
				Kind: protocol.EventLogObserved, Provenance: protocol.ProvenanceObserved,
				Payload: json.RawMessage(`{"n":2}`),
			}
			if _, err := db.AppendEvent(context.Background(), ev); err != nil {
				t.Errorf("append during request: %v", err)
			}
		}
		successReceipt(w, body, "wsp_tenant_a")
	}))
	defer server.Close()
	opts := runOptions(server.URL, filepath.Join(t.TempDir(), "state.json"))
	opts.AcceptRedaction = true

	first, err := Run(context.Background(), db, syncEngine(t), server.Client(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if first.HighWatermark != 1 || first.AcceptedEvents != 1 || requests.Load() != 1 {
		t.Fatalf("first explicit boundary widened: report=%+v requests=%d", first, requests.Load())
	}
	opts.AcceptRedaction = false
	second, err := Run(context.Background(), db, syncEngine(t), server.Client(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if second.HighWatermark != 2 || second.AcceptedEvents != 1 || requests.Load() != 2 {
		t.Fatalf("second explicit sync missed new event: report=%+v requests=%d", second, requests.Load())
	}
}

func TestPartialFailureResumesExactPendingBatch(t *testing.T) {
	db := openSyncDB(t,
		json.RawMessage(`{"n":1}`),
		json.RawMessage(`{"n":2}`),
		json.RawMessage(`{"n":3}`),
	)
	var mu sync.Mutex
	var bodies [][]byte
	var keys []string
	requestNumber := 0
	failSecond := true
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := ioReadAll(r)
		mu.Lock()
		requestNumber++
		current := requestNumber
		bodies = append(bodies, append([]byte(nil), body...))
		keys = append(keys, r.Header.Get("Idempotency-Key"))
		shouldFail := failSecond && current == 2
		mu.Unlock()
		if shouldFail {
			http.Error(w, "temporary", http.StatusServiceUnavailable)
			return
		}
		successReceipt(w, body, "wsp_tenant_a")
	}))
	defer server.Close()
	statePath := filepath.Join(t.TempDir(), "state.json")
	opts := runOptions(server.URL, statePath)
	opts.BatchSize = 1
	opts.AcceptRedaction = true

	first, err := Run(context.Background(), db, syncEngine(t), server.Client(), opts)
	if err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("first Run error = %v, want 503", err)
	}
	if first.AcceptedEvents != 1 || first.Cursor != 1 || first.BatchesSent != 1 {
		t.Fatalf("partial report = %+v", first)
	}
	state, err := loadState(statePath)
	if err != nil {
		t.Fatal(err)
	}
	origin, _, _ := NormalizeEndpoint(server.URL)
	scope, err := getScope(state, origin, testDeviceToken, opts.StoreID)
	if err != nil {
		t.Fatal(err)
	}
	if scope.Cursor != 1 || scope.Pending == nil || scope.Pending.ThroughSeq != 2 {
		t.Fatalf("persisted scope = %+v", scope)
	}

	mu.Lock()
	failSecond = false
	mu.Unlock()
	opts.AcceptRedaction = false
	second, err := Run(context.Background(), db, syncEngine(t), server.Client(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if second.AcceptedEvents != 2 || second.BatchesSent != 2 || second.Cursor != 3 || !second.UpToDate {
		t.Fatalf("resume report = %+v", second)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 4 {
		t.Fatalf("request bodies = %d, want 4", len(bodies))
	}
	if string(bodies[1]) != string(bodies[2]) || keys[1] != keys[2] {
		t.Fatalf("pending retry changed\nfailed key/body: %s %s\nretry key/body: %s %s", keys[1], bodies[1], keys[2], bodies[2])
	}
}

func TestMonthlyQuotaRetryPreservesExactPendingBatch(t *testing.T) {
	db := openSyncDB(t, json.RawMessage(`{"n":1}`))
	resetAt := time.Date(2026, 8, 30, 12, 1, 0, 0, time.UTC).Unix()
	var mu sync.Mutex
	var bodies [][]byte
	var keys []string
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := ioReadAll(r)
		mu.Lock()
		requests++
		current := requests
		bodies = append(bodies, append([]byte(nil), body...))
		keys = append(keys, r.Header.Get("Idempotency-Key"))
		mu.Unlock()
		if current == 1 {
			w.Header().Set("content-type", "application/json")
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(http.StatusTooManyRequests)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error":                    "hosted quota exceeded",
				"code":                     "monthly_events_exceeded",
				"local_capture_unaffected": true,
				"detail": map[string]any{
					"scope": "month", "resource": "events",
					"limit": 1, "used": 1, "requested": 1, "remaining": 0,
					"resets_at": resetAt,
					"retryable": true,
				},
			})
			return
		}
		successReceipt(w, body, "wsp_tenant_a")
	}))
	defer server.Close()

	statePath := filepath.Join(t.TempDir(), "state.json")
	opts := runOptions(server.URL, statePath)
	opts.AcceptRedaction = true
	first, err := Run(context.Background(), db, syncEngine(t), server.Client(), opts)
	if err == nil || !strings.Contains(err.Error(), "monthly quota") || !strings.Contains(err.Error(), "retry after 60 seconds") {
		t.Fatalf("first Run error = %v, want classified monthly Retry-After", err)
	}
	if first.Cursor != 0 || first.AcceptedEvents != 0 || first.BatchesSent != 0 {
		t.Fatalf("first report advanced across quota denial: %+v", first)
	}
	state, err := loadState(statePath)
	if err != nil {
		t.Fatal(err)
	}
	origin, _, _ := NormalizeEndpoint(server.URL)
	scope, err := getScope(state, origin, testDeviceToken, opts.StoreID)
	if err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if requests != 1 {
		mu.Unlock()
		t.Fatalf("first explicit sync made %d requests, want one with no automatic sleep/retry", requests)
	}
	if scope.Cursor != 0 || scope.Pending == nil || !bytes.Equal(scope.Pending.Body, bodies[0]) || scope.Pending.IdempotencyKey != keys[0] {
		mu.Unlock()
		t.Fatalf("quota denial did not retain the exact pending request: scope=%+v", scope)
	}
	mu.Unlock()

	opts.AcceptRedaction = false
	second, err := Run(context.Background(), db, syncEngine(t), server.Client(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if second.Cursor != 1 || second.AcceptedEvents != 1 || second.BatchesSent != 1 || !second.UpToDate {
		t.Fatalf("explicit retry report = %+v", second)
	}
	mu.Lock()
	defer mu.Unlock()
	if requests != 2 || !bytes.Equal(bodies[0], bodies[1]) || keys[0] != keys[1] {
		t.Fatalf("explicit quota retry changed pending request: requests=%d keys=%v", requests, keys)
	}
}

func TestRetryAfterSecondsSupportsDelayAndHTTPDate(t *testing.T) {
	now := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name  string
		value string
		want  int64
		ok    bool
	}{
		{name: "delay seconds", value: "60", want: 60, ok: true},
		{name: "maximum monthly delay", value: fmt.Sprint(maxQuotaRetryAfterSeconds), want: maxQuotaRetryAfterSeconds, ok: true},
		{name: "over maximum monthly delay", value: fmt.Sprint(maxQuotaRetryAfterSeconds + 1), ok: false},
		{name: "HTTP date", value: now.Add(90 * time.Second).Format(http.TimeFormat), want: 90, ok: true},
		{name: "maximum monthly HTTP date", value: now.Add(time.Duration(maxQuotaRetryAfterSeconds) * time.Second).Format(http.TimeFormat), want: maxQuotaRetryAfterSeconds, ok: true},
		{name: "over maximum monthly HTTP date", value: now.Add(time.Duration(maxQuotaRetryAfterSeconds+1) * time.Second).Format(http.TimeFormat), ok: false},
		{name: "past HTTP date", value: now.Add(-time.Second).Format(http.TimeFormat), want: 0, ok: true},
		{name: "negative is not delay seconds", value: "-1", ok: false},
		{name: "malformed", value: "soon", ok: false},
		{name: "overflow", value: "999999999999999999999999999999", ok: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := retryAfterSeconds(tt.value, now)
			if ok != tt.ok || got != tt.want {
				t.Fatalf("retryAfterSeconds(%q) = (%d, %v), want (%d, %v)", tt.value, got, ok, tt.want, tt.ok)
			}
		})
	}
}

func TestResponseRetryAfterBoundsQuotaReset(t *testing.T) {
	now := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	response := &http.Response{Header: make(http.Header)}
	atBoundary := now.Unix() + maxQuotaRetryAfterSeconds
	if got, ok := responseRetryAfter(response, &atBoundary, now); !ok || got != maxQuotaRetryAfterSeconds {
		t.Fatalf("boundary reset = (%d, %v), want (%d, true)", got, ok, maxQuotaRetryAfterSeconds)
	}
	overBoundary := atBoundary + 1
	if got, ok := responseRetryAfter(response, &overBoundary, now); ok || got != 0 {
		t.Fatalf("over-boundary reset = (%d, %v), want (0, false)", got, ok)
	}
	if got, ok := responseRetryAfter(response, nil, now); ok || got != 0 {
		t.Fatalf("absent reset = (%d, %v), want (0, false)", got, ok)
	}
	atNow := now.Unix()
	if got, ok := responseRetryAfter(response, &atNow, now); ok || got != 0 {
		t.Fatalf("non-future reset = (%d, %v), want (0, false)", got, ok)
	}

	future := now.Unix() + 600
	response.Header.Set("Retry-After", "60")
	if got, ok := responseRetryAfter(response, &future, now); !ok || got != 600 {
		t.Fatalf("contradictory shorter header = (%d, %v), want authoritative reset (600, true)", got, ok)
	}
	response.Header.Set("Retry-After", "0")
	if got, ok := responseRetryAfter(response, &future, now); ok || got != 0 {
		t.Fatalf("zero header = (%d, %v), want fail-closed (0, false)", got, ok)
	}
}

func TestStructuredQuotaMetadataNeverFallsBackToContradictoryHeader(t *testing.T) {
	now := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	body, err := json.Marshal(map[string]any{
		"error":                    "hosted quota exceeded",
		"code":                     "monthly_events_exceeded",
		"local_capture_unaffected": true,
		"detail": map[string]any{
			"scope": "month", "resource": "events",
			"limit": 1, "used": 1, "requested": 1, "remaining": 0,
			"resets_at": now.Unix() + 600,
			"retryable": true,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	response := &http.Response{StatusCode: http.StatusTooManyRequests, Header: make(http.Header)}
	response.Header.Set("Retry-After", "0")
	got := hostedStatusError(response, body, now).Error()
	if !strings.Contains(got, "hosted API is rate-limited") || strings.Contains(got, "retry after") {
		t.Fatalf("hostedStatusError = %q, want status-only generic fallback", got)
	}
}

func TestUnknownRateLimitBodyCanUseBoundedRetryAfter(t *testing.T) {
	now := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	response := &http.Response{StatusCode: http.StatusTooManyRequests, Header: make(http.Header)}
	response.Header.Set("Retry-After", "60")
	got := hostedStatusError(response, []byte(`{"error":"gateway rate limit"}`), now).Error()
	if !strings.Contains(got, "hosted API is rate-limited") || !strings.Contains(got, "retry after 60 seconds") {
		t.Fatalf("hostedStatusError = %q, want bounded generic Retry-After guidance", got)
	}
}

func TestUnknownStructuredQuotaMetadataSuppressesRetryAfter(t *testing.T) {
	now := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	body := []byte(`{"error":"hosted quota exceeded","code":"monthly_events_exceeded","local_capture_unaffected":true,"future_policy":"unknown"}`)
	response := &http.Response{StatusCode: http.StatusTooManyRequests, Header: make(http.Header)}
	response.Header.Set("Retry-After", "60")
	got := hostedStatusError(response, body, now).Error()
	if !strings.Contains(got, "hosted API is rate-limited") || strings.Contains(got, "retry after") {
		t.Fatalf("hostedStatusError = %q, want status-only fallback for unknown structured metadata", got)
	}
}

func TestPermanentQuotaErrorsOverrideMisleadingRetryAfter(t *testing.T) {
	now := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name      string
		code      string
		scope     string
		used      int
		requested int
		remaining int
		want      string
	}{
		{name: "batch", code: "batch_events_exceeded", scope: "batch", used: 0, requested: 11, remaining: 10, want: "unchanged cannot succeed"},
		{name: "lifetime", code: "lifetime_events_exceeded", scope: "lifetime", used: 9, requested: 2, remaining: 1, want: "entitlement change"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, err := json.Marshal(map[string]any{
				"error":                    "hosted quota exceeded",
				"code":                     tt.code,
				"local_capture_unaffected": true,
				"detail": map[string]any{
					"scope": tt.scope, "resource": "events",
					"limit": 10, "used": tt.used, "requested": tt.requested, "remaining": tt.remaining,
					"retryable": false,
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			response := &http.Response{StatusCode: http.StatusTooManyRequests, Header: make(http.Header)}
			response.Header.Set("Retry-After", "60")
			got := hostedStatusError(response, body, now).Error()
			if !strings.Contains(got, tt.want) || strings.Contains(got, "retry after") {
				t.Fatalf("hostedStatusError = %q, want permanent classification", got)
			}
		})
	}
}

func TestQuotaClassificationFallsBackForMissingOrInvalidPolicy(t *testing.T) {
	now := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		code   string
		detail map[string]any
	}{
		{
			name: "missing permanent retryable flag",
			code: "batch_events_exceeded",
			detail: map[string]any{
				"scope": "batch", "resource": "events",
				"limit": 10, "used": 0, "requested": 11, "remaining": 10,
			},
		},
		{
			name: "missing monthly reset",
			code: "monthly_events_exceeded",
			detail: map[string]any{
				"scope": "month", "resource": "events",
				"limit": 1, "used": 1, "requested": 1, "remaining": 0,
				"retryable": true,
			},
		},
		{
			name: "far future monthly reset",
			code: "monthly_events_exceeded",
			detail: map[string]any{
				"scope": "month", "resource": "events",
				"limit": 1, "used": 1, "requested": 1, "remaining": 0,
				"retryable": true,
				"resets_at": now.Unix() + maxQuotaRetryAfterSeconds + 1,
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, err := json.Marshal(map[string]any{
				"error":                    "hosted quota exceeded",
				"code":                     tt.code,
				"local_capture_unaffected": true,
				"detail":                   tt.detail,
			})
			if err != nil {
				t.Fatal(err)
			}
			response := &http.Response{StatusCode: http.StatusTooManyRequests, Header: make(http.Header)}
			got := hostedStatusError(response, body, now).Error()
			if !strings.Contains(got, "hosted API is rate-limited") || strings.Contains(got, "quota is exhausted") || strings.Contains(got, "per-batch quota") {
				t.Fatalf("hostedStatusError = %q, want generic fallback", got)
			}
		})
	}
}

func TestRedactionFailureMakesNoRequestOrState(t *testing.T) {
	// A scalar JSON payload is valid event JSON but cannot be classified by
	// the object redaction pipeline, which must fail closed.
	db := openSyncDB(t, json.RawMessage(`"unclassifiable payload"`))
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	statePath := filepath.Join(t.TempDir(), "state.json")
	opts := runOptions(server.URL, statePath)
	opts.AcceptRedaction = true

	_, err := Run(context.Background(), db, syncEngine(t), server.Client(), opts)
	if err == nil || !strings.Contains(err.Error(), "fail-closed") {
		t.Fatalf("Run error = %v, want fail-closed redaction error", err)
	}
	if requests.Load() != 0 {
		t.Fatalf("requests = %d, want 0", requests.Load())
	}
	if _, err := os.Stat(statePath); !os.IsNotExist(err) {
		t.Fatalf("state exists after redaction failure: %v", err)
	}
}

func TestWorkspaceBindingInBodyAndReceiptMismatchDoesNotAdvance(t *testing.T) {
	db := openSyncDB(t, json.RawMessage(`{"n":1}`), json.RawMessage(`{"n":2}`))
	var mu sync.Mutex
	var envelopes []batchEnvelope
	requestNumber := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := ioReadAll(r)
		var envelope batchEnvelope
		_ = json.Unmarshal(body, &envelope)
		mu.Lock()
		requestNumber++
		current := requestNumber
		envelopes = append(envelopes, envelope)
		mu.Unlock()
		workspace := "wsp_tenant_a"
		if current == 2 {
			workspace = "wsp_tenant_b"
		}
		successReceipt(w, body, workspace)
	}))
	defer server.Close()
	statePath := filepath.Join(t.TempDir(), "state.json")
	opts := runOptions(server.URL, statePath)
	opts.BatchSize = 1
	opts.AcceptRedaction = true

	report, err := Run(context.Background(), db, syncEngine(t), server.Client(), opts)
	if err == nil || !strings.Contains(err.Error(), "workspace changed") {
		t.Fatalf("Run error = %v, want workspace mismatch", err)
	}
	if report.Cursor != 1 || report.AcceptedEvents != 1 {
		t.Fatalf("report = %+v", report)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(envelopes) != 2 || envelopes[0].WorkspaceID != "" || envelopes[1].WorkspaceID != "wsp_tenant_a" {
		t.Fatalf("workspace envelopes = %+v", envelopes)
	}
	state, err := loadState(statePath)
	if err != nil {
		t.Fatal(err)
	}
	origin, _, _ := NormalizeEndpoint(server.URL)
	scope, _ := getScope(state, origin, testDeviceToken, opts.StoreID)
	if scope.Cursor != 1 || scope.WorkspaceID != "wsp_tenant_a" || scope.Pending == nil {
		t.Fatalf("scope advanced across tenant mismatch: %+v", scope)
	}
}

func TestServerBodyAndCredentialAreNeverReflectedInError(t *testing.T) {
	secret := "sk-abcdefghijklmnopqrstuvwxyz012345"
	db := openSyncDB(t, json.RawMessage(`{"api_key":`+fmt.Sprintf("%q", secret)+`}`))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = fmt.Fprintf(w, `{"error":%q}`, "reflected "+testDeviceToken+" "+secret)
	}))
	defer server.Close()
	opts := runOptions(server.URL, filepath.Join(t.TempDir(), "state.json"))
	opts.AcceptRedaction = true

	_, err := Run(context.Background(), db, syncEngine(t), server.Client(), opts)
	if err == nil {
		t.Fatal("Run succeeded")
	}
	if strings.Contains(err.Error(), testDeviceToken) || strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "reflected") {
		t.Fatalf("error leaked remote content: %q", err)
	}
}

func TestSanitizeEventCoversUnknownFieldsAndGitCredentialsDeterministically(t *testing.T) {
	secret := "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD"
	event := &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       ids.Event(), OccurredAt: time.Now().UTC(), ObservedAt: time.Now().UTC(),
		Kind: protocol.EventLogObserved, Provenance: protocol.ProvenanceObserved,
		Payload: json.RawMessage(`{"z":"fine","api_key":"` + secret + `"}`),
		Git:     &protocol.GitState{Remote: "https://user:password@example.invalid/repo.git"},
		Unknown: map[string]json.RawMessage{"future": json.RawMessage(`{"token":"` + secret + `"}`)},
	}
	first, stats, err := sanitizeEvent(event, syncEngine(t))
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := sanitizeEvent(event, syncEngine(t))
	if err != nil {
		t.Fatal(err)
	}
	a, _ := json.Marshal(first)
	b, _ := json.Marshal(second)
	if string(a) != string(b) {
		t.Fatalf("sanitized events are nondeterministic:\n%s\n%s", a, b)
	}
	if strings.Contains(string(a), secret) || strings.Contains(string(a), "password") || stats.Redacted != 1 {
		t.Fatalf("sanitized event leaked secret: %s; stats=%+v", a, stats)
	}
	if !sortStringsAreUnique(first.Redaction.FieldsRemoved) {
		t.Fatalf("fields_removed is not sorted and unique: %v", first.Redaction.FieldsRemoved)
	}
}

func TestSanitizeEventDropsShadowedDuplicateKeyBytes(t *testing.T) {
	secret := "sk-abcdefghijklmnopqrstuvwxyz012345"
	event := &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       ids.Event(), OccurredAt: time.Now().UTC(), ObservedAt: time.Now().UTC(),
		Kind: protocol.EventLogObserved, Provenance: protocol.ProvenanceObserved,
		Payload: json.RawMessage(`{"message":"` + secret + `","message":"safe"}`),
		Unknown: map[string]json.RawMessage{
			"future": json.RawMessage(`{"value":"` + secret + `","value":"safe"}`),
		},
	}
	sanitized, _, err := sanitizeEvent(event, syncEngine(t))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(sanitized)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), secret) || strings.Count(string(sanitized.Payload), `"message"`) != 1 || strings.Count(string(sanitized.Unknown["future"]), `"value"`) != 1 {
		t.Fatalf("canonical sanitized event retained shadowed bytes: %s", raw)
	}
}

func sortStringsAreUnique(values []string) bool {
	for i := 1; i < len(values); i++ {
		if values[i-1] >= values[i] {
			return false
		}
	}
	return true
}

func TestResolveDeviceTokenFilePermissionsAndEndpointSafety(t *testing.T) {
	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "device-token")
	if err := os.WriteFile(tokenPath, []byte(testDeviceToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := ResolveDeviceToken("", tokenPath)
	if err != nil || got != testDeviceToken {
		t.Fatalf("ResolveDeviceToken = %q, %v", got, err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(tokenPath, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := ResolveDeviceToken("", tokenPath); err == nil || strings.Contains(err.Error(), testDeviceToken) {
			t.Fatalf("permissive token file error = %v", err)
		}
	}
	if _, _, err := NormalizeEndpoint("http://example.com"); err == nil {
		t.Fatal("remote HTTP endpoint was accepted")
	}
	if _, _, err := NormalizeEndpoint("https://user:pass@example.com"); err == nil {
		t.Fatal("credential-bearing endpoint was accepted")
	}
	origin, batchURL, err := NormalizeEndpoint("https://EXAMPLE.com:443/")
	if err != nil || origin != "https://example.com" || batchURL != "https://example.com/v1/event-batches" {
		t.Fatalf("canonical endpoint = %q, %q, %v", origin, batchURL, err)
	}
}

// ioReadAll is deliberately tiny so handlers always close over a bounded
// request emitted by the production code (which enforces the Basic 256 KiB
// limit).
func ioReadAll(r *http.Request) ([]byte, error) {
	defer r.Body.Close()
	return io.ReadAll(r.Body)
}
