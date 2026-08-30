// Package hostedsync implements the explicit local-to-hosted event transfer.
// It is never called by capture hooks: only the user-invoked CLI sync command
// crosses the network boundary.
package hostedsync

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/content"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/redact"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

const (
	batchSchemaVersion   = "hfg.event-batch.v1"
	receiptSchemaVersion = "hfg.event-batch.receipt.v1"
	maxEventsPerBatch    = 500
	// The Basic hosted entitlement is the lowest supported request ceiling.
	// Higher plans can still sync the same data over more requests.
	maxBodyBytes     = 262_144
	maxResponseBytes = 64 << 10
	// Basic hosted workspaces accept at most 100 events per request. Keep the
	// zero-value/default client batch within that entitlement so a normal first
	// sync does not create an unreplayable, over-quota pending body.
	defaultBatchSize = 100
)

// ErrPreviewAcceptanceRequired is returned after a successful, content-free
// preview when this credential scope has never uploaded. The caller may show
// the report, but must not treat the invocation as a successful sync.
var ErrPreviewAcceptanceRequired = errors.New("first hosted upload requires explicit redaction-preview acceptance; review the preview and rerun with --accept-redaction")

// EventStore is the append-only local source needed by sync.
type EventStore interface {
	MaxSeq(context.Context) (int64, error)
	ListEventsAfterSeq(context.Context, int64, int64, int) ([]storage.SequencedEvent, error)
}

// HTTPDoer is implemented by http.Client and keeps network behavior testable.
type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

// Options configures one explicit sync invocation.
type Options struct {
	Endpoint string
	Token    string
	// StoreID is a stable, non-secret identity for the local append-only DB
	// (the CLI uses its canonical absolute path). It prevents a cursor from
	// one repository-scoped store being reused for a different store.
	StoreID         string
	StatePath       string
	BatchSize       int
	PreviewOnly     bool
	AcceptRedaction bool
	// BeforeFirstUpload is invoked after the complete fail-closed preview and
	// before acceptance is persisted or any request is sent. The CLI uses it
	// to make the exact content-free preview visible before crossing the first
	// hosted boundary.
	BeforeFirstUpload func(Report) error
	UserAgent         string
	Now               func() time.Time
}

// Report contains only counts and local cursor metadata. It deliberately
// excludes event IDs, payloads, field names, endpoint credentials, and raw
// server response bodies.
type Report struct {
	Mode            string         `json:"mode"`
	HighWatermark   int64          `json:"high_watermark"`
	Cursor          int64          `json:"cursor"`
	Preview         redactionStats `json:"preview"`
	AcceptedEvents  int            `json:"accepted_events"`
	BatchesSent     int            `json:"batches_sent"`
	UpToDate        bool           `json:"up_to_date"`
	FirstUpload     bool           `json:"first_upload"`
	WorkspaceBound  bool           `json:"workspace_bound"`
	LocalUnaffected bool           `json:"local_capture_unaffected"`
}

type batchEnvelope struct {
	SchemaVersion string            `json:"schema_version"`
	WorkspaceID   string            `json:"workspace_id,omitempty"`
	Events        []*protocol.Event `json:"events"`
}

type receipt struct {
	Accepted      int    `json:"accepted"`
	BatchID       string `json:"batch_id"`
	SchemaVersion string `json:"schema_version"`
	WorkspaceID   string `json:"workspace_id"`
}

