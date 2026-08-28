package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/otlp"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// RegisterOTLPCmd registers the v0.7-parity OTLP ingest lane (P1 of
// docs/parity-plan.md).
//
// Usage:
//
//	handoffgraph otlp import <file> [--format auto|json|protobuf] [--workstream <id>]
//	handoffgraph otlp serve [--addr 127.0.0.1:4318] [--workstream <id>]
//
// Both paths convert ExportTraceServiceRequest payloads — OTLP/JSON or
// OTLP/protobuf, the same events either way — into deterministic
// hfg.event.v1 events and append them idempotently. Like `resume` and
// `continue`, the command never launches or contacts an agent; `serve` only
// listens on the address given (localhost by default).
func RegisterOTLPCmd(app *cli.App) {
	app.Register(&cli.Command{
		Name:    "otlp",
		Summary: "Ingest OTLP telemetry (JSON or protobuf) into the event spine",
		Usage:   "import <file> [--format auto|json|protobuf] [--workstream <id>] | serve [--addr 127.0.0.1:4318] [--workstream <id>]",
		Flags: func(fs *flag.FlagSet) {
			fs.String("addr", "127.0.0.1:4318", "serve: listen address (localhost by default)")
			fs.String("workstream", "", "attach imported events to this workstream id")
			fs.String("capture", "full", "capture tier: full | metadata (drop prompt/completion bodies) | minimal (no attribute values)")
			fs.String("format", "auto", "import: body format: auto (sniff) | json | protobuf")
		},
		Run: otlpCmd,
	})
}

func otlpCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	positional, err := consumePositionals(fs)
	if err != nil {
		return err
	}
	if len(positional) < 1 {
		return fmt.Errorf("usage: otlp import <file> | otlp serve [--addr <addr>]")
	}
	switch positional[0] {
	case "import":
		if len(positional) != 2 {
			return fmt.Errorf("usage: otlp import <file>")
		}
		return otlpImportCmd(ctx, c, fs, positional[1])
	case "serve":
		return otlpServeCmd(ctx, c, fs)
	default:
		return fmt.Errorf("unknown otlp subcommand %q (want: import, serve)", positional[0])
	}
}

// decodeExportBody decodes an OTLP ExportTraceServiceRequest in either wire
// flavor. format is "auto" (sniff), "json", or "protobuf".
//
// Sniffing: OTLP/JSON always starts with '{' (the request is a JSON object),
// while a protobuf request starts with a field tag — 0x0a for
// resource_spans, never '{' (0x7b, which would be field 15 wire type 3, a
// group tag this decoder refuses anyway). Leading whitespace is tolerated on
// the JSON side; an empty body is treated as JSON so the familiar decode
// error is what the operator sees.
func decodeExportBody(data []byte, format string) (*otlp.ExportRequest, error) {
	switch format {
	case "", "auto":
		if looksLikeJSON(data) {
			format = "json"
		} else {
			format = "protobuf"
		}
	case "json", "protobuf":
	default:
		return nil, fmt.Errorf("invalid --format %q (want auto, json, or protobuf)", format)
	}
	if format == "protobuf" {
		req, err := otlp.DecodeExportRequest(data)
		if err != nil {
			return nil, fmt.Errorf("invalid OTLP/protobuf: %w", err)
		}
		return req, nil
	}
	var req otlp.ExportRequest
	dec := json.NewDecoder(bytes.NewReader(data))
	if err := dec.Decode(&req); err != nil {
		return nil, fmt.Errorf("invalid OTLP/JSON: %w", err)
	}
	return &req, nil
}

// looksLikeJSON reports whether the first non-space byte opens a JSON object.
func looksLikeJSON(data []byte) bool {
	for _, b := range data {
		switch b {
		case ' ', '\t', '\n', '\r':
			continue
		case '{':
			return true
		default:
			return false
		}
	}
	return true // empty/whitespace-only: report the JSON decode error
}

// convertAndAppend runs the OTLP conversion and appends the resulting events
// idempotently, printing a summary. It is the shared core of import/serve.
func convertAndAppend(ctx context.Context, c *cli.Context, db *storage.DB, data []byte, workstream, tier, format string) error {
	parsedTier, err := otlp.ParseCaptureTier(tier)
	if err != nil {
		return err
	}
	req, err := decodeExportBody(data, format)
	if err != nil {
		return err
	}
	res, err := otlp.Convert(req, otlp.Options{WorkstreamID: workstream, ObservedAt: time.Now().UTC(), CaptureTier: parsedTier})
	if err != nil {
		return err
	}
	appended := 0
	for _, ev := range res.Events {
		inserted, err := db.AppendEvent(ctx, ev)
		if err != nil {
			return fmt.Errorf("append %s: %w", ev.EventID, err)
		}
		if inserted {
			appended++
		}
	}
	for _, se := range res.SpanErrors {
		fmt.Fprintf(c.Stderr, "warning: rejected span %s: %v\n", se.SpanID, se.Err)
	}
	fmt.Fprintf(c.Stdout, "imported %d event(s) (%d duplicate(s), %d rejected span(s), %d dropped attribute key(s))\n",
		appended, len(res.Events)-appended, len(res.SpanErrors), res.DroppedAttributeKeys)
	return nil
}

func otlpImportCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet, path string) error {
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()

	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return convertAndAppend(ctx, c, db, data, stringFlag(fs, "workstream"), stringFlag(fs, "capture"), stringFlag(fs, "format"))
}

func otlpServeCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	_, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()

	addr := stringFlag(fs, "addr")
	workstream := stringFlag(fs, "workstream")
	tier, err := otlp.ParseCaptureTier(stringFlag(fs, "capture"))
	if err != nil {
		return err
	}
	srv := &http.Server{
		Addr: addr,
		Handler: &otlp.Handler{
			Append:       db.AppendEvent,
			WorkstreamID: workstream,
			CaptureTier:  tier,
		},
		// Local ingest only: never an internet-facing service.
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	errCh := make(chan error, 1)
	go func() {
		errCh <- srv.ListenAndServe()
	}()
	fmt.Fprintf(c.Stdout, "otlp serve listening on http://%s (POST /v1/traces, OTLP/JSON or OTLP/protobuf; ctrl-c to stop)\n", addr)

	select {
	case err := <-errCh:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	case <-ctx.Done():
		fmt.Fprintf(c.Stdout, "shutting down otlp serve\n")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	}
}
