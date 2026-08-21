package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/config"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// The tests in this file exercise the mcp command through the public
// cli.App surface. HFG_DATA_DIR points at a throwaway directory so the
// user's real data directory is never touched.

// newMCPApp returns a fresh app with only the MCP command registered, so a
// test failure here cannot be caused by unrelated commands.
func newMCPApp(t *testing.T) *cli.App {
	t.Helper()
	app := cli.NewApp("handoffgraph", "test")
	RegisterMCPCmd(app)
	return app
}

// runMCP isolates the data dir, dispatches `mcp` with args, feeding stdin
// from the given input and capturing stdout/stderr.
func runMCP(t *testing.T, stdin string, args ...string) (string, string, error) {
	t.Helper()
	t.Setenv("HFG_DATA_DIR", t.TempDir())
	cfg, err := config.Load(".")
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("cfg.Validate: %v", err)
	}

	app := newMCPApp(t)
	var out, errBuf bytes.Buffer
	c := &cli.Context{Stdout: &out, Stderr: &errBuf, Stdin: strings.NewReader(stdin)}
	err = app.Run(context.Background(), c, "mcp", args)
	return out.String(), errBuf.String(), err
}

func TestRegisterMCPCmd(t *testing.T) {
	app := newMCPApp(t)
	cmd, ok := app.Commands["mcp"]
	if !ok {
		t.Fatal("mcp command not registered")
	}
	if cmd.Summary == "" || cmd.Usage != "serve" {
		t.Fatalf("mcp command = %+v", cmd)
	}
}

func TestMCPCmdRequiresServe(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{"no args", nil},
		{"wrong subcommand", []string{"run"}},
		{"too many", []string{"serve", "extra"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, err := runMCP(t, "", tt.args...)
			if err == nil {
				t.Fatal("expected usage error")
			}
			if !strings.Contains(err.Error(), "usage: mcp serve") {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

// TestMCPCmdServeRoundTrip drives `mcp serve` through a full initialize +
// tools/list exchange on stdin/stdout.
func TestMCPCmdServeRoundTrip(t *testing.T) {
	// Seed a workstream through the same database the command opens.
	t.Setenv("HFG_DATA_DIR", t.TempDir())
	cfg, err := config.Load(".")
	if err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.CreateWorkstream(context.Background(), "ws_cli", "cli round trip", ""); err != nil {
		t.Fatal(err)
	}
	db.Close()

	stdin := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_workstream_context","arguments":{"workstream_id":"ws_cli"}}}`,
	}, "\n") + "\n"

	app := newMCPApp(t)
	var out, errBuf bytes.Buffer
	c := &cli.Context{Stdout: &out, Stderr: &errBuf, Stdin: strings.NewReader(stdin)}
	if err := app.Run(context.Background(), c, "mcp", []string{"serve"}); err != nil {
		t.Fatalf("mcp serve: %v", err)
	}

	lines := strings.Split(strings.TrimRight(out.String(), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("got %d stdout lines, want 3 (notification has no response): %q", len(lines), out.String())
	}

	var initRes struct {
		Result struct {
			ProtocolVersion string `json:"protocolVersion"`
			ServerInfo      struct {
				Name string `json:"name"`
			} `json:"serverInfo"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(lines[0]), &initRes); err != nil {
		t.Fatalf("initialize response: %v", err)
	}
	if initRes.Result.ProtocolVersion != "2025-06-18" || initRes.Result.ServerInfo.Name != "handoffgraph" {
		t.Fatalf("initialize result = %+v", initRes.Result)
	}

	var listRes struct {
		Result struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(lines[1]), &listRes); err != nil {
		t.Fatalf("tools/list response: %v", err)
	}
	if len(listRes.Result.Tools) != 9 {
		t.Fatalf("tools = %d, want 9", len(listRes.Result.Tools))
	}

	var callRes struct {
		Result struct {
			StructuredContent map[string]any `json:"structuredContent"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(lines[2]), &callRes); err != nil {
		t.Fatalf("tools/call response: %v", err)
	}
	if callRes.Result.StructuredContent["workstream_id"] != "ws_cli" {
		t.Fatalf("structuredContent = %v", callRes.Result.StructuredContent)
	}
	if valid, ok := callRes.Result.StructuredContent["isValidTool"].(bool); !ok || !valid {
		t.Fatalf("isValidTool = %v, want true", callRes.Result.StructuredContent["isValidTool"])
	}
}
