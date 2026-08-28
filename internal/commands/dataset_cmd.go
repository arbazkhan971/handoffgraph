package commands

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/datasets"
	"github.com/handoffgraph/handoffgraph/internal/detection"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/object"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/trace"
)

// RegisterDatasetCmd registers evaluation datasets and experiments (parity
// row 27).
//
// Usage:
//
//	handoffgraph dataset create <name> --file <fixture.jsonl>[...] [--json]
//	handoffgraph dataset list [--json]
//	handoffgraph experiment run --dataset <name> [--version <hash>] [--json]
//	handoffgraph experiment list [--json]
//	handoffgraph experiment compare <runEventA> <runEventB> [--json]
//
// Datasets are immutable content-hash versions of example files; experiments
// replay each example through the deterministic materializer + detection
// pack and record per-example verdicts as append-only events.
func RegisterDatasetCmd(app *cli.App) {
	app.Register(&cli.Command{
		Name:    "dataset",
		Summary: "Create and list immutable evaluation dataset versions",
		Usage:   "create <name> --file <fixture.jsonl>[...] [--json] | list [--json]",
		Flags: func(fs *flag.FlagSet) {
			fs.Var(&multiFlag{}, "file", "example file (repeatable)")
			fs.Bool("json", false, "emit JSON")
		},
		Run: datasetCmd,
	})
	app.Register(&cli.Command{
		Name:    "experiment",
		Summary: "Run deterministic experiments over dataset versions",
		Usage: "run --dataset <name> [--version <hash>] [--json]\n" +
			"                list [--json] | compare <runEventA> <runEventB> [--json]",
		Flags: func(fs *flag.FlagSet) {
			fs.String("dataset", "", "dataset name to run")
			fs.String("version", "", "dataset version hash (default: latest)")
			fs.Bool("json", false, "emit JSON")
		},
		Run: experimentCmd,
	})
}

// multiFlag collects repeated string flag values.
type multiFlag []string

func (m *multiFlag) String() string { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error {
	*m = append(*m, v)
	return nil
}

func datasetCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	args, err := consumePositionals(fs)
	if err != nil {
		return err
	}
	if len(args) < 1 {
		return fmt.Errorf("usage: dataset create <name> --file ... | dataset list")
	}
	switch args[0] {
	case "create":
		if len(args) != 2 {
			return fmt.Errorf("usage: dataset create <name> --file <fixture.jsonl> [...]")
		}
		return datasetCreateCmd(ctx, c, fs, args[1])
	case "list":
		return datasetListCmd(ctx, c, fs)
	default:
		return fmt.Errorf("unknown dataset subcommand %q (want: create, list)", args[0])
	}
}

func datasetCreateCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet, name string) error {
	return datasetCreate(ctx, c, fs, name)
}

func datasetCreate(ctx context.Context, c *cli.Context, fs *flag.FlagSet, name string) error {
	paths := fs.Lookup("file").Value.(*multiFlag)
	if paths == nil || len(*paths) == 0 {
		return fmt.Errorf("--file is required at least once")
	}
	cfg, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()
	store, err := object.NewStore(cfg.ObjectDir)
	if err != nil {
		return err
	}
	files := make([]datasets.InputFile, 0, len(*paths))
	for _, p := range *paths {
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		// Bodies live in the content-addressed store so experiments can
		// replay byte-identical examples later; the manifest carries the
		// same content hash for independent verification.
		if _, _, err := store.Put(data, "local", "hfg.dataset.example.v1"); err != nil {
			return fmt.Errorf("store example %s: %w", filepath.Base(p), err)
		}
		files = append(files, datasets.InputFile{Name: filepath.Base(p), Data: data})
	}
	version, err := datasets.BuildVersion(name, files)
	if err != nil {
		return err
	}

	payload, err := json.Marshal(map[string]any{
		"name": version.Name, "version": version.Version, "files": version.Files,
	})
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	ev := &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       ids.Event(),
		OccurredAt:    now,
		ObservedAt:    now,
		Kind:          protocol.EventDatasetCreated,
		Provenance:    protocol.ProvenanceObserved,
		Payload:       payload,
	}
	if _, err := db.AppendEvent(ctx, ev); err != nil {
		return err
	}
	if boolFlag(fs, "json") {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(version)
	}
	fmt.Fprintf(c.Stdout, "dataset %s version %s (%d example(s))\n", version.Name, version.Version, len(version.Files))
	for _, f := range version.Files {
		fmt.Fprintf(c.Stdout, "  %s  %d event(s)  %s\n", f.Name, f.EventCount, f.Hash)
	}
	return nil
}

func datasetListCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()
	events, err := db.ListEvents(ctx)
	if err != nil {
		return err
	}
	records := datasets.Materialize(events)
	latest := datasets.LatestByName(records)
	names := make([]string, 0, len(latest))
	for n := range latest {
		names = append(names, n)
	}
	sortStrings(names)
	if boolFlag(fs, "json") {
		out := make([]datasets.DatasetRecord, 0, len(names))
		for _, n := range names {
			out = append(out, latest[n])
		}
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(out)
	}
	for _, n := range names {
		r := latest[n]
		fmt.Fprintf(c.Stdout, "%s\t%s\t%d example(s)\n", r.Name, r.Version, len(r.Files))
	}
	fmt.Fprintf(c.Stdout, "%d dataset(s)\n", len(names))
	return nil
}

func experimentCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	args, err := consumePositionals(fs)
	if err != nil {
		return err
	}
	if len(args) < 1 {
		return fmt.Errorf("usage: experiment run --dataset <name> | list | compare <a> <b>")
	}
	switch args[0] {
	case "run":
		return experimentRunCmd(ctx, c, fs)
	case "list":
		return experimentListCmd(ctx, c, fs)
	case "compare":
		if len(args) != 3 {
			return fmt.Errorf("usage: experiment compare <runEventA> <runEventB>")
		}
		return experimentCompareCmd(ctx, c, fs, args[1], args[2])
	default:
		return fmt.Errorf("unknown experiment subcommand %q (want: run, list, compare)", args[0])
	}
}

// experimentRunCmd replays each example through the deterministic task:
// parse → materialize → detection pack. No example content is written to
// the spine; only the verdict record is.
func experimentRunCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	name := stringFlag(fs, "dataset")
	if name == "" {
		return fmt.Errorf("--dataset is required")
	}
	cfg, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()
	events, err := db.ListEvents(ctx)
	if err != nil {
		return err
	}
	records := datasets.Materialize(events)
	latest := datasets.LatestByName(records)
	rec, ok := latest[name]
	if !ok {
		return fmt.Errorf("dataset %q not found", name)
	}
	if want := stringFlag(fs, "version"); want != "" {
		if rec.Version != want {
			for _, r := range records {
				if r.Name == name && r.Version == want {
					rec = r
					break
				}
			}
			if rec.Version != want {
				return fmt.Errorf("dataset %q has no version %s", name, want)
			}
		}
	}

	engine, err := detection.NewEngine(detection.DefaultPack())
	if err != nil {
		return err
	}
	store, err := object.NewStore(cfg.ObjectDir)
	if err != nil {
		return err
	}
	results := make([]datasets.ExampleResult, 0, len(rec.Files))
	passed := true
	for _, f := range rec.Files {
		r := datasets.ExampleResult{Name: f.Name, Hash: f.Hash, Events: f.EventCount, Status: "ok"}
		data, _, err := store.Get(f.Hash)
		if err != nil {
			r.Status = "invalid"
			passed = false
			results = append(results, r)
			continue
		}
		evs, err := decodeExampleEvents(data)
		if err != nil {
			r.Status = "invalid"
			passed = false
			results = append(results, r)
			continue
		}
		res := trace.Materialize(evs)
		r.Traces = len(res.Traces)
		r.Spans = len(res.Spans)
		matches, err := engine.Evaluate(detection.Input{Traces: res.Traces, Spans: res.Spans})
		if err == nil {
			for _, m := range matches {
				if m.Severity == "P0" {
					r.P0Detections++
				}
			}
		}
		if r.P0Detections > 0 {
			r.Status = "detections"
			passed = false
		}
		results = append(results, r)
	}

	payload, err := json.Marshal(datasets.ExperimentRecord{
		Dataset: name, Version: rec.Version, Passed: passed, Results: results,
	})
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	ev := &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       ids.Event(),
		OccurredAt:    now,
		ObservedAt:    now,
		Kind:          protocol.EventExperimentRecorded,
		Provenance:    protocol.ProvenanceObserved,
		Payload:       payload,
	}
	if _, err := db.AppendEvent(ctx, ev); err != nil {
		return err
	}

	if boolFlag(fs, "json") {
		out := struct {
			EventID string                   `json:"event_id"`
			Passed  bool                     `json:"passed"`
			Results []datasets.ExampleResult `json:"results"`
		}{ev.EventID, passed, results}
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(out)
	}
	fmt.Fprintf(c.Stdout, "experiment %s on %s@%s: %s\n", ev.EventID, name, rec.Version, verdictWord(passed))
	for _, r := range results {
		fmt.Fprintf(c.Stdout, "  %-32s %-12s traces=%d spans=%d p0=%d\n", r.Name, r.Status, r.Traces, r.Spans, r.P0Detections)
	}
	if !passed {
		return fmt.Errorf("experiment failed")
	}
	return nil
}

