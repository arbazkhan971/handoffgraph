package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
	modernsqlite "modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

const (
	atomicBusyTimeoutMillis  = 25
	defaultBusyTimeoutMillis = 5000
)

var (
	// ErrEventConflict means an existing event id names a different immutable
	// envelope. Treating it as an idempotent duplicate would silently discard
	// evidence or re-associate it with another workstream/session.
	ErrEventConflict = errors.New("event id conflict")
	// ErrSessionOwnershipConflict means a canonical session id already has a
	// different non-empty workstream, provider, or native-session claim.
	ErrSessionOwnershipConflict = errors.New("session ownership conflict")
	// ErrDuplicateBatchEvent means one requested atomic batch contains the same
	// event id more than once. Even identical duplicates are rejected so result
	// counts and append order stay unambiguous.
	ErrDuplicateBatchEvent = errors.New("duplicate event id in batch")
)

// EventBatchResult reports the committed outcome of AppendEventsAtomic.
type EventBatchResult struct {
	Inserted int
	Existing int
}

type preparedEvent struct {
	event *protocol.Event
	raw   string
}

type sessionOwnership struct {
	WorkstreamID    string
	SessionID       string
	Provider        string
	NativeSessionID string
	rows            int
}

// AppendEventsAtomic compares and appends one immutable event batch in a
// single SQLite writer transaction. It guarantees:
//   - duplicate ids inside the incoming batch fail before BEGIN;
//   - an existing id is idempotent only when its complete raw envelope is
//     byte-identical to the requested event;
//   - each canonical session id maps to at most one non-empty workstream,
//     provider, and native-session tuple;
//   - every new event commits, or none does.
//
// BEGIN IMMEDIATE serializes independent DB handles before any ownership or
// event comparison. A concurrent winner therefore becomes visible to the
// waiting importer and is envelope-compared instead of being silently ignored.
func (d *DB) AppendEventsAtomic(ctx context.Context, events []*protocol.Event) (EventBatchResult, error) {
	return d.appendEventsAtomic(ctx, events, nil)
}

// batchAppendHook is an internal deterministic fault/cancellation point used
// by storage tests to prove rollback after at least one successful INSERT.
type batchAppendHook func(index int) error

