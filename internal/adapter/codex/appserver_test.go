package codex

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

type recordingWriteCloser struct {
	bytes.Buffer
	closed   bool
	writeErr error
	closeErr error
}

func (w *recordingWriteCloser) Write(p []byte) (int, error) {
	if w.writeErr != nil {
		return 0, w.writeErr
	}
	return w.Buffer.Write(p)
}

func (w *recordingWriteCloser) Close() error {
	w.closed = true
	return w.closeErr
}

type readCloser struct{ io.Reader }

func (r readCloser) Close() error { return nil }

type fakeAppServerProcess struct {
	stdin    *recordingWriteCloser
	stdout   io.ReadCloser
	stderr   io.Reader
	waitErr  error
	waited   bool
	killed   bool
	waitOnce sync.Once
}

func newFakeAppServerProcess(stdout string) *fakeAppServerProcess {
	return &fakeAppServerProcess{
		stdin:  &recordingWriteCloser{},
		stdout: readCloser{Reader: strings.NewReader(stdout)},
		stderr: strings.NewReader(""),
	}
}

func (p *fakeAppServerProcess) Stdin() io.WriteCloser { return p.stdin }
func (p *fakeAppServerProcess) Stdout() io.ReadCloser { return p.stdout }
func (p *fakeAppServerProcess) Stderr() io.Reader     { return p.stderr }
func (p *fakeAppServerProcess) Wait() error {
	p.waitOnce.Do(func() { p.waited = true })
	return p.waitErr
}
func (p *fakeAppServerProcess) Kill() error {
	p.killed = true
	return nil
}

func appServerClientForTest(process *fakeAppServerProcess, options AppServerOptions) *AppServerClient {
	return &AppServerClient{
		options: options,
		start: func(context.Context, string) (appServerProcess, error) {
			return process, nil
		},
	}
}

func validInitializeResponse(id int) string {
	return fmt.Sprintf(`{"id":%d,"result":{"userAgent":"codex-cli/0.144.3","platformFamily":"unix","platformOs":"macos","codexHome":"/tmp/codex-home"}}`, id) + "\n"
}

