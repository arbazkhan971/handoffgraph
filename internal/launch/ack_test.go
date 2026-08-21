package launch

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// createHandoff records one handoff for wsID and returns its id.
func createHandoff(t *testing.T, db *storage.DB, wsID string) string {
	t.Helper()
	cp := codexCheckpoint()
	cp.WorkstreamID = wsID
	if err := db.SaveCheckpoint(context.Background(), cp); err != nil {
		t.Fatalf("SaveCheckpoint: %v", err)
	}
	res, err := Continue(context.Background(), db, Options{
		WorkstreamID: wsID,
		TargetAgent:  protocol.ProviderCodex,
		Repo:         matchingRepo(),
		Now:          fixedTime(),
	})
	if err != nil {
		t.Fatalf("Continue: %v", err)
	}
	return res.Handoff.ID
}

func listEvents(t *testing.T, db *storage.DB) []*protocol.Event {
	t.Helper()
	events, err := db.ListEvents(context.Background())
	if err != nil {
		t.Fatalf("ListEvents: %v", err)
	}
	return events
}

func eventCount(t *testing.T, db *storage.DB) int64 {
	t.Helper()
	n, err := db.EventCount(context.Background())
	if err != nil {
		t.Fatalf("EventCount: %v", err)
	}
	return n
}

