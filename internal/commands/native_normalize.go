package commands

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// nativeNormalizeOptions is shared by provider-native transcript commands so
// Codex and Claude produce the same canonical association and import behavior.
type nativeNormalizeOptions struct {
	WorkstreamID string
	SessionID    string
	Import       bool
	JSON         bool
}

func rejectNormalizeOnlyFlags(command, subcommand, workstreamID, sessionID string, importEvents bool) error {
	if subcommand == "normalize" {
		return nil
	}
	var flags []string
	if workstreamID != "" {
		flags = append(flags, "--workstream")
	}
	if sessionID != "" {
		flags = append(flags, "--session")
	}
	if importEvents {
		flags = append(flags, "--import")
	}
	if len(flags) == 0 {
		return nil
	}
	return fmt.Errorf("%s %s: %s only valid with normalize", command, subcommand, strings.Join(flags, ", "))
}

// finishNativeNormalize associates normalized events with a canonical
// workstream/session, then either prints them or appends them to the local
// event log. Association changes no event provenance: the provider record is
// still OBSERVED, while the user-selected workstream is routing metadata.
func finishNativeNormalize(ctx context.Context, c *cli.Context, command, provider string, events []protocol.Event, opts nativeNormalizeOptions) error {
	sessionID, nativeID, err := associateNativeEvents(provider, events, opts.WorkstreamID, opts.SessionID)
	if err != nil {
		return fmt.Errorf("%s: %w", command, err)
	}

	if opts.Import {
		if opts.WorkstreamID == "" {
			return fmt.Errorf("%s: --import requires --workstream", command)
		}
		if opts.JSON {
			return fmt.Errorf("%s: --json and --import are mutually exclusive", command)
		}
		_, db, err := loadConfigAndDB()
		if err != nil {
			return fmt.Errorf("%s: %w", command, err)
		}
		defer db.Close()

		workstreams, err := db.ListWorkstreams(ctx)
		if err != nil {
			return fmt.Errorf("%s: list workstreams: %w", command, err)
		}
		workstreamExists := false
		for _, workstream := range workstreams {
			if workstream.ID == opts.WorkstreamID {
				workstreamExists = true
				break
			}
		}
		if !workstreamExists {
			return fmt.Errorf("%s: workstream %s does not exist; create it with `handoffgraph workstream new <title>` first", command, opts.WorkstreamID)
		}

		batch := make([]*protocol.Event, len(events))
		for i := range events {
			batch[i] = &events[i]
		}
		result, err := db.AppendEventsAtomic(ctx, batch)
		if err != nil {
			return fmt.Errorf("%s: %w", command, err)
		}
		fmt.Fprintf(c.Stdout, "imported %d new event(s), %d already present; provider=%s native_session=%s session=%s workstream=%s\n",
			result.Inserted, result.Existing, provider, nativeID, sessionID, opts.WorkstreamID)
		return nil
	}

	if opts.JSON {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(events)
	}
	for i := range events {
		line, err := json.Marshal(&events[i])
		if err != nil {
			return fmt.Errorf("%s: encode event %d: %w", command, i+1, err)
		}
		fmt.Fprintln(c.Stdout, string(line))
	}
	return nil
}

// associateNativeEvents applies one explicit workstream and one canonical
// session to every event in a transcript. When --session is omitted, the
// session id is a deterministic ULID derived from provider + observed native
// session id, so Codex and Claude imports are idempotent without hand-rolled
// identifiers. Existing no-flag normalize output remains unchanged.
func associateNativeEvents(provider string, events []protocol.Event, workstreamID, sessionID string) (string, string, error) {
	if workstreamID != "" {
		if !strings.HasPrefix(workstreamID, ids.PrefixWorkstream) || !ids.IsValid(workstreamID) {
			return "", "", fmt.Errorf("--workstream must be a valid %s ULID, got %q", ids.PrefixWorkstream, workstreamID)
		}
	}
	if sessionID != "" {
		if !strings.HasPrefix(sessionID, ids.PrefixSession) || !ids.IsValid(sessionID) {
			return "", "", fmt.Errorf("--session must be a valid %s ULID, got %q", ids.PrefixSession, sessionID)
		}
	}

	nativeIDs := map[string]bool{}
	for i := range events {
		if events[i].Provider != "" && events[i].Provider != provider {
			return "", "", fmt.Errorf("event %d provider %q does not match %q", i+1, events[i].Provider, provider)
		}
		if events[i].NativeSessionID != "" {
			nativeIDs[events[i].NativeSessionID] = true
		}
	}
	if len(nativeIDs) > 1 {
		return "", "", fmt.Errorf("transcript contains %d native session ids", len(nativeIDs))
	}
	nativeID := ""
	for id := range nativeIDs {
		nativeID = id
	}

	if sessionID == "" && workstreamID != "" {
		if nativeID == "" {
			return "", "", fmt.Errorf("cannot derive --session: transcript has no native session id")
		}
		sessionID = ids.Deterministic(ids.PrefixSession, "native-session|"+provider+"|"+nativeID, 0)
	}

	if workstreamID == "" && sessionID == "" {
		return "", nativeID, nil
	}
	for i := range events {
		if workstreamID != "" {
			events[i].WorkstreamID = workstreamID
		}
		if sessionID != "" {
			events[i].SessionID = sessionID
		}
	}
	return sessionID, nativeID, nil
}
