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
		"event", "fixture", "graph", "handoff", "init", "install", "mcp",
		"index", "open", "otlp", "outcomes", "pi", "query", "redact", "resume", "score",
		"sessions", "status", "traces", "version", "workstream",
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
