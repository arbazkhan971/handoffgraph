package commands

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/prompts"
)

// RegisterPromptCmd registers prompt management (parity rows 33-34):
// immutable versions + mutable labels + linkage views.
//
// Usage:
//
//	handoffgraph prompt create <name> --file <prompt.md> | --text "..." [--workstream <id>]
//	handoffgraph prompt label <name> --version N --label production|latest|<custom>
//	handoffgraph prompt list [--json]
//	handoffgraph prompt show <name> [--json]
func RegisterPromptCmd(app *cli.App) {
	app.Register(&cli.Command{
		Name:    "prompt",
		Summary: "Manage versioned prompts with mutable deployment labels",
		Usage: "create <name> (--file <prompt.md> | --text \"...\") [--workstream <id>]\n" +
			"        label <name> --version N --label production|latest|<custom>\n" +
			"        list [--json] | show <name> [--json]",
		Flags: func(fs *flag.FlagSet) {
			fs.String("file", "", "read the prompt body from this file")
			fs.String("text", "", "prompt body inline")
			fs.String("version", "", "label target version")
			fs.String("label", "", "label to set (production, latest, or custom)")
			fs.String("workstream", "", "optional workstream scoping")
			fs.Bool("json", false, "emit JSON")
		},
		Run: promptCmd,
	})
}

func promptCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	args, err := consumePositionals(fs)
	if err != nil {
		return err
	}
	if len(args) < 1 {
		return fmt.Errorf("usage: prompt create|label|list|show ...")
	}
	switch args[0] {
	case "create":
		if len(args) != 2 {
			return fmt.Errorf("usage: prompt create <name> --file <prompt.md> | --text \"...\"")
		}
		return promptCreateCmd(ctx, c, fs, args[1])
	case "label":
		if len(args) != 2 {
			return fmt.Errorf("usage: prompt label <name> --version N --label <label>")
		}
		return promptLabelCmd(ctx, c, fs, args[1])
	case "list":
		return promptListCmd(ctx, c, fs)
	case "show":
		if len(args) != 2 {
			return fmt.Errorf("usage: prompt show <name>")
		}
		return promptShowCmd(ctx, c, fs, args[1])
	default:
		return fmt.Errorf("unknown prompt subcommand %q (want: create, label, list, show)", args[0])
	}
}

func promptCreateCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet, name string) error {
	body := stringFlag(fs, "text")
	if path := stringFlag(fs, "file"); path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		body = string(data)
	}
	if body == "" {
		return fmt.Errorf("supply --file or --text")
	}

	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()
	events, err := db.ListEvents(ctx)
	if err != nil {
		return err
	}
	byName := prompts.Materialize(events)
	next := 1
	if existing, ok := byName[name]; ok {
		next = existing.Latest() + 1
	}

	ev, _, err := prompts.NewCreatedEvent(ids.Event(), stringFlag(fs, "workstream"), name, body, "", time.Now().UTC())
	if err != nil {
		return err
	}
	if err := prompts.AssignVersion(ev, next); err != nil {
		return err
	}
	if _, err := db.AppendEvent(ctx, ev); err != nil {
		return err
	}
	fmt.Fprintf(c.Stdout, "created %s version %d (%d bytes)\n", name, next, len(body))
	return nil
}

func promptLabelCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet, name string) error {
	version, err := strconv.Atoi(stringFlag(fs, "version"))
	if err != nil || version <= 0 {
		return fmt.Errorf("--version must be a positive integer")
	}
	label := stringFlag(fs, "label")
	if label == "" {
		return fmt.Errorf("--label is required")
	}
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()
	events, err := db.ListEvents(ctx)
	if err != nil {
		return err
	}
	byName := prompts.Materialize(events)
	pr, ok := byName[name]
	if !ok {
		return fmt.Errorf("prompt %q not found", name)
	}
	exists := false
	for _, v := range pr.Versions {
		if v.Version == version {
			exists = true
		}
	}
	if !exists {
		return fmt.Errorf("prompt %q has no version %d", name, version)
	}
	ev, err := prompts.NewLabeledEvent(ids.Event(), stringFlag(fs, "workstream"), name, label, version, time.Now().UTC())
	if err != nil {
		return err
	}
	if _, err := db.AppendEvent(ctx, ev); err != nil {
		return err
	}
	fmt.Fprintf(c.Stdout, "labeled %s@%d as %s\n", name, version, label)
	return nil
}

func promptListCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()
	events, err := db.ListEvents(ctx)
	if err != nil {
		return err
	}
	byName := prompts.Materialize(events)
	names := make([]string, 0, len(byName))
	for n := range byName {
		names = append(names, n)
	}
	sortStrings(names)
	if boolFlag(fs, "json") {
		out := make([]*prompts.Prompt, 0, len(names))
		for _, n := range names {
			out = append(out, byName[n])
		}
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(out)
	}
	for _, n := range names {
		pr := byName[n]
		resolved := pr.Resolve()
		fmt.Fprintf(c.Stdout, "%s  versions=%d", n, len(pr.Versions))
		for _, l := range []string{prompts.LabelProduction, prompts.LabelLatest} {
			if v, ok := resolved[l]; ok {
				fmt.Fprintf(c.Stdout, "  %s=%d", l, v)
			}
		}
		fmt.Fprintln(c.Stdout)
	}
	fmt.Fprintf(c.Stdout, "%d prompt(s)\n", len(names))
	return nil
}

func promptShowCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet, name string) error {
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()
	events, err := db.ListEvents(ctx)
	if err != nil {
		return err
	}
	byName := prompts.Materialize(events)
	pr, ok := byName[name]
	if !ok {
		return fmt.Errorf("prompt %q not found", name)
	}
	if boolFlag(fs, "json") {
		enc := json.NewEncoder(c.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(pr)
	}
	fmt.Fprintf(c.Stdout, "prompt %s — %d version(s)\n", name, len(pr.Versions))
	for _, v := range pr.Versions {
		fmt.Fprintf(c.Stdout, "  v%d  %s  %d bytes  %s\n", v.Version, v.Hash, len(v.Body), v.CreatedAt.UTC().Format(time.RFC3339))
	}
	resolved := pr.Resolve()
	for label, v := range resolved {
		fmt.Fprintf(c.Stdout, "  label %-12s -> v%d\n", label, v)
	}
	links := prompts.Links(events, name, 0)
	if len(links) > 0 {
		fmt.Fprintf(c.Stdout, "  referenced by %d event(s)\n", len(links))
	}
	return nil
}