// decodeExampleEvents parses stored example bytes into events. Malformed
// content marks the example invalid rather than poisoning the run.
func decodeExampleEvents(data []byte) ([]*protocol.Event, error) {
	var out []*protocol.Event
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var ev protocol.Event
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			return out, err
		}
		out = append(out, &ev)
	}
	return out, nil
}

func experimentListCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()
	events, err := db.ListEvents(ctx)
	if err != nil {
		return err
	}
	runs := datasets.MaterializeExperiments(events)
	if boolFlag(fs, "json") {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(runs)
	}
	for _, r := range runs {
		fmt.Fprintf(c.Stdout, "%s\t%s@%s\t%s\t%d example(s)\n",
			r.EventID, r.Dataset, r.Version, verdictWord(r.Passed), len(r.Results))
	}
	fmt.Fprintf(c.Stdout, "%d experiment run(s)\n", len(runs))
	return nil
}

func experimentCompareCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet, aID, bID string) error {
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()
	events, err := db.ListEvents(ctx)
	if err != nil {
		return err
	}
	runs := datasets.MaterializeExperiments(events)
	var a, b *datasets.ExperimentRecord
	for i := range runs {
		if runs[i].EventID == aID {
			a = &runs[i]
		}
		if runs[i].EventID == bID {
			b = &runs[i]
		}
	}
	if a == nil || b == nil {
		return fmt.Errorf("experiment run(s) not found")
	}
	comparisons := datasets.Compare(*a, *b)
	regressions := 0
	if boolFlag(fs, "json") {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(comparisons)
	}
	for _, cmp := range comparisons {
		mark := "same"
		if cmp.Regression {
			mark = "REGRESSION"
			regressions++
		} else if cmp.FromStatus != cmp.ToStatus || cmp.FromP0 != cmp.ToP0 {
			mark = "changed"
		}
		fmt.Fprintf(c.Stdout, "%-32s %s(%d) -> %s(%d)  %s\n", cmp.File, cmp.FromStatus, cmp.FromP0, cmp.ToStatus, cmp.ToP0, mark)
	}
	fmt.Fprintf(c.Stdout, "%d example(s), %d regression(s)\n", len(comparisons), regressions)
	if regressions > 0 {
		return fmt.Errorf("%d regression(s) vs baseline run", regressions)
	}
	return nil
}

func verdictWord(passed bool) string {
	if passed {
		return "passed"
	}
	return "failed"
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}