func TestAcceptHandoff(t *testing.T) {
	db := testDB(t)
	id := createHandoff(t, db, "ws_ack")
	acceptedAt := fixedTime().Add(time.Minute)
	acceptNow = func() time.Time { return acceptedAt }
	t.Cleanup(func() { acceptNow = func() time.Time { return time.Now().UTC() } })

	rec, err := AcceptHandoff(context.Background(), db, id,
		[]string{"objective", "next_actions"},
		[]string{"repo_state"},
		[]string{"failed_approaches"},
	)
	if err != nil {
		t.Fatalf("AcceptHandoff: %v", err)
	}
	if rec.Status != StatusAccepted {
		t.Errorf("returned status = %q, want %q", rec.Status, StatusAccepted)
	}
	if !rec.AcceptedAt.Equal(acceptedAt) {
		t.Errorf("accepted_at = %v, want %v", rec.AcceptedAt, acceptedAt)
	}

	// The event log carries exactly created + accepted.
	events := listEvents(t, db)
	if len(events) != 2 {
		t.Fatalf("stored %d events, want 2", len(events))
	}
	last := events[len(events)-1]
	if last.Kind != protocol.EventHandoffAccepted {
		t.Fatalf("second event kind = %q, want handoff.accepted", last.Kind)
	}
	if last.Provider != protocol.ProviderCodex {
		t.Errorf("provider = %q, want codex (the accepting agent)", last.Provider)
	}
	if last.Provenance != protocol.ProvenanceDeclared {
		t.Errorf("provenance = %q, want DECLARED", last.Provenance)
	}
	var p acceptedPayload
	if err := json.Unmarshal(last.Payload, &p); err != nil {
		t.Fatalf("payload decode: %v", err)
	}
	if p.HandoffID != id {
		t.Errorf("payload handoff_id = %q, want %q", p.HandoffID, id)
	}
	if strings.Join(p.Accepted, ",") != "next_actions,objective" {
		t.Errorf("payload accepted = %v, want sorted [next_actions objective]", p.Accepted)
	}
	if strings.Join(p.Missing, ",") != "repo_state" {
		t.Errorf("payload missing = %v, want [repo_state]", p.Missing)
	}
	if strings.Join(p.Unverifiable, ",") != "failed_approaches" {
		t.Errorf("payload unverifiable = %v, want [failed_approaches]", p.Unverifiable)
	}

	// The derived read model reflects acceptance.
	recs, err := ListHandoffs(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 1 || recs[0].Status != StatusAccepted {
		t.Fatalf("read model = %+v, want one accepted record", recs)
	}
	if strings.Join(recs[0].Accepted, ",") != "next_actions,objective" {
		t.Errorf("read model accepted = %v", recs[0].Accepted)
	}
}

func TestAcceptHandoffSortsAndDedupesInput(t *testing.T) {
	db := testDB(t)
	id := createHandoff(t, db, "ws_dedupe")
	acceptNow = func() time.Time { return fixedTime().Add(2 * time.Minute) }
	t.Cleanup(func() { acceptNow = func() time.Time { return time.Now().UTC() } })

	_, err := AcceptHandoff(context.Background(), db, id,
		[]string{"zeta", "alpha", "zeta", "mid"},
		nil,
		nil,
	)
	if err != nil {
		t.Fatalf("AcceptHandoff: %v", err)
	}
	var last *protocol.Event
	for _, ev := range listEvents(t, db) {
		if ev.Kind == protocol.EventHandoffAccepted {
			last = ev
		}
	}
	if last == nil {
		t.Fatal("no handoff.accepted event appended")
	}
	var p acceptedPayload
	if err := json.Unmarshal(last.Payload, &p); err != nil {
		t.Fatal(err)
	}
	if strings.Join(p.Accepted, ",") != "alpha,mid,zeta" {
		t.Errorf("accepted = %v, want sorted deduped [alpha mid zeta]", p.Accepted)
	}
}

func TestAcceptHandoffUnknownIDFailsClosed(t *testing.T) {
	db := testDB(t)
	createHandoff(t, db, "ws_closed")

	_, err := AcceptHandoff(context.Background(), db, "ho_unknown", []string{"objective"}, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "no handoff ho_unknown") {
		t.Fatalf("error = %v, want unknown-handoff error", err)
	}
	if n := eventCount(t, db); n != 1 {
		t.Errorf("event count = %d, want 1 (nothing appended on failure)", n)
	}
}

func TestAcceptHandoffRequiresID(t *testing.T) {
	db := testDB(t)
	if _, err := AcceptHandoff(context.Background(), db, "", nil, nil, nil); err == nil {
		t.Fatal("empty handoff id accepted, want error")
	}
}

func TestListHandoffsOrderedAndFolded(t *testing.T) {
	db := testDB(t)
	first := createHandoff(t, db, "ws_order_1")
	second := createHandoff(t, db, "ws_order_2")
	acceptNow = func() time.Time { return fixedTime().Add(3 * time.Minute) }
	t.Cleanup(func() { acceptNow = func() time.Time { return time.Now().UTC() } })

	if _, err := AcceptHandoff(context.Background(), db, second, []string{"objective"}, nil, nil); err != nil {
		t.Fatalf("AcceptHandoff: %v", err)
	}

	recs, err := ListHandoffs(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 2 {
		t.Fatalf("records = %d, want 2", len(recs))
	}
	if recs[0].ID != first || recs[0].Status != StatusCreated {
		t.Errorf("first record = %s/%s, want %s/created", recs[0].ID, recs[0].Status, first)
	}
	if recs[1].ID != second || recs[1].Status != StatusAccepted {
		t.Errorf("second record = %s/%s, want %s/accepted", recs[1].ID, recs[1].Status, second)
	}
	if strings.Join(recs[1].Accepted, ",") != "objective" {
		t.Errorf("folded accepted = %v, want [objective]", recs[1].Accepted)
	}

	// The fold is stable across calls (deterministic ordering).
	again, err := ListHandoffs(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	for i := range recs {
		if recs[i].ID != again[i].ID || recs[i].Status != again[i].Status {
			t.Fatalf("ListHandoffs unstable: %+v vs %+v", recs[i], again[i])
		}
	}
}

func TestListHandoffsFoldsOutOfOrderAcceptance(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	id := createHandoff(t, db, "ws_ooo")

	// An accept event whose occurred_at precedes the created event: the
	// event store orders by occurred_at, so the fold sees accepted before
	// created. The acknowledgement must still apply (two-pass fold).
	acceptNow = func() time.Time { return fixedTime().Add(-time.Hour) }
	t.Cleanup(func() { acceptNow = func() time.Time { return time.Now().UTC() } })
	if _, err := AcceptHandoff(ctx, db, id, []string{"objective"}, nil, nil); err != nil {
		t.Fatalf("AcceptHandoff: %v", err)
	}

	recs, err := ListHandoffs(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 1 {
		t.Fatalf("records = %d, want 1", len(recs))
	}
	if recs[0].Status != StatusAccepted {
		t.Errorf("status = %q, want accepted (out-of-order fold)", recs[0].Status)
	}
	if strings.Join(recs[0].Accepted, ",") != "objective" {
		t.Errorf("accepted = %v, want [objective]", recs[0].Accepted)
	}
}