func (d *DB) appendEventsAtomic(ctx context.Context, events []*protocol.Event, hook batchAppendHook) (result EventBatchResult, err error) {
	prepared, bySession, err := prepareEventBatch(ctx, events)
	if err != nil {
		return EventBatchResult{}, err
	}

	conn, err := d.sql.Conn(ctx)
	if err != nil {
		return EventBatchResult{}, err
	}
	defer conn.Close()
	if err = setSQLiteBusyTimeout(ctx, conn, atomicBusyTimeoutMillis); err != nil {
		return EventBatchResult{}, fmt.Errorf("configure atomic event batch lock timeout: %w", err)
	}
	defer restoreSQLiteBusyTimeout(conn)
	if err = beginImmediate(ctx, conn); err != nil {
		return EventBatchResult{}, fmt.Errorf("begin atomic event batch: %w", err)
	}
	committed := false
	defer func() {
		if committed {
			return
		}
		rollbackCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, rollbackErr := conn.ExecContext(rollbackCtx, "ROLLBACK"); rollbackErr != nil && err == nil {
			err = fmt.Errorf("rollback atomic event batch: %w", rollbackErr)
		}
	}()

	if err = validateStoredOwnership(ctx, conn, bySession); err != nil {
		return EventBatchResult{}, err
	}

	for i, item := range prepared {
		if err = ctx.Err(); err != nil {
			return EventBatchResult{}, err
		}
		if hook != nil {
			if err = hook(i); err != nil {
				return EventBatchResult{}, err
			}
			if err = ctx.Err(); err != nil {
				return EventBatchResult{}, err
			}
		}

		var existingRaw string
		queryErr := conn.QueryRowContext(ctx,
			"SELECT raw_json FROM events WHERE event_id = ?", item.event.EventID,
		).Scan(&existingRaw)
		switch {
		case queryErr == nil:
			if existingRaw != item.raw {
				return EventBatchResult{}, fmt.Errorf("%w: event %s already exists with a different immutable envelope", ErrEventConflict, item.event.EventID)
			}
			result.Existing++
			continue
		case !errors.Is(queryErr, sql.ErrNoRows):
			return EventBatchResult{}, fmt.Errorf("compare event %s: %w", item.event.EventID, queryErr)
		}

		if _, err = conn.ExecContext(ctx, `
INSERT INTO events
    (event_id, occurred_at, observed_at, workstream_id, session_id,
     native_session_id, provider, kind, provenance, content_hash, raw_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			item.event.EventID, item.event.OccurredAt.UnixNano(), item.event.ObservedAt.UnixNano(),
			nullable(item.event.WorkstreamID), nullable(item.event.SessionID),
			nullable(item.event.NativeSessionID), nullable(item.event.Provider),
			string(item.event.Kind), nullable(string(item.event.Provenance)),
			nullable(item.event.ContentHash), item.raw,
		); err != nil {
			return EventBatchResult{}, fmt.Errorf("append event %s: %w", item.event.EventID, err)
		}
		result.Inserted++
	}

	if _, err = conn.ExecContext(ctx, "COMMIT"); err != nil {
		return EventBatchResult{}, fmt.Errorf("commit atomic event batch: %w", err)
	}
	committed = true
	return result, nil
}

func beginImmediate(ctx context.Context, conn *sql.Conn) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err == nil {
			return nil
		} else if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		} else if !isSQLiteBusy(err) {
			return err
		}
	}
}

func setSQLiteBusyTimeout(ctx context.Context, conn *sql.Conn, milliseconds int) error {
	_, err := conn.ExecContext(ctx, fmt.Sprintf("PRAGMA busy_timeout = %d", milliseconds))
	return err
}

func restoreSQLiteBusyTimeout(conn *sql.Conn) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = setSQLiteBusyTimeout(ctx, conn, defaultBusyTimeoutMillis)
}

func isSQLiteBusy(err error) bool {
	var sqliteErr *modernsqlite.Error
	return errors.As(err, &sqliteErr) && sqliteErr.Code()&0xff == sqlite3.SQLITE_BUSY
}

func prepareEventBatch(ctx context.Context, events []*protocol.Event) ([]preparedEvent, map[string]sessionOwnership, error) {
	prepared := make([]preparedEvent, 0, len(events))
	seenIDs := make(map[string]bool, len(events))
	bySession := map[string]sessionOwnership{}
	for i, event := range events {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		if event == nil {
			return nil, nil, fmt.Errorf("event %d is nil", i+1)
		}
		if strings.TrimSpace(event.EventID) == "" {
			return nil, nil, fmt.Errorf("event %d has empty event id", i+1)
		}
		if seenIDs[event.EventID] {
			return nil, nil, fmt.Errorf("%w: %s", ErrDuplicateBatchEvent, event.EventID)
		}
		seenIDs[event.EventID] = true
		raw, err := json.Marshal(event)
		if err != nil {
			return nil, nil, fmt.Errorf("encode event %s: %w", event.EventID, err)
		}
		prepared = append(prepared, preparedEvent{event: event, raw: string(raw)})

		incoming := sessionOwnership{
			WorkstreamID:    event.WorkstreamID,
			SessionID:       event.SessionID,
			Provider:        event.Provider,
			NativeSessionID: event.NativeSessionID,
		}
		if event.SessionID != "" {
			merged, err := mergeOwnership(bySession[event.SessionID], incoming, "incoming session "+event.SessionID)
			if err != nil {
				return nil, nil, err
			}
			bySession[event.SessionID] = merged
		}
	}
	return prepared, bySession, nil
}

func validateStoredOwnership(ctx context.Context, conn *sql.Conn, bySession map[string]sessionOwnership) error {
	sessionIDs := sortedOwnershipKeys(bySession)
	for _, sessionID := range sessionIDs {
		incoming := bySession[sessionID]
		existing, found, err := storedSessionOwnership(ctx, conn, sessionID)
		if err != nil {
			return err
		}
		if found {
			if err := compareOwnership(existing, incoming, "canonical session "+sessionID); err != nil {
				return err
			}
		}
	}
	return nil
}

func storedSessionOwnership(ctx context.Context, conn *sql.Conn, sessionID string) (sessionOwnership, bool, error) {
	rows, err := conn.QueryContext(ctx, `
SELECT workstream_id, provider, native_session_id
FROM events WHERE session_id = ?`, sessionID)
	if err != nil {
		return sessionOwnership{}, false, err
	}
	defer rows.Close()
	ownership := sessionOwnership{SessionID: sessionID}
	for rows.Next() {
		var workstream, provider, native sql.NullString
		if err := rows.Scan(&workstream, &provider, &native); err != nil {
			return sessionOwnership{}, false, err
		}
		row := sessionOwnership{WorkstreamID: workstream.String, SessionID: sessionID, Provider: provider.String, NativeSessionID: native.String, rows: 1}
		ownership, err = mergeOwnership(ownership, row, "stored canonical session "+sessionID)
		if err != nil {
			return sessionOwnership{}, false, err
		}
	}
	if err := rows.Err(); err != nil {
		return sessionOwnership{}, false, err
	}
	return ownership, ownership.rows > 0, nil
}

func mergeOwnership(current, next sessionOwnership, scope string) (sessionOwnership, error) {
	current.rows += next.rows
	fields := []struct {
		name  string
		dst   *string
		value string
	}{
		{"workstream", &current.WorkstreamID, next.WorkstreamID},
		{"session", &current.SessionID, next.SessionID},
		{"provider", &current.Provider, next.Provider},
		{"native session", &current.NativeSessionID, next.NativeSessionID},
	}
	for _, field := range fields {
		if field.value == "" {
			continue
		}
		if *field.dst == "" {
			*field.dst = field.value
			continue
		}
		if *field.dst != field.value {
			return sessionOwnership{}, fmt.Errorf("%w: %s has conflicting %s values %q and %q", ErrSessionOwnershipConflict, scope, field.name, *field.dst, field.value)
		}
	}
	return current, nil
}

func compareOwnership(existing, incoming sessionOwnership, scope string) error {
	fields := []struct {
		name     string
		existing string
		incoming string
	}{
		{"workstream", existing.WorkstreamID, incoming.WorkstreamID},
		{"session", existing.SessionID, incoming.SessionID},
		{"provider", existing.Provider, incoming.Provider},
		{"native session", existing.NativeSessionID, incoming.NativeSessionID},
	}
	for _, field := range fields {
		if field.incoming == "" {
			continue
		}
		if field.existing == "" {
			continue // blank legacy fields are non-claims, never conflicting claims
		}
		if field.existing != field.incoming {
			return fmt.Errorf("%w: %s is owned by %s %q, not %q", ErrSessionOwnershipConflict, scope, field.name, field.existing, field.incoming)
		}
	}
	return nil
}

func sortedOwnershipKeys(values map[string]sessionOwnership) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
