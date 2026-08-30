package commands

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/buildinfo"
	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/config"
	"github.com/handoffgraph/handoffgraph/internal/hostedsync"
	"github.com/handoffgraph/handoffgraph/internal/redact"
)

// RegisterSyncCmd registers the only local-to-hosted transfer surface. No
// capture hook or other command calls this path implicitly.
func RegisterSyncCmd(app *cli.App) {
	app.Register(&cli.Command{
		Name:    "sync",
		Summary: "Explicitly preview and sync redacted local events to hosted HandoffGraph",
		Usage:   "[--preview] [--accept-redaction] [--json]",
		Flags: func(fs *flag.FlagSet) {
			fs.Bool("preview", false, "redact and summarize pending events without network or sync-state writes")
			fs.Bool("accept-redaction", false, "explicitly accept the first-upload redaction preview for this endpoint and device credential")
			fs.Bool("json", false, "emit a content-free JSON report")
		},
		Run: syncCmd,
	})
}

func syncCmd(ctx context.Context, c *cli.Context, fs *flag.FlagSet) error {
	localCfg, db, err := loadConfigAndDB()
	if err != nil {
		return err
	}
	defer db.Close()
	hostedCfg, err := config.LoadHosted()
	if err != nil {
		return err
	}
	token, err := hostedsync.ResolveDeviceToken(hostedCfg.DeviceToken, hostedCfg.TokenFile)
	if err != nil {
		return err
	}
	engine, err := redact.New(redact.Options{
		DenyPaths:    localCfg.RedactDenyPaths,
		UserPatterns: localCfg.RedactPatterns,
	})
	if err != nil {
		return fmt.Errorf("hosted sync redaction policy is invalid (fail-closed): %w", err)
	}
	storeID, err := canonicalSyncStoreID(localCfg.DBPath)
	if err != nil {
		return err
	}
	client := &http.Client{
		Timeout: 30 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	asJSON := boolFlag(fs, "json")
	previewWritten := false
	report, runErr := hostedsync.Run(ctx, db, engine, client, hostedsync.Options{
		Endpoint:        hostedCfg.APIURL,
		Token:           token,
		StoreID:         storeID,
		StatePath:       filepath.Join(config.UserDataDir(), "hosted-sync-state.json"),
		PreviewOnly:     boolFlag(fs, "preview"),
		AcceptRedaction: boolFlag(fs, "accept-redaction"),
		BeforeFirstUpload: func(preview hostedsync.Report) error {
			previewWritten = true
			writer := c.Stdout
			if asJSON {
				// Keep stdout as one valid final JSON document while still
				// making the first-upload preview visible before network I/O.
				writer = c.Stderr
			}
			return writeFirstUploadPreview(writer, preview)
		},
		UserAgent: "handoffgraph/" + buildinfo.Version(),
	})
	if report.HighWatermark > 0 || report.Preview.Events > 0 || report.UpToDate ||
		errors.Is(runErr, hostedsync.ErrPreviewAcceptanceRequired) {
		if err := writeSyncReport(c.Stdout, report, asJSON, !previewWritten); err != nil {
			return err
		}
	}
	return runErr
}

func canonicalSyncStoreID(dbPath string) (string, error) {
	abs, err := filepath.Abs(dbPath)
	if err != nil {
		return "", fmt.Errorf("resolve local event store for hosted sync: %w", err)
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", fmt.Errorf("resolve local event store for hosted sync: %w", err)
	}
	return filepath.Clean(real), nil
}

func writeFirstUploadPreview(w io.Writer, report hostedsync.Report) error {
	if _, err := fmt.Fprintf(w,
		"sync preview before first upload: %d event(s): %d clean, %d redacted, %d field value(s) removed (through local sequence %d)\n",
		report.Preview.Events, report.Preview.Clean, report.Preview.Redacted,
		report.Preview.FieldsRedacted, report.HighWatermark); err != nil {
		return err
	}
	_, err := fmt.Fprintln(w, "sync: explicit redaction acceptance received; starting hosted transfer")
	return err
}

func writeSyncReport(w io.Writer, report hostedsync.Report, asJSON, includePreview bool) error {
	if asJSON {
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	}
	if includePreview {
		fmt.Fprintf(w,
			"sync preview: %d event(s): %d clean, %d redacted, %d field value(s) removed (through local sequence %d)\n",
			report.Preview.Events, report.Preview.Clean, report.Preview.Redacted,
			report.Preview.FieldsRedacted, report.HighWatermark)
	}
	if report.Mode == "preview" {
		fmt.Fprintln(w, "sync preview only: no network request or sync-state write was made")
		return nil
	}
	if report.AcceptedEvents > 0 {
		fmt.Fprintf(w, "sync: accepted %d event(s) in %d batch(es); local cursor is %d\n",
			report.AcceptedEvents, report.BatchesSent, report.Cursor)
	} else if report.UpToDate {
		fmt.Fprintf(w, "sync: up to date at local cursor %d\n", report.Cursor)
	}
	return nil
}
