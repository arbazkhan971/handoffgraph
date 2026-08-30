package commands

import (
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/cli"
)

func TestRegisterExposesAllShippedCommands(t *testing.T) {
	app := cli.NewApp("handoffgraph", "test")
	Register(app)

	want := []string{
		"checkpoint", "claude", "codex", "continue", "detect", "doctor",
		"event", "fixture", "graph", "handoff", "hook", "init", "install", "mcp",
		"dataset", "experiment", "index", "open", "otlp", "outcomes", "pi",
		"prompt", "query", "redact", "reset", "resume", "score", "sessions",
		"status", "sync", "traces", "verify", "version", "workstream",
	}
	for _, name := range want {
		if _, ok := app.Commands[name]; !ok {
			t.Errorf("command %q is not registered", name)
		}
	}
	if got := len(app.Commands); got != len(want) {
		t.Errorf("registered command count = %d, want %d", got, len(want))
	}
}
