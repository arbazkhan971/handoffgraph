// Package cli implements the HandoffGraph command framework and subcommands.
//
// The framework is intentionally minimal: commands register a name, summary,
// optional flag definitions, and a run function. Commands receive a context
// plus an already-parsed flag set, which keeps flag handling uniform.
package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"sort"
)

// Context carries the shared runtime state for a command invocation.
type Context struct {
	Stdout io.Writer
	Stderr io.Writer
	Stdin  io.Reader
}

// Command is a single CLI subcommand.
type Command struct {
	Name    string
	Summary string
	Usage   string
	// Flags registers command flags on fs (optional).
	Flags func(fs *flag.FlagSet)
	// Run executes the command. fs has already been parsed.
	Run func(ctx context.Context, c *Context, fs *flag.FlagSet) error
}

// App is the command registry.
type App struct {
	Name     string
	Version  string
	Commands map[string]*Command
}

// NewApp returns an empty command registry.
func NewApp(name, version string) *App {
	return &App{Name: name, Version: version, Commands: map[string]*Command{}}
}

// Register adds a command to the registry.
func (a *App) Register(cmd *Command) {
	a.Commands[cmd.Name] = cmd
}

// Run dispatches to the named command with args.
func (a *App) Run(ctx context.Context, c *Context, name string, args []string) error {
	cmd, ok := a.Commands[name]
	if !ok {
		return fmt.Errorf("unknown command %q (run %s --help for usage)", name, a.Name)
	}
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(c.Stderr)
	fs.Usage = func() {
		fmt.Fprintf(c.Stdout, "Usage: %s %s %s\n\n%s\n", a.Name, name, cmd.Usage, cmd.Summary)
		if cmd.Flags != nil {
			fmt.Fprintln(c.Stdout, "\nFlags:")
			fs.SetOutput(c.Stdout)
			fs.PrintDefaults()
			fs.SetOutput(c.Stderr)
		}
	}
	if cmd.Flags != nil {
		cmd.Flags(fs)
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	return cmd.Run(ctx, c, fs)
}

// Help prints the top-level help listing.
func (a *App) Help(w io.Writer) {
	fmt.Fprintf(w, "%s %s\n\nUsage: %s <command> [flags]\n\nCommands:\n", a.Name, a.Version, a.Name)
	names := make([]string, 0, len(a.Commands))
	for n := range a.Commands {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		fmt.Fprintf(w, "  %-14s %s\n", n, a.Commands[n].Summary)
	}
	fmt.Fprintf(w, "\nRun '%s <command> --help' for details.\n", a.Name)
}
