package commands

import (
	"context"
	"flag"
	"fmt"

	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/mcp"
)

// RegisterMCPCmd registers the local MCP stdio server (roadmap v0.4.0,
// "Local MCP v0"). It is exposed separately from Register so the wiring
// stays independent of the core command table.
//
// `handoffgraph mcp serve` runs the MCP server against the local database:
// JSON-RPC requests on stdin, responses on stdout, diagnostics on stderr.
func RegisterMCPCmd(app *cli.App) {
	app.Register(&cli.Command{
		Name:    "mcp",
		Summary: "Run the local MCP stdio server",
		Usage:   "serve",
		Run:     mcpCmd,
	})
}

func mcpCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	args := fs.Args()
	if len(args) != 1 || args[0] != "serve" {
		return fmt.Errorf("usage: mcp serve")
	}
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()

	srv := mcp.NewServer(db, mcp.Options{Version: buildVersion, Stderr: c.Stderr})
	return srv.Serve(ctx, c.Stdin, c.Stdout)
}
