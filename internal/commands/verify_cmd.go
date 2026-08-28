package commands

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"strings"
	"time"

	checkpointcore "github.com/handoffgraph/handoffgraph/internal/checkpoint"
	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/detection"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/redact"
	"github.com/handoffgraph/handoffgraph/internal/repository"
	"github.com/handoffgraph/handoffgraph/internal/scores"
	"github.com/handoffgraph/handoffgraph/internal/storage"
	"github.com/handoffgraph/handoffgraph/internal/trace"
)

// RegisterVerifyCmd registers the deterministic verification gate (parity
// rows 25-26): evidence checks + baseline regression comparison with plain
// CI exit codes.
//
// Usage:
//
//	handoffgraph verify --workstream <id> [--baseline <cp_id>] [--json] [--no-cache]
//
// Exit codes: 0 = all checks pass; 1 = at least one check failed or a
// regression against the baseline was found. A verification.recorded event
// is appended on every run so gates are themselves append-only evidence.
//
// The check set (never the baseline comparison, which is cwd/git-dependent)
// is cached per workstream and reused while the event log is unchanged
// (parity row 26 tail); --no-cache forces a recompute. The report's
// "cached" field says which happened.
func RegisterVerifyCmd(app *cli.App) {
	app.Register(&cli.Command{
		Name:    "verify",
		Summary: "Run deterministic evidence checks and gate on a baseline checkpoint",
		Usage:   "--workstream <id> [--baseline <cp_id>] [--json] [--no-cache]",
		Flags: func(fs *flag.FlagSet) {
			fs.String("workstream", "", "workstream to verify")
			fs.String("baseline", "", "baseline checkpoint id (cp_...) to compare against")
			fs.Bool("json", false, "emit JSON")
			fs.Bool("no-cache", false, "bypass and refresh the cached check results (parity row 26 tail)")
		},
		Run: verifyCmd,
	})
}

// Check is one deterministic verification result.
type Check struct {
	Name     string   `json:"name"`
	Passed   bool     `json:"passed"`
	Detail   string   `json:"detail,omitempty"`
	Evidence []string `json:"evidence,omitempty"`
}

// verifyReport is the structured verify output.
type verifyReport struct {
	WorkstreamID   string  `json:"workstream_id"`
	Passed         bool    `json:"passed"`
	Cached         bool    `json:"cached"`
	Checks         []Check `json:"checks"`
	BaselineID     string  `json:"baseline_id,omitempty"`
	BaselineScore  int     `json:"-"`
	CurrentScore   int     `json:"-"`
	ScoreDelta     int     `json:"score_delta,omitempty"`
	NewFailures    int     `json:"new_failures"`
	VerificationID string  `json:"verification_event_id,omitempty"`
}

func verifyCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	workstream := stringFlag(fs, "workstream")
	if workstream == "" {
		return fmt.Errorf("--workstream is required")
	}
	cfg, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()

	if !workstreamExists(ctx, db, workstream) {
		return fmt.Errorf("workstream %q not found", workstream)
	}
	events, err := db.ListEvents(ctx)
	if err != nil {
		return err
	}
	wsEvents := filterByWorkstream(events, workstream)

	var report verifyReport
	report.WorkstreamID = workstream

	// Materialize once: both the check set and the baseline's new-failures
	// scan read the same traces/spans, so a single pass here is reused by
	// both instead of each recomputing it independently.
	res := trace.Materialize(wsEvents)

	// Cache lookup (parity row 26 tail: cached results). Only the
	// deterministic []Check slice is ever cached — CurrentScore below is
	// cwd/git-dependent via repository.State and is always recomputed live.
	noCache := boolFlag(fs, "no-cache")
	cacheHit := false
	if !noCache {
		if cachedJSON, ok, cerr := db.VerifyCacheGet(ctx, workstream); cerr == nil && ok {
			var cached []Check
			if json.Unmarshal([]byte(cachedJSON), &cached) == nil {
				report.Checks = cached
				cacheHit = true
			}
		}
	}
	if !cacheHit {
		report.Checks = runVerifyChecks(wsEvents, res)
		// Best-effort: a caching failure must never block the gate itself.
		if checksJSON, jerr := json.Marshal(report.Checks); jerr == nil {
			if snapJSON, serr := db.VerifySnapshotJSON(ctx, workstream); serr == nil {
				if saveErr := db.VerifyCacheSave(ctx, workstream, snapJSON, string(checksJSON)); saveErr != nil {
					fmt.Fprintf(c.Stderr, "warning: verify cache save failed: %v\n", saveErr)
				}
			}
		}
	}
	report.Cached = cacheHit

	baselineID := stringFlag(fs, "baseline")
	if baselineID != "" {
		if err := applyBaseline(ctx, db, wsEvents, res, &report, baselineID, &redact.Options{
			DenyPaths:    cfg.RedactDenyPaths,
			UserPatterns: cfg.RedactPatterns,
		}); err != nil {
			return err
		}
	}

	report.Passed = true
	for _, ck := range report.Checks {
		if !ck.Passed {
			report.Passed = false
		}
	}
	if report.ScoreDelta < 0 && baselineID != "" {
		report.Passed = false
	}

	// Record the gate itself as append-only evidence (OBSERVED: the run and
	// its exit path are captured commands, matching record_verification
	// semantics — exit_code presence marks it OBSERVED).
	exitCode := 0
	if !report.Passed {
		exitCode = 1
	}
	verdict := "passed"
	if !report.Passed {
		verdict = "failed"
	}
	ver, _ := json.Marshal(map[string]any{
		"verification":  "handoffgraph verify",
		"result":        verdict,
		"command":       "handoffgraph verify --workstream " + workstream,
		"exit_code":     exitCode,
		"baseline":      baselineID,
		"failed_checks": failedCheckNames(report.Checks),
	})
	verificationEvent := &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       ids.Event(),
		OccurredAt:    time.Now().UTC(),
		ObservedAt:    time.Now().UTC(),
		WorkstreamID:  workstream,
		Kind:          protocol.EventVerificationRecorded,
		Provenance:    protocol.ProvenanceObserved,
		Payload:       ver,
	}
	if _, err := db.AppendEvent(ctx, verificationEvent); err != nil {
		return err
	}
	report.VerificationID = verificationEvent.EventID

	if boolFlag(fs, "json") {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	}
	for _, ck := range report.Checks {
		mark := "PASS"
		if !ck.Passed {
			mark = "FAIL"
		}
		fmt.Fprintf(c.Stdout, "%s  %s", mark, ck.Name)
		if ck.Detail != "" {
			fmt.Fprintf(c.Stdout, "  — %s", ck.Detail)
		}
		fmt.Fprintln(c.Stdout)
	}
	if baselineID != "" {
		fmt.Fprintf(c.Stdout, "baseline %s score %d → current %d (delta %+d), new failures: %d\n",
			baselineID, report.BaselineScore, report.CurrentScore, report.ScoreDelta, report.NewFailures)
	}
	fmt.Fprintf(c.Stdout, "%s (exit %d, verification %s)\n", verdict, exitCode, report.VerificationID)
	if !report.Passed {
		reasons := failedCheckNames(report.Checks)
		if report.ScoreDelta < 0 && baselineID != "" {
			reasons = append(reasons, fmt.Sprintf("score regression %+d vs baseline %s", report.ScoreDelta, baselineID))
		}
		return fmt.Errorf("verification failed: %s", strings.Join(reasons, ", "))
	}
	return nil
}

// runVerifyChecks executes the deterministic default check set. res is the
// caller's single trace.Materialize(wsEvents) pass, shared with
// applyBaseline so the event log is materialized only once per run.
func runVerifyChecks(wsEvents []*protocol.Event, res *trace.MaterializeResult) []Check {
	var checks []Check

	// 1. Trace liveness: no trace left mid-flight.
	running := 0
	for _, tr := range res.Traces {
		if tr.Status == protocol.TraceRunning {
			running++
		}
	}
	checks = append(checks, Check{
		Name:   "traces_closed",
		Passed: running == 0,
		Detail: fmt.Sprintf("%d running trace(s)", running),
	})

	// 2/3. Commands and tests: observed outcomes gate the workstream.
	cmdFailed, cmdTotal := 0, 0
	testFailed, testPassed := 0, 0
	var failedIDs []string
	for _, sp := range res.Spans {
		switch sp.Kind {
		case protocol.SpanKindCommand:
			cmdTotal++
			if sp.Status == "error" {
				cmdFailed++
				failedIDs = append(failedIDs, sp.SpanID)
			}
		case protocol.SpanKindTest:
			if sp.Status == "error" {
				testFailed++
				failedIDs = append(failedIDs, sp.SpanID)
			} else {
				testPassed++
			}
		}
	}
	checks = append(checks, Check{
		Name:   "commands_ok",
		Passed: cmdFailed == 0,
		Detail: fmt.Sprintf("%d/%d failed", cmdFailed, cmdTotal),
	})
	checks = append(checks, Check{
		Name:     "tests_pass",
		Passed:   testFailed == 0,
		Detail:   fmt.Sprintf("%d passed, %d failed", testPassed, testFailed),
		Evidence: failedIDs,
	})

	// 4. Handoff acknowledgement: a created handoff must be accepted.
	created, acked := 0, 0
	for _, ev := range wsEvents {
		switch ev.Kind {
		case protocol.EventHandoffCreated:
			created++
		case protocol.EventHandoffAccepted:
			acked++
		}
	}
	checks = append(checks, Check{
		Name:   "handoffs_acknowledged",
		Passed: created == 0 || acked > 0,
		Detail: fmt.Sprintf("%d created, %d accepted", created, acked),
	})

	// 5. Score rubric: deterministic default semantics for recorded scores.
	scoreFails := 0
	for _, s := range scores.Materialize(wsEvents) {
		bad := false
		switch s.DataType {
		case protocol.ScoreDataTypeBoolean:
			bad = s.BoolValue != nil && !*s.BoolValue
		case protocol.ScoreDataTypeCategory:
			switch strings.ToLower(s.StringValue) {
			case "rejected", "failed", "blocked":
				bad = true
			}
		case protocol.ScoreDataTypeNumeric:
			bad = s.Value != nil && *s.Value < 0.5
		}
		if bad {
			scoreFails++
		}
	}
	checks = append(checks, Check{
		Name:   "scores_pass",
		Passed: scoreFails == 0,
		Detail: fmt.Sprintf("%d failing score(s) under the default rubric", scoreFails),
	})

	// 6. Deterministic detection pack: no open P0-severity matches.
	engine, err := detection.NewEngine(detection.DefaultPack())
	if err == nil {
		matches, err := engine.Evaluate(detection.Input{
			WorkstreamID: firstWorkstreamID(wsEvents),
			Traces:       res.Traces,
			Spans:        res.Spans,
		})
		p0 := 0
		if err == nil {
			for _, m := range matches {
				if m.Severity == "P0" {
					p0++
				}
			}
		}
		checks = append(checks, Check{
			Name:   "detections_clean",
			Passed: p0 == 0,
			Detail: fmt.Sprintf("%d P0 detection(s)", p0),
		})
	}
	return checks
}

