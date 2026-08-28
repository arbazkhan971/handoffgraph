package commands

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/scores"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// RegisterScoreCmd registers the parity-P1 scores primitive (row 24).
//
// Usage:
//
//	handoffgraph score record --workstream <id> --name <n> --target-type <t>
//	                          --target-id <id> (--value N | --category S | --bool B)
//	                          [--source human|api|evaluation|detection] [--comment s]
//	handoffgraph score list [--workstream <id>] [--target-id <id>] [--name <n>] [--json]
//
// Scores are append-only score.recorded events; list derives the read model
// deterministically from the event log. Every score is source-tagged so
// human judgment is never conflated with machine evaluation.
func RegisterScoreCmd(app *cli.App) {
	app.Register(&cli.Command{
		Name:    "score",
		Summary: "Record or list quality scores attached to spine objects",
		Usage: "record --workstream <id> --name <n> --target-type trace|span|session|checkpoint|workstream\n" +
			"              --target-id <id> (--value N | --category S | --bool true|false)\n" +
			"              [--source human|api|evaluation|detection] [--comment s]\n" +
			"        list  [--workstream <id>] [--target-id <id>] [--name <n>] [--json]",
		Flags: func(fs *flag.FlagSet) {
			fs.String("workstream", "", "workstream the score belongs to")
			fs.String("name", "", "score name (e.g. handoff.validity, human.review)")
			fs.String("target-type", "", "trace | span | session | checkpoint | workstream")
			fs.String("target-id", "", "the scored object's id")
			fs.String("value", "", "numeric value (NUMERIC)")
			fs.String("category", "", "category label (CATEGORY)")
			fs.String("bool", "", "true|false (BOOLEAN)")
			fs.String("source", "human", "human | api | evaluation | detection")
			fs.String("comment", "", "optional explanation")
			fs.Bool("json", false, "emit JSON (list)")
		},
		Run: scoreCmd,
	})
}

func scoreCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	args, err := consumePositionals(fs)
	if err != nil {
		return err
	}
	if len(args) < 1 {
		return fmt.Errorf("usage: score record ... | score list ...")
	}
	switch args[0] {
	case "record":
		return scoreRecordCmd(ctx, c, fs)
	case "list":
		return scoreListCmd(ctx, c, fs)
	default:
		return fmt.Errorf("unknown score subcommand %q (want: record, list)", args[0])
	}
}

func scoreRecordCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	workstream := stringFlag(fs, "workstream")
	if workstream == "" {
		return fmt.Errorf("--workstream is required")
	}
	in := scores.Input{
		Name:       stringFlag(fs, "name"),
		TargetType: protocol.ScoreTargetType(strings.ToLower(stringFlag(fs, "target-type"))),
		TargetID:   stringFlag(fs, "target-id"),
		Source:     protocol.ScoreSource(strings.ToLower(stringFlag(fs, "source"))),
		Comment:    stringFlag(fs, "comment"),
	}
	// Data type is inferred from which value flag was supplied; exactly one
	// must be present.
	hasValue := fs.Lookup("value").Value.String() != ""
	hasCategory := fs.Lookup("category").Value.String() != ""
	hasBool := fs.Lookup("bool").Value.String() != ""
	switch {
	case hasValue && !hasCategory && !hasBool:
		v, err := strconv.ParseFloat(stringFlag(fs, "value"), 64)
		if err != nil {
			return fmt.Errorf("--value must be a number")
		}
		in.DataType = protocol.ScoreDataTypeNumeric
		in.Value = &v
	case hasCategory && !hasValue && !hasBool:
		in.DataType = protocol.ScoreDataTypeCategory
		in.StringValue = stringFlag(fs, "category")
	case hasBool && !hasValue && !hasCategory:
		b, err := strconv.ParseBool(stringFlag(fs, "bool"))
		if err != nil {
			return fmt.Errorf("--bool must be true or false")
		}
		in.DataType = protocol.ScoreDataTypeBoolean
		in.BoolValue = &b
	default:
		return fmt.Errorf("supply exactly one of --value, --category, --bool")
	}

	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()

	if !workstreamExists(ctx, db, workstream) {
		return fmt.Errorf("workstream %q not found", workstream)
	}

	ev, err := scores.NewEvent(ids.Event(), workstream, in, time.Now().UTC())
	if err != nil {
		return err
	}
	if _, err := db.AppendEvent(ctx, ev); err != nil {
		return err
	}
	fmt.Fprintf(c.Stdout, "recorded %s on %s %s (%s=%s, source=%s)\n",
		in.Name, in.TargetType, in.TargetID, in.DataType, valueDisplay(in), in.Source)
	return nil
}

func scoreListCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()

	events, err := db.ListEvents(ctx)
	if err != nil {
		return err
	}
	all := scores.Materialize(events)

	workstream := stringFlag(fs, "workstream")
	targetID := stringFlag(fs, "target-id")
	name := stringFlag(fs, "name")
	filtered := make([]*protocol.Score, 0, len(all))
	for _, s := range all {
		if workstream != "" && s.WorkstreamID != workstream {
			continue
		}
		if targetID != "" && s.TargetID != targetID {
			continue
		}
		if name != "" && s.Name != name {
			continue
		}
		filtered = append(filtered, s)
	}

	if boolFlag(fs, "json") {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(filtered)
	}
	for _, s := range filtered {
		fmt.Fprintf(c.Stdout, "%s\t%s\t%s\t%s=%s\t%s\t%s\t%s\n",
			s.OccurredAt.UTC().Format(time.RFC3339), s.Name, s.TargetType, s.TargetID,
			valueDisplay(scores.Input{
				DataType: s.DataType, Value: s.Value, StringValue: s.StringValue, BoolValue: s.BoolValue,
			}), s.Source, s.Provenance, s.Comment)
	}
	fmt.Fprintf(c.Stdout, "%d score(s)\n", len(filtered))
	return nil
}

// workstreamExists reports whether the workstream id is known locally.
func workstreamExists(ctx context.Context, db *storage.DB, id string) bool {
	ws, err := db.ListWorkstreams(ctx)
	if err != nil {
		return false
	}
	for _, w := range ws {
		if w.ID == id {
			return true
		}
	}
	return false
}

// valueDisplay renders the score's value slot for text output.
func valueDisplay(in scores.Input) string {
	switch in.DataType {
	case protocol.ScoreDataTypeNumeric:
		if in.Value != nil {
			return strconv.FormatFloat(*in.Value, 'g', -1, 64)
		}
	case protocol.ScoreDataTypeCategory:
		return in.StringValue
	case protocol.ScoreDataTypeBoolean:
		if in.BoolValue != nil {
			return strconv.FormatBool(*in.BoolValue)
		}
	}
	return ""
}