func validThread(id string, createdAt, updatedAt int64) string {
	thread := map[string]any{
		"id":            id,
		"sessionId":     "tree_" + id,
		"preview":       "preview " + id,
		"name":          "title " + id,
		"ephemeral":     false,
		"modelProvider": "openai",
		"createdAt":     createdAt,
		"updatedAt":     updatedAt,
		"cwd":           "/repo/" + id,
		"cliVersion":    "0.144.3",
		"source":        "cli",
		"status":        map[string]any{"type": "notLoaded"},
		"turns":         []any{},
	}
	b, err := json.Marshal(thread)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func threadListResponseJSON(id int, threads []string, nextCursor any) string {
	return fmt.Sprintf(`{"id":%d,"result":{"data":[%s],"nextCursor":%s}}`, id, strings.Join(threads, ","), mustJSONForTest(nextCursor)) + "\n"
}

func mustJSONForTest(value any) string {
	b, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func TestAppServerListSessionsHandshakePaginationAndMapping(t *testing.T) {
	stdout := validInitializeResponse(1) +
		`{"method":"account/updated","params":{"reason":"test notification"}}` + "\n" +
		threadListResponseJSON(2, []string{validThread("thr_older", 100, 150)}, "cursor-1") +
		threadListResponseJSON(3, []string{validThread("thr_newer", 200, 250)}, nil)
	process := newFakeAppServerProcess(stdout)
	client := appServerClientForTest(process, AppServerOptions{
		Binary:        "/opt/codex",
		ClientVersion: "0.7.0-beta.1",
		PageSize:      25,
		MaxPages:      3,
	})

	refs, err := client.ListSessions(context.Background())
	if err != nil {
		t.Fatalf("ListSessions: %v", err)
	}
	if len(refs) != 2 || refs[0].NativeID != "thr_newer" || refs[1].NativeID != "thr_older" {
		t.Fatalf("refs order = %+v, want deterministic newest first", refs)
	}
	if refs[0].Provider != "codex" || refs[0].Metadata == nil {
		t.Fatalf("ref mapping = %+v", refs[0])
	}
	metadata := refs[0].Metadata
	if metadata.NativeGroupID != "tree_thr_newer" || metadata.WorkingDir != "/repo/thr_newer" || metadata.Title != "title thr_newer" || metadata.Preview != "preview thr_newer" {
		t.Errorf("metadata = %+v", metadata)
	}
	if metadata.ModelProvider != "openai" || metadata.CLIVersion != "0.144.3" || string(metadata.NativeSource) != `"cli"` || metadata.Ephemeral {
		t.Errorf("native metadata = %+v", metadata)
	}
	if !refs[0].StartedAt.Equal(time.Unix(200, 0).UTC()) || !refs[0].LastEventAt.Equal(time.Unix(250, 0).UTC()) {
		t.Errorf("timestamps = %s / %s", refs[0].StartedAt, refs[0].LastEventAt)
	}
	if !process.stdin.closed || !process.waited || process.killed {
		t.Errorf("process lifecycle closed=%v waited=%v killed=%v", process.stdin.closed, process.waited, process.killed)
	}

	lines := strings.Split(strings.TrimSpace(process.stdin.String()), "\n")
	if len(lines) != 4 {
		t.Fatalf("request lines = %d, want initialize + initialized + 2 pages:\n%s", len(lines), process.stdin.String())
	}
	var requests []map[string]any
	for i, line := range lines {
		var request map[string]any
		if err := json.Unmarshal([]byte(line), &request); err != nil {
			t.Fatalf("request %d is invalid JSON: %v", i+1, err)
		}
		if _, present := request["jsonrpc"]; present {
			t.Errorf("request %d unexpectedly included jsonrpc header", i+1)
		}
		requests = append(requests, request)
	}
	if requests[0]["method"] != "initialize" || requests[1]["method"] != "initialized" || requests[2]["method"] != "thread/list" || requests[3]["method"] != "thread/list" {
		t.Fatalf("methods = %v, want read-only handshake/list sequence", []any{requests[0]["method"], requests[1]["method"], requests[2]["method"], requests[3]["method"]})
	}
	if requests[0]["id"] != float64(1) || requests[2]["id"] != float64(2) || requests[3]["id"] != float64(3) {
		t.Fatalf("request ids = %v/%v/%v, want 1/2/3", requests[0]["id"], requests[2]["id"], requests[3]["id"])
	}
	if _, present := requests[1]["id"]; present {
		t.Error("initialized must be a notification without id")
	}
	initialize := requests[0]["params"].(map[string]any)
	if _, experimental := initialize["capabilities"]; experimental {
		t.Error("stable client must not opt into experimental capabilities")
	}
	clientInfo := initialize["clientInfo"].(map[string]any)
	if clientInfo["name"] != "handoffgraph" || clientInfo["version"] != "0.7.0-beta.1" {
		t.Errorf("clientInfo = %v", clientInfo)
	}
	firstPage := requests[2]["params"].(map[string]any)
	secondPage := requests[3]["params"].(map[string]any)
	if firstPage["useStateDbOnly"] != true || firstPage["sortKey"] != "created_at" || firstPage["sortDirection"] != "desc" || firstPage["archived"] != false {
		t.Errorf("first page params are not the stable read-only query: %v", firstPage)
	}
	if firstPage["cursor"] != nil || secondPage["cursor"] != "cursor-1" || firstPage["limit"] != float64(25) {
		t.Errorf("pagination params first=%v second=%v", firstPage, secondPage)
	}
	if got := len(firstPage["sourceKinds"].([]any)); got != len(stableThreadSourceKinds) {
		t.Errorf("sourceKinds = %d, want %d", got, len(stableThreadSourceKinds))
	}
}

func TestAppServerCapabilityIsNarrowAndHonest(t *testing.T) {
	caps := New().Capabilities()
	if !caps.AppServerSessionEnumeration {
		t.Fatal("App Server session enumeration capability is false")
	}
	if caps.StructuredStreaming {
		t.Fatal("read-only App Server listing must not claim structured live streaming")
	}
}

func TestAppServerListSessionsOutputDeterministic(t *testing.T) {
	stdout := validInitializeResponse(1) + threadListResponseJSON(2, []string{
		validThread("thr_z", 100, 120),
		validThread("thr_a", 100, 130),
	}, nil)
	run := func() []byte {
		process := newFakeAppServerProcess(stdout)
		refs, err := appServerClientForTest(process, AppServerOptions{}).ListSessions(context.Background())
		if err != nil {
			t.Fatalf("ListSessions: %v", err)
		}
		out, err := json.Marshal(refs)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	first, second := run(), run()
	if !bytes.Equal(first, second) {
		t.Fatalf("output differs:\n%s\n%s", first, second)
	}
	var rows []map[string]any
	if err := json.Unmarshal(first, &rows); err != nil {
		t.Fatal(err)
	}
	if rows[0]["native_id"] != "thr_a" || rows[1]["native_id"] != "thr_z" {
		t.Fatalf("tie ordering = %s", first)
	}
}

func TestAppServerListSessionsFailsClosedOnProtocolAndDataErrors(t *testing.T) {
	validPage := threadListResponseJSON(2, []string{validThread("thr_ok", 100, 110)}, nil)
	cases := []struct {
		name      string
		stdout    string
		options   AppServerOptions
		want      string
		wantIs    error
		configure func(*fakeAppServerProcess)
	}{
		{name: "malformed json", stdout: "{not-json\n", want: "malformed JSON"},
		{name: "wrong initialize id", stdout: validInitializeResponse(9), want: "wrong response id 9"},
		{name: "string response id", stdout: `{"id":"1","result":{}}` + "\n", want: "malformed response id"},
		{name: "initialize protocol error", stdout: `{"id":1,"error":{"code":-32000,"message":"not initialized"}}` + "\n", want: "protocol error -32000"},
		{name: "malformed initialize result", stdout: `{"id":1,"result":{"userAgent":"x"}}` + "\n", want: "malformed initialize result"},
		{name: "wrong page id", stdout: validInitializeResponse(1) + `{"id":8,"result":{"data":[]}}` + "\n", want: "wrong response id 8"},
		{name: "page protocol error", stdout: validInitializeResponse(1) + `{"id":2,"error":{"code":-32601,"message":"missing"}}` + "\n", want: "protocol error -32601"},
		{name: "server request refused", stdout: validInitializeResponse(1) + `{"method":"item/commandExecution/requestApproval","id":77,"params":{}}` + "\n", want: "refusing unexpected server request"},
		{name: "null id server message refused", stdout: validInitializeResponse(1) + `{"method":"unexpected","id":null,"params":{}}` + "\n", want: "refusing unexpected server request"},
		{name: "notification with result", stdout: validInitializeResponse(1) + `{"method":"unexpected","result":{}}` + "\n", want: "contains response fields"},
		{name: "missing data", stdout: validInitializeResponse(1) + `{"id":2,"result":{"nextCursor":null}}` + "\n", want: "missing data array"},
		{name: "missing stable thread fields", stdout: validInitializeResponse(1) + threadListResponseJSON(2, []string{`{"id":"thr_bad","sessionId":"tree"}`}, nil), want: "missing required stable metadata"},
		{name: "invalid native id", stdout: validInitializeResponse(1) + threadListResponseJSON(2, []string{strings.Replace(validThread("thr_bad", 100, 110), `"thr_bad"`, `"bad id"`, 1)}, nil), want: "invalid thread id"},
		{name: "non absolute cwd", stdout: validInitializeResponse(1) + threadListResponseJSON(2, []string{strings.Replace(validThread("thr_bad", 100, 110), `"/repo/thr_bad"`, `"relative"`, 1)}, nil), want: "invalid cwd"},
		{name: "turn contents rejected", stdout: validInitializeResponse(1) + threadListResponseJSON(2, []string{strings.Replace(validThread("thr_bad", 100, 110), `"turns":[]`, `"turns":[{"type":"userMessage"}]`, 1)}, nil), want: "unexpectedly included turn contents"},
		{name: "malformed source", stdout: validInitializeResponse(1) + threadListResponseJSON(2, []string{strings.Replace(validThread("thr_bad", 100, 110), `"source":"cli"`, `"source":7`, 1)}, nil), want: "malformed source metadata"},
		{name: "unsupported source", stdout: validInitializeResponse(1) + threadListResponseJSON(2, []string{strings.Replace(validThread("thr_bad", 100, 110), `"source":"cli"`, `"source":"future"`, 1)}, nil), want: "unsupported source metadata"},
		{name: "malformed status", stdout: validInitializeResponse(1) + threadListResponseJSON(2, []string{strings.Replace(validThread("thr_bad", 100, 110), `"status":{"type":"notLoaded"}`, `"status":"notLoaded"`, 1)}, nil), want: "malformed status metadata"},
		{name: "timestamps reversed", stdout: validInitializeResponse(1) + threadListResponseJSON(2, []string{validThread("thr_bad", 200, 100)}, nil), want: "updatedAt precedes createdAt"},
		{name: "duplicate thread", stdout: validInitializeResponse(1) + threadListResponseJSON(2, []string{validThread("thr_dup", 100, 110)}, "next") + threadListResponseJSON(3, []string{validThread("thr_dup", 100, 110)}, nil), want: "duplicate thread id"},
		{name: "repeated cursor", stdout: validInitializeResponse(1) + threadListResponseJSON(2, nil, "next") + threadListResponseJSON(3, nil, "next"), want: "repeated next cursor"},
		{name: "page cap", stdout: validInitializeResponse(1) + threadListResponseJSON(2, nil, "next"), options: AppServerOptions{MaxPages: 1}, want: "page limit exceeded", wantIs: ErrAppServerPageLimit},
		{name: "unexpected eof", stdout: validInitializeResponse(1), want: "unexpected EOF"},
		{name: "write failure", stdout: validInitializeResponse(1) + validPage, want: "write request", configure: func(p *fakeAppServerProcess) { p.stdin.writeErr = errors.New("write failed") }},
		{name: "close failure", stdout: validInitializeResponse(1) + validPage, want: "close stdin", configure: func(p *fakeAppServerProcess) { p.stdin.closeErr = errors.New("close failed") }},
		{name: "process failure", stdout: validInitializeResponse(1) + validPage, want: "process failed", configure: func(p *fakeAppServerProcess) {
			p.waitErr = errors.New("exit 7")
			p.stderr = strings.NewReader("fake app-server failed")
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			process := newFakeAppServerProcess(tc.stdout)
			if tc.configure != nil {
				tc.configure(process)
			}
			refs, err := appServerClientForTest(process, tc.options).ListSessions(context.Background())
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want containing %q", err, tc.want)
			}
			if tc.wantIs != nil && !errors.Is(err, tc.wantIs) {
				t.Fatalf("errors.Is(%v) = false for %v", err, tc.wantIs)
			}
			if refs != nil {
				t.Fatalf("refs = %+v, want nil on any failure", refs)
			}
		})
	}
}

func TestAppServerListSessionsStartFailureAndOptionBounds(t *testing.T) {
	client := &AppServerClient{
		options: AppServerOptions{},
		start: func(context.Context, string) (appServerProcess, error) {
			return nil, errors.New("binary missing")
		},
	}
	if _, err := client.ListSessions(context.Background()); err == nil || !strings.Contains(err.Error(), "binary missing") {
		t.Fatalf("start error = %v", err)
	}

	invalid := []AppServerOptions{
		{PageSize: -1},
		{PageSize: maxAppServerPageSize + 1},
		{MaxPages: -1},
		{MaxPages: maxAppServerMaxPages + 1},
		{Timeout: time.Nanosecond},
		{Timeout: 6 * time.Minute},
		{ClientVersion: "bad\nversion"},
		{Binary: "bad\x00binary"},
	}
	for _, options := range invalid {
		process := newFakeAppServerProcess("")
		if _, err := appServerClientForTest(process, options).ListSessions(context.Background()); err == nil {
			t.Errorf("options %+v succeeded, want validation failure", options)
		}
	}
}

type contextBlockingReader struct {
	ctx     context.Context
	started chan struct{}
	once    sync.Once
}

func (r *contextBlockingReader) Read([]byte) (int, error) {
	r.once.Do(func() { close(r.started) })
	<-r.ctx.Done()
	return 0, r.ctx.Err()
}

func TestAppServerListSessionsHonorsContextCancellation(t *testing.T) {
	cancelled, cancelNow := context.WithCancel(context.Background())
	cancelNow()
	started := false
	client := &AppServerClient{
		start: func(context.Context, string) (appServerProcess, error) {
			started = true
			return nil, errors.New("must not start")
		},
	}
	if _, err := client.ListSessions(cancelled); !errors.Is(err, context.Canceled) {
		t.Fatalf("pre-cancel error = %v", err)
	}
	if started {
		t.Fatal("process started for pre-cancelled context")
	}

	ctx, cancel := context.WithCancel(context.Background())
	readStarted := make(chan struct{})
	process := newFakeAppServerProcess("")
	process.stdout = readCloser{Reader: &contextBlockingReader{ctx: ctx, started: readStarted}}
	client = appServerClientForTest(process, AppServerOptions{Timeout: time.Second})
	result := make(chan error, 1)
	go func() {
		_, err := client.ListSessions(ctx)
		result <- err
	}()
	<-readStarted
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("ListSessions did not stop after context cancellation")
	}
}