// applyBaseline loads the baseline checkpoint and computes the regression
// deltas (score + failures newer than the baseline). res is the caller's
// single trace.Materialize(wsEvents) pass (shared with runVerifyChecks) so
// the baseline's new-failures scan does not materialize the log a second
// time.
func applyBaseline(ctx context.Context, db *storage.DB, wsEvents []*protocol.Event, res *trace.MaterializeResult, report *verifyReport, baselineID string, redaction *redact.Options) error {
	// Baseline must belong to the same workstream (scoping discipline).
	cps, err := db.ListCheckpoints(ctx, report.WorkstreamID)
	if err != nil {
		return err
	}
	var baseline *protocol.Checkpoint
	for _, cp := range cps {
		if cp.CheckpointID == baselineID {
			baseline = cp
		}
	}
	if baseline == nil {
		return fmt.Errorf("baseline checkpoint %q not found in workstream %s", baselineID, report.WorkstreamID)
	}
	report.BaselineID = baseline.CheckpointID
	report.BaselineScore = baseline.Integrity.Score

	// Current deterministic score over the same evidence rules.
	repoState, _ := repository.State(ctx, ".")
	current, err := checkpointcore.Build(ctx, checkpointcore.BuildOptions{
		WorkstreamID: report.WorkstreamID,
		Repo:         repoState,
		Events:       wsEvents,
		Redaction:    redaction,
	})
	if err != nil {
		return fmt.Errorf("build current checkpoint: %w", err)
	}
	report.CurrentScore = checkpointcore.Score(current)
	report.ScoreDelta = report.CurrentScore - report.BaselineScore

	// New observed failures since the baseline was recorded. The anchor is
	// the checkpoint's storage creation time (the moment its evidence was
	// frozen).
	baselineNS, ok, err := db.CheckpointCreatedAt(ctx, report.WorkstreamID, baselineID)
	if err != nil {
		return err
	}
	if ok {
		for _, sp := range res.Spans {
			if sp.Status != "error" && sp.Status != "failed" {
				continue
			}
			if sp.StartedAtNS > baselineNS {
				report.NewFailures++
			}
		}
	}
	return nil
}

// filterByWorkstream returns only the events of one workstream, order
// preserved.
func filterByWorkstream(events []*protocol.Event, ws string) []*protocol.Event {
	out := make([]*protocol.Event, 0, len(events))
	for _, ev := range events {
		if ev.WorkstreamID == ws {
			out = append(out, ev)
		}
	}
	return out
}

func firstWorkstreamID(events []*protocol.Event) string {
	for _, ev := range events {
		if ev.WorkstreamID != "" {
			return ev.WorkstreamID
		}
	}
	return ""
}

func failedCheckNames(checks []Check) []string {
	var out []string
	for _, ck := range checks {
		if !ck.Passed {
			out = append(out, ck.Name)
		}
	}
	return out
}
