package commands

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"sort"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/scores"
	"github.com/handoffgraph/handoffgraph/internal/trace"
)

// RegisterAnalyticsCmd registers usage rollups (row 37) and coding-agent
// outcome analytics (row 38).
//
// Usage:
//
//	handoffgraph query usage [--workstream <id>] [--group-by provider|session] [--json]
//	handoffgraph outcomes [--workstream <id>] [--json]
//
// Both are pure derived views over the append-only event log.
func RegisterAnalyticsCmd(app *cli.App) {
	app.Register(&cli.Command{
		Name:    "outcomes",
		Summary: "Per-workstream coding-agent outcomes: files, commands, tests, handoffs",
		Usage:   "[--workstream <id>] [--json]",
		Flags: func(fs *flag.FlagSet) {
			fs.String("workstream", "", "restrict to one workstream")
			fs.Bool("json", false, "emit JSON")
		},
		Run: outcomesCmd,
	})
}

// usageGroup is one usage rollup row.
type usageGroup struct {
	Group           string `json:"group"`
	Traces          int    `json:"traces"`
	TokenInput      int64  `json:"token_input"`
	TokenOutput     int64  `json:"token_output"`
	TokenCacheRead  int64  `json:"token_cache_read"`
	TokenCacheWrite int64  `json:"token_cache_write"`
	CostAmount      string `json:"cost_amount,omitempty"`
	CostProvenance  string `json:"cost_provenance,omitempty"`
}

func queryUsageCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()

	events, err := db.ListEvents(ctx)
	if err != nil {
		return err
	}
	res := trace.Materialize(events)
	workstream := stringFlag(fs, "workstream")
	groupBy := stringFlag(fs, "group-by")
	if groupBy == "" {
		groupBy = "provider"
	}
	if groupBy != "provider" && groupBy != "session" {
		return fmt.Errorf("--group-by must be provider or session")
	}

	groups := map[string]*usageGroup{}
	add := func(key string) *usageGroup {
		g, ok := groups[key]
		if !ok {
			g = &usageGroup{Group: key}
			groups[key] = g
		}
		return g
	}
	for _, tr := range res.Traces {
		if workstream != "" && tr.WorkstreamID != workstream {
			continue
		}
		key := tr.Provider
		if groupBy == "session" {
			key = tr.SessionID
		}
		g := add(key)
		g.Traces++
		if tr.TokenInput != nil {
			g.TokenInput += *tr.TokenInput
		}
		if tr.TokenOutput != nil {
			g.TokenOutput += *tr.TokenOutput
		}
		if tr.TokenCacheRead != nil {
			g.TokenCacheRead += *tr.TokenCacheRead
		}
		if tr.TokenCacheWrite != nil {
			g.TokenCacheWrite += *tr.TokenCacheWrite
		}
		if tr.CostAmount != "" {
			// Costs are decimal strings; summing strings here would need a
			// decimal type. Until one lands, report the provenance-labelled
			// value of the costliest trace verbatim rather than fake math.
			if g.CostAmount == "" || len(tr.CostAmount) > len(g.CostAmount) {
				g.CostAmount = tr.CostAmount
				g.CostProvenance = string(tr.CostProvenance)
			}
		}
	}

	keys := make([]string, 0, len(groups))
	for k := range groups {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]*usageGroup, 0, len(keys))
	for _, k := range keys {
		out = append(out, groups[k])
	}

	if boolFlag(fs, "json") {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(out)
	}
	fmt.Fprintf(c.Stdout, "%-24s %7s %10s %10s %10s %10s %12s\n",
		"GROUP", "TRACES", "IN", "OUT", "CACHE_R", "CACHE_W", "COST")
	for _, g := range out {
		cost := g.CostAmount
		if cost == "" {
			cost = "-"
		}
		fmt.Fprintf(c.Stdout, "%-24s %7d %10d %10d %10d %10d %12s\n",
			g.Group, g.Traces, g.TokenInput, g.TokenOutput, g.TokenCacheRead, g.TokenCacheWrite, cost)
	}
	return nil
}

// Outcome is the per-workstream coding-agent outcome summary (row 38).
type Outcome struct {
	WorkstreamID   string `json:"workstream_id"`
	Sessions       int    `json:"sessions"`
	Traces         int    `json:"traces"`
	Spans          int    `json:"spans"`
	FailedSpans    int    `json:"failed_spans"`
	FilesTouched   int    `json:"files_touched"`
	CommandsRun    int    `json:"commands_run"`
	CommandsFailed int    `json:"commands_failed"`
	TestsPassed    int    `json:"tests_passed"`
	TestsFailed    int    `json:"tests_failed"`
	Decisions      int    `json:"decisions"`
	Handoffs       int    `json:"handoffs_created"`
	HandoffsAcked  int    `json:"handoffs_accepted"`
	Scores         int    `json:"scores"`
	FirstActivity  string `json:"first_activity,omitempty"`
	LastActivity   string `json:"last_activity,omitempty"`
}

func outcomesCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()

	events, err := db.ListEvents(ctx)
	if err != nil {
		return err
	}
	res := trace.Materialize(events)
	allScores := scores.Materialize(events)
	filter := stringFlag(fs, "workstream")

	byWS := map[string]*Outcome{}
	get := func(id string) *Outcome {
		o, ok := byWS[id]
		if !ok {
			o = &Outcome{WorkstreamID: id}
			byWS[id] = o
		}
		return o
	}
	// Workstreams the materializer knows about (traces carry the id).
	for _, tr := range res.Traces {
		if tr.WorkstreamID == "" {
			continue
		}
		o := get(tr.WorkstreamID)
		o.Traces++
		o.Spans += int(tr.SpanCount)
		o.FailedSpans += int(tr.FailedSpanCount)
		if o.FirstActivity == "" || (tr.StartedAtNS > 0 && rfc3339NS(tr.StartedAtNS) < o.FirstActivity) {
			o.FirstActivity = rfc3339NS(tr.StartedAtNS)
		}
	}
	// Span-level facts.
	for _, sp := range res.Spans {
		tr := traceByID(res, sp.TraceID)
		if tr == nil || tr.WorkstreamID == "" {
			continue
		}
		if filter != "" && tr.WorkstreamID != filter {
			continue
		}
		o := get(tr.WorkstreamID)
		switch sp.Kind {
		case protocol.SpanKindFileWrite, protocol.SpanKindFileRead:
			o.FilesTouched++
		case protocol.SpanKindCommand:
			o.CommandsRun++
			if sp.Status == "error" {
				o.CommandsFailed++
			}
		case protocol.SpanKindTest:
			if sp.Status == "error" {
				o.TestsFailed++
			} else {
				o.TestsPassed++
			}
		}
	}
	// Event-level facts per workstream.
	sessionSeen := map[string]map[string]bool{}
	for _, ev := range events {
		if ev.WorkstreamID == "" {
			continue
		}
		if filter != "" && ev.WorkstreamID != filter {
			continue
		}
		o := get(ev.WorkstreamID)
		if ev.SessionID != "" {
			if sessionSeen[ev.WorkstreamID] == nil {
				sessionSeen[ev.WorkstreamID] = map[string]bool{}
			}
			if !sessionSeen[ev.WorkstreamID][ev.SessionID] {
				sessionSeen[ev.WorkstreamID][ev.SessionID] = true
				o.Sessions++
			}
		}
		switch ev.Kind {
		case protocol.EventDecisionRecorded:
			o.Decisions++
		case protocol.EventHandoffCreated:
			o.Handoffs++
		case protocol.EventHandoffAccepted:
			o.HandoffsAcked++
		}
	}
	for _, s := range allScores {
		if s.WorkstreamID == "" || (filter != "" && s.WorkstreamID != filter) {
			continue
		}
		get(s.WorkstreamID).Scores++
	}

	ids := make([]string, 0, len(byWS))
	for id := range byWS {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]*Outcome, 0, len(ids))
	for _, id := range ids {
		o := byWS[id]
		if o.Traces == 0 && o.Sessions == 0 && o.Decisions == 0 && o.Handoffs == 0 && o.Scores == 0 {
			continue // workstream with no observed activity yet
		}
		if o.LastActivity == "" {
			for _, tr := range res.Traces {
				if tr.WorkstreamID == id && tr.EndedAtNS > 0 {
					if rfc3339NS(tr.EndedAtNS) > o.LastActivity {
						o.LastActivity = rfc3339NS(tr.EndedAtNS)
					}
				}
			}
		}
		out = append(out, o)
	}

	if boolFlag(fs, "json") {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(out)
	}
	for _, o := range out {
		fmt.Fprintf(c.Stdout, "%s  sessions=%d traces=%d spans=%d (failed %d)  files=%d  cmd=%d/%d failed  tests=%d/%d failed  decisions=%d  handoffs=%d/%d acked  scores=%d\n",
			o.WorkstreamID, o.Sessions, o.Traces, o.Spans, o.FailedSpans,
			o.FilesTouched, o.CommandsRun, o.CommandsFailed, o.TestsPassed, o.TestsFailed,
			o.Decisions, o.Handoffs, o.HandoffsAcked, o.Scores)
	}
	fmt.Fprintf(c.Stdout, "%d workstream(s)\n", len(out))
	return nil
}

func traceByID(res *trace.MaterializeResult, id string) *protocol.Trace {
	for _, tr := range res.Traces {
		if tr.TraceID == id {
			return tr
		}
	}
	return nil
}

func rfc3339NS(ns int64) string {
	if ns <= 0 {
		return ""
	}
	return time.Unix(0, ns).UTC().Format(time.RFC3339)
}
