package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/cli"
	"github.com/handoffgraph/handoffgraph/internal/ids"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// The tests in this file exercise the `open` command (webui lane) through
// the public cli.App surface. They reuse the shared helpers in
// commands_install_test.go (isolateDataDir, seedEvents) and only touch a
// throwaway data dir plus OS-assigned localhost ports, so the user's real
// data directory and network surfaces are never touched.

// newWebUIApp returns an app with only the webui command registered, so
// this file never depends on other lanes' command files.
func newWebUIApp(t *testing.T) *cli.App {
	t.Helper()
	app := cli.NewApp("handoffgraph", "test")
	RegisterWebUICmd(app)
	return app
}

func TestRegisterWebUICmd(t *testing.T) {
	app := newWebUIApp(t)
	cmd, ok := app.Commands["open"]
	if !ok {
		t.Fatal("RegisterWebUICmd did not register the open command")
	}
	if cmd.Summary == "" || cmd.Usage == "" || cmd.Flags == nil || cmd.Run == nil {
		t.Errorf("open command incomplete: %+v", cmd)
	}
	// The default port flag must be the webui default.
	fs := flag.NewFlagSet("open", flag.ContinueOnError)
	cmd.Flags(fs)
	if got := webUIPortFlag(fs); got != 7788 {
		t.Errorf("default --port = %d, want 7788", got)
	}
}

func TestOpenCommandInvalidPort(t *testing.T) {
	cases := []struct {
		name string
		port string
	}{
		{"negative", "-1"},
		{"too large", "65536"},
		{"far too large", "999999"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			isolateDataDir(t)
			app := newWebUIApp(t)
			_, _, err := runRegisteredApp(app, "open", "--port", tc.port)
			if err == nil {
				t.Fatalf("open --port %s: want error, got nil", tc.port)
			}
			if !strings.Contains(err.Error(), "--port") {
				t.Errorf("err = %v, want it to mention --port", err)
			}
		})
	}
}

func TestOpenCommandPortInUse(t *testing.T) {
	isolateDataDir(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("probe listen: %v", err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	app := newWebUIApp(t)
	_, _, err = runRegisteredApp(app, "open", "--port", strconv.Itoa(port))
	if err == nil {
		t.Fatal("open on a busy port: want error, got nil")
	}
	if !strings.Contains(err.Error(), "listen") {
		t.Errorf("err = %v, want it to mention listen", err)
	}
}

// startOpen runs `open` with a cancellable context and returns a done
// channel plus the stdout buffer.
// syncBuffer is a mutex-guarded bytes.Buffer: the server goroutine writes
// (fmt.Fprintf) while tests read concurrently, so plain bytes.Buffer races.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// startOpen runs `open --port <port>` on a background goroutine, returning
// its error channel and a concurrency-safe stdout buffer.
func startOpen(ctx context.Context, app *cli.App, port string) (chan error, *syncBuffer) {
	out := &syncBuffer{}
	c := &cli.Context{Stdout: out, Stderr: &bytes.Buffer{}}
	done := make(chan error, 1)
	go func() { done <- app.Run(ctx, c, "open", []string{"--port", port}) }()
	return done, out
}

// waitOpenReady polls the API until the server responds.
func waitOpenReady(t *testing.T, base string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		res, err := http.Get(base + "/api/workstreams")
		if err == nil {
			res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("server at %s never became ready", base)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func openMustGet(t *testing.T, url string) *http.Response {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	if res.StatusCode != http.StatusOK {
		res.Body.Close()
		t.Fatalf("GET %s: status %d", url, res.StatusCode)
	}
	return res
}

// webUIFreePort asks the OS for a currently-free localhost port.
func webUIFreePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("free-port listen: %v", err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func TestOpenCommandServesAPIAndStopsOnContextCancel(t *testing.T) {
	traceID := ids.Trace()
	spanID := ids.Span()
	at := time.Date(2026, 8, 21, 12, 0, 0, 0, time.UTC)
	mk := func(kind protocol.EventKind, seq int64, payload map[string]any) *protocol.Event {
		raw, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		return &protocol.Event{
			SchemaVersion: protocol.SchemaVersionEvent,
			EventID:       ids.Event(),
			OccurredAt:    at.Add(time.Duration(seq) * time.Millisecond),
			ObservedAt:    at,
			Kind:          kind,
			Sequence:      seq,
			Provenance:    protocol.ProvenanceObserved,
			Payload:       raw,
		}
	}
	seedEvents(t, func(db *storage.DB) {
		ctx := context.Background()
		events := []*protocol.Event{
			mk(protocol.EventTraceStarted, 1, map[string]any{"trace_id": traceID, "objective": "seed objective"}),
			mk(protocol.EventSpanStarted, 2, map[string]any{"span_id": spanID, "trace_id": traceID, "kind": "AGENT", "name": "agent"}),
			mk(protocol.EventSpanCompleted, 3, map[string]any{"span_id": spanID}),
			mk(protocol.EventTraceCompleted, 4, map[string]any{"trace_id": traceID}),
		}
		for _, e := range events {
			if _, err := db.AppendEvent(ctx, e); err != nil {
				t.Fatalf("AppendEvent: %v", err)
			}
		}
	})

	port := webUIFreePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done, out := startOpen(ctx, newWebUIApp(t), strconv.Itoa(port))
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	waitOpenReady(t, base)

	// The API serves the seeded trace with the debugger's security policy.
	res := openMustGet(t, base+"/api/traces")
	const wantCSP = "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
	if got := res.Header.Get("Content-Security-Policy"); got != wantCSP {
		t.Errorf("CSP = %q, want %q", got, wantCSP)
	}
	var env struct {
		Items []*protocol.Trace `json:"items"`
	}
	if err := json.NewDecoder(res.Body).Decode(&env); err != nil {
		t.Fatalf("decode traces: %v", err)
	}
	res.Body.Close()
	if len(env.Items) != 1 || env.Items[0].TraceID != traceID {
		t.Fatalf("traces = %+v, want exactly the seeded trace %s", env.Items, traceID)
	}

	// The static index is served at /.
	res = openMustGet(t, base+"/")
	res.Body.Close()
	if !strings.Contains(res.Header.Get("Content-Type"), "text/html") {
		t.Errorf("index content-type = %q, want text/html", res.Header.Get("Content-Type"))
	}

	// Context cancellation stops the server cleanly.
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("open returned error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("open did not stop after context cancellation")
	}
	if !strings.Contains(out.String(), "http://127.0.0.1:") {
		t.Errorf("stdout = %q, want it to print the URL", out.String())
	}
	if !strings.Contains(out.String(), "localhost only") {
		t.Errorf("stdout = %q, want it to mention localhost-only binding", out.String())
	}
}

func TestOpenCommandPortZeroPicksFreePort(t *testing.T) {
	isolateDataDir(t)
	port := webUIFreePort(t)
	_ = port

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done, out := startOpen(ctx, newWebUIApp(t), "0")

	// The printed URL must carry a concrete (non-zero) port. Poll the
	// buffer until the line appears.
	urlRe := regexp.MustCompile(`http://127\.0\.0\.1:(\d+)/`)
	deadline := time.Now().Add(5 * time.Second)
	var portStr string
	for portStr == "" {
		if m := urlRe.FindStringSubmatch(out.String()); m != nil && m[1] != "0" {
			portStr = m[1]
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("open never printed its URL (stdout %q)", out.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	waitOpenReady(t, "http://127.0.0.1:"+portStr)

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("open returned error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("open did not stop after context cancellation")
	}
}
