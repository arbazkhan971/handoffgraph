// Command handoffgraph is the HandoffGraph local CLI: a local-first,
// verified cross-agent continuity and session-debugging layer for coding
// agents (Claude Code, Codex, Pi).
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/handoffgraph/handoffgraph/internal/buildinfo"
	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/commands"
)

func main() {
	app := cli.NewApp("handoffgraph", buildinfo.Version())
	commands.Register(app)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	c := &cli.Context{
		Stdout: os.Stdout,
		Stderr: os.Stderr,
		Stdin:  os.Stdin,
	}

	if len(os.Args) < 2 {
		app.Help(c.Stdout)
		os.Exit(0)
	}

	name := os.Args[1]
	if name == "--help" || name == "-h" || name == "help" {
		app.Help(c.Stdout)
		os.Exit(0)
	}

	if err := app.Run(ctx, c, name, os.Args[2:]); err != nil {
		fmt.Fprintf(c.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}
