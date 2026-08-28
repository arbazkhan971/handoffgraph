package commands

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/config"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// openCommandDB opens the same store the command under test used, after
// isolateDataDir fixed HFG_DATA_DIR.
func openCommandDB(t *testing.T) *storage.DB {
	t.Helper()
	cfg, err := config.Load(".")
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	db, err := storage.Open(cfg.DBPath)
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	return db
}

// newOTLPApp returns an app wired exactly like cmd/handoffgraph/main.go.
func newOTLPApp() *cli.App {
	app := cli.NewApp("handoffgraph", "test")
	Register(app)
	return app
}

// TestOTLPImportIdempotent exercises the import command through the public
// CLI surface: first import appends the full event set, second import is a
// pure duplicate no-op.
func TestOTLPImportIdempotent(t *testing.T) {
	isolateDataDir(t)
	app := newOTLPApp()

	src, err := os.ReadFile("../../testdata/fixtures/otlp/genai_session.json")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "genai_session.json")
	if err := os.WriteFile(path, src, 0o600); err != nil {
		t.Fatal(err)
	}

	out, errOut, err := runRegisteredApp(app, "otlp", "import", path)
	if err != nil {
		t.Fatalf("otlp import: %v\n%s%s", err, out, errOut)
	}
	if !strings.Contains(out, "imported 9 event(s)") {
		t.Fatalf("first import output = %q", out)
	}
	if errOut != "" {
		t.Fatalf("unexpected stderr: %q", errOut)
	}

	out2, _, err := runRegisteredApp(app, "otlp", "import", path)
	if err != nil {
		t.Fatalf("second otlp import: %v\n%s", err, out2)
	}
	if !strings.Contains(out2, "imported 0 event(s) (9 duplicate(s)") {
		t.Fatalf("second import output = %q", out2)
	}
}

// TestOTLPImportProtobuf proves the import path is flavor-agnostic: the
// binary fixture sniffs as protobuf, produces the SAME 9 events as the JSON
// fixture (so the JSON import right after it is a pure duplicate), and the
// --format override reaches the same decoder.
func TestOTLPImportProtobuf(t *testing.T) {
	isolateDataDir(t)
	app := newOTLPApp()

	dir := t.TempDir()
	pbSrc, err := os.ReadFile("../../testdata/fixtures/otlp/genai_session.pb")
	if err != nil {
		t.Fatal(err)
	}
	pbPath := filepath.Join(dir, "genai_session.pb")
	if err := os.WriteFile(pbPath, pbSrc, 0o600); err != nil {
		t.Fatal(err)
	}
	jsonSrc, err := os.ReadFile("../../testdata/fixtures/otlp/genai_session.json")
	if err != nil {
		t.Fatal(err)
	}
	jsonPath := filepath.Join(dir, "genai_session.json")
	if err := os.WriteFile(jsonPath, jsonSrc, 0o600); err != nil {
		t.Fatal(err)
	}

	// Sniffed: no --format, a file whose first byte is not '{'.
	out, errOut, err := runRegisteredApp(app, "otlp", "import", pbPath)
	if err != nil {
		t.Fatalf("otlp import (protobuf): %v\n%s%s", err, out, errOut)
	}
	if !strings.Contains(out, "imported 9 event(s)") {
		t.Fatalf("protobuf import output = %q", out)
	}

	// The JSON flavor of the same telemetry is now a pure duplicate: both
	// flavors derive identical event ids.
	out2, _, err := runRegisteredApp(app, "otlp", "import", jsonPath)
	if err != nil {
		t.Fatalf("otlp import (json): %v\n%s", err, out2)
	}
	if !strings.Contains(out2, "imported 0 event(s) (9 duplicate(s)") {
		t.Fatalf("cross-flavor import output = %q", out2)
	}

	// Explicit overrides: --format protobuf on the binary body works, and
	// forcing the wrong flavor fails closed instead of importing garbage.
	if _, _, err := runRegisteredApp(app, "otlp", "import", pbPath, "--format", "protobuf"); err != nil {
		t.Fatalf("--format protobuf: %v", err)
	}
	if _, _, err := runRegisteredApp(app, "otlp", "import", pbPath, "--format", "json"); err == nil {
		t.Fatal("--format json on a protobuf body was accepted")
	}
	if _, _, err := runRegisteredApp(app, "otlp", "import", jsonPath, "--format", "protobuf"); err == nil {
		t.Fatal("--format protobuf on a JSON body was accepted")
	}
	if _, _, err := runRegisteredApp(app, "otlp", "import", jsonPath, "--format", "yaml"); err == nil {
		t.Fatal("unknown --format accepted")
	}

	db := openCommandDB(t)
	defer db.Close()
	n, err := db.EventCount(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 9 {
		t.Fatalf("event count after both flavors = %d, want 9", n)
	}
}

// TestOTLPServeBindings checks the serve subcommand surfaces: a bad
// subcommand is rejected, and a listener on an explicit port accepts an
// OTLP export through the same store the CLI opened.
func TestOTLPServeBindings(t *testing.T) {
	isolateDataDir(t)
	app := newOTLPApp()

	if _, _, err := runRegisteredApp(app, "otlp", "dance"); err == nil {
		t.Fatal("unknown subcommand accepted")
	}

	// serve on a fixed port, then POST telemetry to it and confirm the
	// events landed in the same DB the CLI uses.
	src, err := os.ReadFile("../../testdata/fixtures/otlp/genai_session.json")
	if err != nil {
		t.Fatal(err)
	}
	addr := "127.0.0.1:43180"
	done := make(chan error, 1)
	go func() {
		_, _, err := runRegisteredApp(app, "otlp", "serve", "--addr", addr)
		done <- err
	}()

	deadline := time.Now().Add(10 * time.Second)
	var resp *http.Response
	for {
		resp, err = http.Post("http://"+addr+"/v1/traces", "application/json", strings.NewReader(string(src)))
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("serve never came up: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("export status = %d", resp.StatusCode)
	}

	// Shut the server down cleanly via SIGINT (signal.NotifyContext).
	if runtime.GOOS != "windows" {
		p, _ := os.FindProcess(os.Getpid())
		_ = p.Signal(syscall.SIGINT)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve returned: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("serve did not shut down")
	}

	// The store received the full event set.
	db := openCommandDB(t)
	defer db.Close()
	n, err := db.EventCount(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 9 {
		t.Fatalf("event count after serve export = %d, want 9", n)
	}
}
