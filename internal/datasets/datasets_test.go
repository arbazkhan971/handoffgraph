package datasets

import (
	"encoding/json"
	"math/rand"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func TestBuildVersionHashStableAndOrderIndependent(t *testing.T) {
	f1 := InputFile{Name: "a.jsonl", Data: []byte("{\"schema_version\":\"hfg.event.v1\",\"event_id\":\"evt_x\",\"kind\":\"log.observed\"}\n")}
	f2 := InputFile{Name: "b.jsonl", Data: []byte("{\"schema_version\":\"hfg.event.v1\",\"event_id\":\"evt_y\",\"kind\":\"log.observed\"}\n")}
	v1, err := BuildVersion("ds", []InputFile{f1, f2})
	if err != nil {
		t.Fatal(err)
	}
	v2, err := BuildVersion("ds", []InputFile{f2, f1})
	if err != nil {
		t.Fatal(err)
	}
	if v1.Version != v2.Version {
		t.Fatalf("version hash depends on file order: %s vs %s", v1.Version, v2.Version)
	}
	v3, err := BuildVersion("ds", []InputFile{f1, {Name: "b.jsonl", Data: []byte("{\"schema_version\":\"hfg.event.v1\",\"event_id\":\"evt_z\",\"kind\":\"log.observed\"}\n")}})
	if err != nil {
		t.Fatal(err)
	}
	if v3.Version == v1.Version {
		t.Fatal("content change must change the version hash")
	}
	if len(v1.Files) != 2 || v1.Files[0].Name != "a.jsonl" || v1.Files[0].EventCount != 1 {
		t.Fatalf("files = %+v", v1.Files)
	}
}

func TestValidateFileFailClosed(t *testing.T) {
	if _, _, err := ValidateFile(nil); err == nil {
		t.Fatal("empty accepted")
	}
	if _, _, err := ValidateFile([]byte("{\"broken\"\n")); err == nil {
		t.Fatal("malformed JSONL accepted")
	}
	if _, _, err := ValidateFile([]byte("bad-\xff-utf8\n")); err == nil {
		t.Fatal("invalid UTF-8 accepted")
	}
	n, hash, err := ValidateFile([]byte("{\"schema_version\":\"hfg.event.v1\",\"kind\":\"log.observed\"}\n\n"))
	if err != nil || n != 1 || hash == "" {
		t.Fatalf("valid file rejected: %d %q %v", n, hash, err)
	}
}

func TestMaterializeDeterministic(t *testing.T) {
	base := time.Date(2026, 8, 28, 13, 0, 0, 0, time.UTC)
	mk := func(t *testing.T, kind protocol.EventKind, payload string, at time.Time) *protocol.Event {
		t.Helper()
		return &protocol.Event{
			SchemaVersion: protocol.SchemaVersionEvent,
			EventID:       ids.Event(),
			OccurredAt:    at,
			ObservedAt:    at,
			Kind:          kind,
			Provenance:    protocol.ProvenanceObserved,
			Payload:       json.RawMessage(payload),
		}
	}
	var events []*protocol.Event
	for i, ver := range []string{"aaa", "bbb"} {
		events = append(events, mk(t, protocol.EventDatasetCreated,
			`{"name":"ds","version":"`+ver+`","files":[{"name":"a.jsonl","hash":"h","event_count":1}]}`,
			base.Add(time.Duration(i)*time.Second)))
	}
	shuffled := make([]*protocol.Event, len(events))
	copy(shuffled, events)
	rand.Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })
	a := Materialize(events)
	b := Materialize(shuffled)
	ab, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	if string(ab) != string(bb) {
		t.Fatal("materialize depends on input order")
	}
	latest := LatestByName(a)
	if latest["ds"].Version != "bbb" {
		t.Fatalf("latest = %+v", latest["ds"])
	}
}

func TestCompareRegressions(t *testing.T) {
	a := ExperimentRecord{Dataset: "ds", Version: "v1", Results: []ExampleResult{
		{Name: "x", Status: "ok", P0Detections: 0},
		{Name: "y", Status: "detections", P0Detections: 1},
	}}
	b := ExperimentRecord{Dataset: "ds", Version: "v1", Results: []ExampleResult{
		{Name: "x", Status: "detections", P0Detections: 1},
		{Name: "y", Status: "detections", P0Detections: 2},
	}}
	cmps := Compare(a, b)
	if len(cmps) != 2 {
		t.Fatalf("comparisons = %d", len(cmps))
	}
	if !cmps[0].Regression {
		t.Fatal("ok -> detections must be a regression")
	}
	if !cmps[1].Regression {
		t.Fatal("p0 increase must be a regression")
	}
}