// Run previews and, unless PreviewOnly, explicitly uploads every local event
// after the persisted cursor through a high-water mark captured at entry.
func Run(ctx context.Context, store EventStore, engine *redact.Engine, client HTTPDoer, opts Options) (Report, error) {
	report := Report{Mode: "sync", LocalUnaffected: true}
	if store == nil || engine == nil || client == nil {
		return report, fmt.Errorf("hosted sync dependencies are incomplete")
	}
	if opts.StatePath == "" {
		return report, fmt.Errorf("hosted sync state path is empty")
	}
	if opts.StoreID == "" {
		return report, fmt.Errorf("hosted sync local store identity is empty")
	}
	if opts.BatchSize == 0 {
		opts.BatchSize = defaultBatchSize
	}
	if opts.BatchSize < 1 || opts.BatchSize > maxEventsPerBatch {
		return report, fmt.Errorf("batch size must be between 1 and %d", maxEventsPerBatch)
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	origin, batchURL, err := NormalizeEndpoint(opts.Endpoint)
	if err != nil {
		return report, err
	}
	token, err := validateDeviceToken(opts.Token)
	if err != nil {
		return report, err
	}

	// Mutating syncs serialize state transitions. A preview is intentionally
	// filesystem-write-free, including no lock-file creation.
	var lock *stateLock
	if !opts.PreviewOnly {
		lock, err = acquireStateLock(opts.StatePath + ".lock")
		if err != nil {
			return report, err
		}
		defer lock.release()
	}

	state, err := loadState(opts.StatePath)
	if err != nil {
		return report, err
	}
	scope, err := getScope(state, origin, token, opts.StoreID)
	if err != nil {
		return report, err
	}
	highWatermark, err := store.MaxSeq(ctx)
	if err != nil {
		return report, fmt.Errorf("read local sync high-water mark: %w", err)
	}
	report.HighWatermark = highWatermark
	report.Cursor = scope.Cursor
	report.FirstUpload = scope.PreviewAcceptedAt == ""
	report.WorkspaceBound = scope.WorkspaceID != ""
	if scope.Cursor > highWatermark {
		return report, fmt.Errorf("hosted sync cursor %d is ahead of local event log %d; refusing to guess after a local reset", scope.Cursor, highWatermark)
	}
	if scope.Pending != nil {
		if err := validatePending(scope, highWatermark); err != nil {
			return report, err
		}
	}

	preview, err := previewRange(ctx, store, engine, scope, highWatermark)
	if err != nil {
		return report, err
	}
	report.Preview = preview
	if preview.Events == 0 {
		report.UpToDate = true
		report.Mode = map[bool]string{true: "preview", false: "sync"}[opts.PreviewOnly]
		return report, nil
	}
	if opts.PreviewOnly {
		report.Mode = "preview"
		return report, nil
	}
	if scope.PreviewAcceptedAt == "" {
		if !opts.AcceptRedaction {
			return report, ErrPreviewAcceptanceRequired
		}
		if opts.BeforeFirstUpload != nil {
			preflight := report
			preflight.Mode = "preview"
			if err := opts.BeforeFirstUpload(preflight); err != nil {
				return report, fmt.Errorf("show first-upload redaction preview: %w", err)
			}
		}
		acceptPreview(scope, opts.Now())
		// Persist acceptance before any network I/O. If this durability step
		// fails, the hosted boundary remains closed.
		if err := saveState(opts.StatePath, state); err != nil {
			return report, err
		}
		report.FirstUpload = true
	}

	for scope.Cursor < highWatermark || scope.Pending != nil {
		pending := scope.Pending
		if pending == nil {
			pending, err = buildPending(ctx, store, engine, scope, highWatermark, opts.BatchSize)
			if err != nil {
				return report, err
			}
			if pending == nil {
				break
			}
			scope.Pending = pending
			// The exact redacted body and idempotency key reach durable local
			// state before the request. A crash at any later instruction can
			// therefore replay byte-for-byte without double charging.
			if err := saveState(opts.StatePath, state); err != nil {
				return report, err
			}
		}

		receipt, err := postPending(ctx, client, batchURL, token, opts.UserAgent, pending)
		if err != nil {
			return report, err
		}
		if scope.WorkspaceID != "" && receipt.WorkspaceID != scope.WorkspaceID {
			return report, fmt.Errorf("hosted receipt workspace changed; refusing to advance the tenant-scoped cursor")
		}
		if scope.WorkspaceID == "" {
			scope.WorkspaceID = receipt.WorkspaceID
		}
		scope.Cursor = pending.ThroughSeq
		scope.Pending = nil
		if err := saveState(opts.StatePath, state); err != nil {
			return report, err
		}
		report.AcceptedEvents += pending.Events
		report.BatchesSent++
		report.Cursor = scope.Cursor
		report.WorkspaceBound = true
	}
	report.UpToDate = scope.Cursor >= highWatermark && scope.Pending == nil
	return report, nil
}

func previewRange(ctx context.Context, store EventStore, engine *redact.Engine, scope *scopeState, highWatermark int64) (redactionStats, error) {
	var total redactionStats
	after := scope.Cursor
	if scope.Pending != nil {
		total.add(redactionStats{
			Events: scope.Pending.Events, Clean: scope.Pending.Clean,
			Redacted: scope.Pending.Redacted, FieldsRedacted: scope.Pending.FieldsRedacted,
		})
		after = scope.Pending.ThroughSeq
	}
	for after < highWatermark {
		page, err := store.ListEventsAfterSeq(ctx, after, highWatermark, maxEventsPerBatch)
		if err != nil {
			return total, fmt.Errorf("read local events for redaction preview: %w", err)
		}
		if len(page) == 0 {
			return total, fmt.Errorf("local event log ended before high-water mark %d", highWatermark)
		}
		for _, item := range page {
			event, stats, err := sanitizeEvent(item.Event, engine)
			if err != nil {
				return total, fmt.Errorf("local sequence %d: %w", item.Seq, err)
			}
			body, err := encodeEnvelope(scope.WorkspaceID, []*protocol.Event{event})
			if err != nil {
				return total, fmt.Errorf("local sequence %d: encode redacted preview: %w", item.Seq, err)
			}
			if len(body) > maxBodyBytes {
				return total, fmt.Errorf("local sequence %d cannot fit the hosted Basic 256 KiB request limit after redaction", item.Seq)
			}
			total.add(stats)
			after = item.Seq
		}
	}
	return total, nil
}

func buildPending(ctx context.Context, store EventStore, engine *redact.Engine, scope *scopeState, highWatermark int64, limit int) (*pendingBatch, error) {
	page, err := store.ListEventsAfterSeq(ctx, scope.Cursor, highWatermark, limit)
	if err != nil {
		return nil, fmt.Errorf("read local events for hosted batch: %w", err)
	}
	if len(page) == 0 {
		return nil, nil
	}
	events := make([]*protocol.Event, 0, len(page))
	eventStats := make([]redactionStats, 0, len(page))
	for _, item := range page {
		event, stats, err := sanitizeEvent(item.Event, engine)
		if err != nil {
			return nil, fmt.Errorf("local sequence %d: %w", item.Seq, err)
		}
		events = append(events, event)
		eventStats = append(eventStats, stats)
	}

	// Encode once in the common case. If a count-bounded page exceeds the
	// byte cap, a binary search finds the largest fitting prefix in O(log n)
	// encodes instead of repeatedly serializing every growing prefix.
	body, err := encodeEnvelope(scope.WorkspaceID, events)
	if err != nil {
		return nil, fmt.Errorf("encode hosted batch: %w", err)
	}
	count := len(events)
	if len(body) > maxBodyBytes {
		one, err := encodeEnvelope(scope.WorkspaceID, events[:1])
		if err != nil {
			return nil, fmt.Errorf("encode hosted batch: %w", err)
		}
		if len(one) > maxBodyBytes {
			return nil, fmt.Errorf("local sequence %d cannot fit the hosted Basic 256 KiB request limit after redaction", page[0].Seq)
		}
		low, high := 1, len(events)
		body = one
		count = 1
		for low <= high {
			mid := low + (high-low)/2
			candidate, err := encodeEnvelope(scope.WorkspaceID, events[:mid])
			if err != nil {
				return nil, fmt.Errorf("encode hosted batch: %w", err)
			}
			if len(candidate) <= maxBodyBytes {
				count = mid
				body = candidate
				low = mid + 1
			} else {
				high = mid - 1
			}
		}
	}
	var stats redactionStats
	for _, item := range eventStats[:count] {
		stats.add(item)
	}
	through := page[count-1].Seq
	return &pendingBatch{
		AfterSeq: scope.Cursor, ThroughSeq: through,
		IdempotencyKey: idempotencyKey(body), Body: append(json.RawMessage(nil), body...),
		Events: stats.Events, Clean: stats.Clean, Redacted: stats.Redacted,
		FieldsRedacted: stats.FieldsRedacted,
	}, nil
}

func encodeEnvelope(workspaceID string, events []*protocol.Event) ([]byte, error) {
	return content.CanonicalJSON(batchEnvelope{
		SchemaVersion: batchSchemaVersion,
		WorkspaceID:   workspaceID,
		Events:        events,
	})
}

func idempotencyKey(body []byte) string {
	sum := sha256.Sum256(body)
	return "hfg-sync-v1-" + hex.EncodeToString(sum[:])
}

func validatePending(scope *scopeState, highWatermark int64) error {
	pending := scope.Pending
	if pending.AfterSeq != scope.Cursor || pending.ThroughSeq <= pending.AfterSeq || pending.ThroughSeq > highWatermark {
		return fmt.Errorf("hosted sync pending cursor is inconsistent; refusing a non-idempotent resume")
	}
	if pending.Events < 1 || pending.Events > maxEventsPerBatch || len(pending.Body) > maxBodyBytes {
		return fmt.Errorf("hosted sync pending batch is outside protocol limits")
	}
	if pending.IdempotencyKey != idempotencyKey(pending.Body) {
		return fmt.Errorf("hosted sync pending batch integrity check failed")
	}
	var envelope batchEnvelope
	dec := json.NewDecoder(bytes.NewReader(pending.Body))
	if err := dec.Decode(&envelope); err != nil {
		return fmt.Errorf("decode hosted sync pending batch: %w", err)
	}
	if envelope.SchemaVersion != batchSchemaVersion || len(envelope.Events) != pending.Events {
		return fmt.Errorf("hosted sync pending batch contract is inconsistent")
	}
	if envelope.WorkspaceID != scope.WorkspaceID {
		return fmt.Errorf("hosted sync pending batch targets a different workspace")
	}
	return nil
}

func postPending(ctx context.Context, client HTTPDoer, batchURL, token, userAgent string, pending *pendingBatch) (receipt, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, batchURL, bytes.NewReader(pending.Body))
	if err != nil {
		return receipt{}, fmt.Errorf("create hosted sync request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", pending.IdempotencyKey)
	if userAgent != "" {
		req.Header.Set("User-Agent", userAgent)
	}
	response, err := client.Do(req)
	if err != nil {
		return receipt{}, fmt.Errorf("hosted sync request failed; local capture is unaffected: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBytes))
		return receipt{}, hostedStatusError(response)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return receipt{}, fmt.Errorf("read hosted receipt; local capture is unaffected: %w", err)
	}
	if len(body) > maxResponseBytes {
		return receipt{}, fmt.Errorf("hosted receipt exceeded %d bytes; local cursor was not advanced", maxResponseBytes)
	}
	var got receipt
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&got); err != nil {
		return receipt{}, fmt.Errorf("hosted receipt was invalid; local cursor was not advanced")
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return receipt{}, fmt.Errorf("hosted receipt had trailing content; local cursor was not advanced")
	}
	if got.Accepted != pending.Events || got.SchemaVersion != receiptSchemaVersion ||
		!strings.HasPrefix(got.BatchID, "batch_") || got.WorkspaceID == "" || len(got.WorkspaceID) > 128 {
		return receipt{}, fmt.Errorf("hosted receipt did not match the pending batch; local cursor was not advanced")
	}
	return got, nil
}

func hostedStatusError(response *http.Response) error {
	status := response.StatusCode
	switch status {
	case http.StatusBadRequest:
		return fmt.Errorf("hosted API rejected the redacted batch contract (400); local cursor was not advanced")
	case http.StatusUnauthorized:
		return fmt.Errorf("hosted API rejected the device credential (401); local capture is unaffected")
	case http.StatusForbidden:
		return fmt.Errorf("hosted API refused this device or workspace entitlement (403); local capture is unaffected")
	case http.StatusNotFound:
		return fmt.Errorf("hosted workspace, endpoint, or tenant binding was not found (404); local capture is unaffected")
	case http.StatusConflict:
		return fmt.Errorf("hosted API reported an idempotency or evidence conflict (409); local cursor was not advanced")
	case http.StatusRequestEntityTooLarge:
		return fmt.Errorf("hosted API rejected the batch size (413); local cursor was not advanced")
	case http.StatusTooManyRequests:
		retry := response.Header.Get("Retry-After")
		if _, err := strconv.Atoi(retry); err == nil && retry != "" {
			return fmt.Errorf("hosted API is rate-limited (429; retry after %s seconds); local capture is unaffected", retry)
		}
		return fmt.Errorf("hosted API is rate-limited (429); local capture is unaffected")
	case http.StatusServiceUnavailable:
		return fmt.Errorf("hosted quota or storage is temporarily unavailable (503); local cursor was not advanced and local capture is unaffected")
	default:
		return fmt.Errorf("hosted API returned HTTP %d; local cursor was not advanced and local capture is unaffected", status)
	}
}
