package codex

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/handoffgraph/handoffgraph/internal/adapter"
	"github.com/handoffgraph/handoffgraph/internal/content"
	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

const (
	// AppServerTransport identifies the only App Server transport HandoffGraph
	// supports. WebSocket and Unix-socket modes are intentionally excluded.
	AppServerTransport = "stdio"

	DefaultAppServerPageSize = 100
	DefaultAppServerMaxPages = 100

	maxAppServerPageSize          = 1000
	maxAppServerMaxPages          = 1000
	maxAppServerMessagesPerReply  = 1024
	maxAppServerResponseLineBytes = 8 << 20
	defaultAppServerTimeout       = 30 * time.Second
	appServerShutdownTimeout      = 5 * time.Second
)

// ErrAppServerPageLimit reports that the server advertised another page after
// the configured safety bound. The client never returns a silently truncated
// listing.
var ErrAppServerPageLimit = errors.New("codex app-server: page limit exceeded")

// AppServerOptions configures the stable, read-only App Server session lister.
// Binary is one executable path/name, not a shell command. The process is
// always invoked with exactly `app-server --stdio`.
type AppServerOptions struct {
	Binary        string
	ClientVersion string
	PageSize      int
	MaxPages      int
	Timeout       time.Duration
}

// AppServerClient enumerates Codex threads through the stable App Server
// stdio protocol. It sends only initialize, initialized, and thread/list; it
// never starts/resumes a thread or turn and never invokes command endpoints.
type AppServerClient struct {
	options AppServerOptions
	start   appServerStarter
}

// NewAppServerClient returns a production client that launches the installed
// Codex CLI. Zero option values select bounded defaults.
func NewAppServerClient(options AppServerOptions) *AppServerClient {
	return &AppServerClient{options: options, start: startExecAppServer}
}

type appServerProcess interface {
	Stdin() io.WriteCloser
	Stdout() io.ReadCloser
	Stderr() io.Reader
	Wait() error
	Kill() error
}

type appServerStarter func(context.Context, string) (appServerProcess, error)

type execAppServerProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
	stderr io.Reader
}

func startExecAppServer(ctx context.Context, binary string) (appServerProcess, error) {
	// No shell is involved and no caller-controlled arguments are appended.
	// --stdio makes the stable transport boundary explicit even though it is
	// also Codex's current default.
	cmd := exec.CommandContext(ctx, binary, "app-server", "--stdio")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("open stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, fmt.Errorf("open stdout: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, fmt.Errorf("open stderr: %w", err)
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, err
	}
	return &execAppServerProcess{cmd: cmd, stdin: stdin, stdout: stdout, stderr: stderr}, nil
}

func (p *execAppServerProcess) Stdin() io.WriteCloser { return p.stdin }
func (p *execAppServerProcess) Stdout() io.ReadCloser { return p.stdout }
func (p *execAppServerProcess) Stderr() io.Reader     { return p.stderr }
func (p *execAppServerProcess) Wait() error           { return p.cmd.Wait() }
func (p *execAppServerProcess) Kill() error {
	if p.cmd.Process == nil {
		return nil
	}
	return p.cmd.Process.Kill()
}

type normalizedAppServerOptions struct {
	binary        string
	clientVersion string
	pageSize      int
	maxPages      int
	timeout       time.Duration
}

func normalizeAppServerOptions(options AppServerOptions) (normalizedAppServerOptions, error) {
	if options.Binary == "" {
		options.Binary = "codex"
	}
	if strings.IndexByte(options.Binary, 0) >= 0 {
		return normalizedAppServerOptions{}, fmt.Errorf("codex app-server: binary contains NUL")
	}
	if options.ClientVersion == "" {
		options.ClientVersion = "unknown"
	}
	if !utf8.ValidString(options.ClientVersion) || len(options.ClientVersion) > 128 || hasControl(options.ClientVersion) {
		return normalizedAppServerOptions{}, fmt.Errorf("codex app-server: invalid client version")
	}
	if options.PageSize == 0 {
		options.PageSize = DefaultAppServerPageSize
	}
	if options.PageSize < 1 || options.PageSize > maxAppServerPageSize {
		return normalizedAppServerOptions{}, fmt.Errorf("codex app-server: page size must be between 1 and %d", maxAppServerPageSize)
	}
	if options.MaxPages == 0 {
		options.MaxPages = DefaultAppServerMaxPages
	}
	if options.MaxPages < 1 || options.MaxPages > maxAppServerMaxPages {
		return normalizedAppServerOptions{}, fmt.Errorf("codex app-server: max pages must be between 1 and %d", maxAppServerMaxPages)
	}
	if options.Timeout == 0 {
		options.Timeout = defaultAppServerTimeout
	}
	if options.Timeout < time.Millisecond || options.Timeout > 5*time.Minute {
		return normalizedAppServerOptions{}, fmt.Errorf("codex app-server: timeout must be between 1ms and 5m")
	}
	return normalizedAppServerOptions{
		binary:        options.Binary,
		clientVersion: options.ClientVersion,
		pageSize:      options.PageSize,
		maxPages:      options.MaxPages,
		timeout:       options.Timeout,
	}, nil
}

// ListSessions performs one bounded App Server connection and maps the stable
// thread/list metadata into HandoffGraph's provider-native SessionRef shape.
// Returned refs are deterministically sorted newest-created first, then by
// opaque native id. No partial page set is returned on any error.
func (c *AppServerClient) ListSessions(ctx context.Context) ([]adapter.SessionRef, error) {
	if ctx == nil {
		return nil, fmt.Errorf("codex app-server: nil context")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	options, err := normalizeAppServerOptions(c.options)
	if err != nil {
		return nil, err
	}
	if c.start == nil {
		return nil, fmt.Errorf("codex app-server: process starter is nil")
	}

	opCtx, cancel := context.WithTimeout(ctx, options.timeout)
	defer cancel()

	process, err := c.start(opCtx, options.binary)
	if err != nil {
		return nil, fmt.Errorf("codex app-server: start %q: %w", options.binary, err)
	}
	if process == nil || process.Stdin() == nil || process.Stdout() == nil || process.Stderr() == nil {
		if process != nil {
			_ = process.Kill()
			_ = process.Wait()
		}
		return nil, fmt.Errorf("codex app-server: process returned incomplete stdio pipes")
	}

	stderrDone := make(chan struct{})
	go func() {
		// Drain to prevent a full stderr pipe from blocking the child. App
		// Server diagnostics can contain local paths/config context, so they
		// are deliberately not reflected into HandoffGraph output.
		_, _ = io.Copy(io.Discard, process.Stderr())
		close(stderrDone)
	}()

	wire := newAppServerWire(opCtx, process.Stdin(), process.Stdout())
	refs, protocolErr := listAppServerSessions(wire, options)
	closeErr := process.Stdin().Close()
	waitErr := waitForAppServer(opCtx, process)
	<-stderrDone

	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if errors.Is(opCtx.Err(), context.DeadlineExceeded) {
		return nil, fmt.Errorf("codex app-server: operation timed out after %s", options.timeout)
	}

	var finalErr error
	if protocolErr != nil {
		finalErr = protocolErr
	}
	if closeErr != nil {
		finalErr = errors.Join(finalErr, fmt.Errorf("codex app-server: close stdin: %w", closeErr))
	}
	if waitErr != nil {
		finalErr = errors.Join(finalErr, fmt.Errorf("codex app-server: process failed: %w", waitErr))
	}
	if finalErr != nil {
		return nil, finalErr
	}
	return refs, nil
}

func waitForAppServer(ctx context.Context, process appServerProcess) error {
	waitCh := make(chan error, 1)
	go func() { waitCh <- process.Wait() }()
	timer := time.NewTimer(appServerShutdownTimeout)
	defer timer.Stop()
	select {
	case err := <-waitCh:
		return err
	case <-ctx.Done():
		_ = process.Kill()
		<-waitCh
		return ctx.Err()
	case <-timer.C:
		_ = process.Kill()
		<-waitCh
		return fmt.Errorf("shutdown exceeded %s", appServerShutdownTimeout)
	}
}

type appServerWire struct {
	ctx     context.Context
	encoder *json.Encoder
	scanner *bufio.Scanner
}

func newAppServerWire(ctx context.Context, stdin io.Writer, stdout io.Reader) *appServerWire {
	encoder := json.NewEncoder(stdin)
	encoder.SetEscapeHTML(false)
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64<<10), maxAppServerResponseLineBytes)
	return &appServerWire{ctx: ctx, encoder: encoder, scanner: scanner}
}

type rpcCall struct {
	Method string `json:"method"`
	ID     int64  `json:"id"`
	Params any    `json:"params"`
}

type rpcNotification struct {
	Method string `json:"method"`
	Params any    `json:"params"`
}

type rpcEnvelope struct {
	ID     json.RawMessage `json:"id"`
	Method *string         `json:"method"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

type rpcError struct {
	Code    int64  `json:"code"`
	Message string `json:"message"`
}

func (w *appServerWire) send(value any) error {
	if err := w.ctx.Err(); err != nil {
		return err
	}
	if err := w.encoder.Encode(value); err != nil {
		if ctxErr := w.ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		return fmt.Errorf("write request: %w", err)
	}
	return nil
}

func (w *appServerWire) call(method string, id int64, params, result any) error {
	if err := w.send(rpcCall{Method: method, ID: id, Params: params}); err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	raw, err := w.readResponse(id)
	if err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	if err := json.Unmarshal(raw, result); err != nil {
		return fmt.Errorf("%s: malformed result: %w", method, err)
	}
	return nil
}

func (w *appServerWire) notify(method string, params any) error {
	if err := w.send(rpcNotification{Method: method, Params: params}); err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	return nil
}

func (w *appServerWire) readResponse(expectedID int64) (json.RawMessage, error) {
	for messages := 0; messages < maxAppServerMessagesPerReply; messages++ {
		if err := w.ctx.Err(); err != nil {
			return nil, err
		}
		if !w.scanner.Scan() {
			if err := w.ctx.Err(); err != nil {
				return nil, err
			}
			if err := w.scanner.Err(); err != nil {
				return nil, fmt.Errorf("read stdout: %w", err)
			}
			return nil, io.ErrUnexpectedEOF
		}
		line := bytes.TrimSpace(w.scanner.Bytes())
		if len(line) == 0 {
			return nil, fmt.Errorf("malformed empty JSONL message")
		}
		var envelope rpcEnvelope
		if err := json.Unmarshal(line, &envelope); err != nil {
			return nil, fmt.Errorf("malformed JSON: %w", err)
		}

		if envelope.Method != nil {
			if *envelope.Method == "" {
				return nil, fmt.Errorf("malformed notification with empty method")
			}
			if hasJSONField(envelope.ID) {
				return nil, fmt.Errorf("refusing unexpected server request %q", *envelope.Method)
			}
			if hasJSONField(envelope.Result) || hasJSONField(envelope.Error) {
				return nil, fmt.Errorf("malformed notification %q contains response fields", *envelope.Method)
			}
			// Notifications are observational and require no reply. They are
			// tolerated only within this strict per-response message bound.
			continue
		}

		if !hasJSONValue(envelope.ID) {
			return nil, fmt.Errorf("malformed response without id")
		}
		var responseID int64
		if err := json.Unmarshal(envelope.ID, &responseID); err != nil {
			return nil, fmt.Errorf("malformed response id: %w", err)
		}
		if responseID != expectedID {
			return nil, fmt.Errorf("wrong response id %d (want %d)", responseID, expectedID)
		}

		hasResult := hasJSONValue(envelope.Result)
		hasError := hasJSONValue(envelope.Error)
		if hasResult == hasError {
			return nil, fmt.Errorf("malformed response must contain exactly one of result or error")
		}
		if hasError {
			var protocolError rpcError
			if err := json.Unmarshal(envelope.Error, &protocolError); err != nil {
				return nil, fmt.Errorf("malformed protocol error: %w", err)
			}
			if protocolError.Message == "" {
				return nil, fmt.Errorf("protocol error %d", protocolError.Code)
			}
			return nil, fmt.Errorf("protocol error %d: %s", protocolError.Code, protocolError.Message)
		}
		return append(json.RawMessage(nil), envelope.Result...), nil
	}
	return nil, fmt.Errorf("response exceeded %d messages", maxAppServerMessagesPerReply)
}

func hasJSONValue(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null"))
}

func hasJSONField(raw json.RawMessage) bool {
	return len(bytes.TrimSpace(raw)) > 0
}

type initializeParams struct {
	ClientInfo initializeClientInfo `json:"clientInfo"`
}

type initializeClientInfo struct {
	Name    string `json:"name"`
	Title   string `json:"title"`
	Version string `json:"version"`
}

type initializeResponse struct {
	UserAgent      *string `json:"userAgent"`
	PlatformFamily *string `json:"platformFamily"`
	PlatformOS     *string `json:"platformOs"`
	CodexHome      *string `json:"codexHome"`
}

type threadListParams struct {
	Cursor         *string  `json:"cursor"`
	Limit          int      `json:"limit"`
	SortKey        string   `json:"sortKey"`
	SortDirection  string   `json:"sortDirection"`
	ModelProviders []string `json:"modelProviders"`
	SourceKinds    []string `json:"sourceKinds"`
	Archived       bool     `json:"archived"`
	UseStateDBOnly bool     `json:"useStateDbOnly"`
}

var stableThreadSourceKinds = []string{
	"appServer",
	"cli",
	"exec",
	"subAgent",
	"subAgentCompact",
	"subAgentOther",
	"subAgentReview",
	"subAgentThreadSpawn",
	"unknown",
	"vscode",
}

type threadListResponse struct {
	Data       *[]appServerThread `json:"data"`
	NextCursor *string            `json:"nextCursor"`
}

type appServerThread struct {
	ID            string             `json:"id"`
	SessionID     string             `json:"sessionId"`
	Preview       *string            `json:"preview"`
	Name          *string            `json:"name"`
	Ephemeral     *bool              `json:"ephemeral"`
	ModelProvider *string            `json:"modelProvider"`
	CreatedAt     *int64             `json:"createdAt"`
	UpdatedAt     *int64             `json:"updatedAt"`
	CWD           *string            `json:"cwd"`
	CLIVersion    *string            `json:"cliVersion"`
	Source        json.RawMessage    `json:"source"`
	Status        json.RawMessage    `json:"status"`
	Turns         *[]json.RawMessage `json:"turns"`
}

func listAppServerSessions(wire *appServerWire, options normalizedAppServerOptions) ([]adapter.SessionRef, error) {
	requestID := int64(1)
	var initialized initializeResponse
	if err := wire.call("initialize", requestID, initializeParams{ClientInfo: initializeClientInfo{
		Name:    "handoffgraph",
		Title:   "HandoffGraph",
		Version: options.clientVersion,
	}}, &initialized); err != nil {
		return nil, fmt.Errorf("codex app-server: %w", err)
	}
	if err := validateInitializeResponse(initialized); err != nil {
		return nil, err
	}
	if err := wire.notify("initialized", struct{}{}); err != nil {
		return nil, fmt.Errorf("codex app-server: %w", err)
	}

	requestID++
	var cursor *string
	seenCursors := make(map[string]struct{})
	seenThreads := make(map[string]struct{})
	refs := make([]adapter.SessionRef, 0)

	for pageNumber := 1; pageNumber <= options.maxPages; pageNumber++ {
		params := threadListParams{
			Cursor:         cursor,
			Limit:          options.pageSize,
			SortKey:        "created_at",
			SortDirection:  "desc",
			ModelProviders: []string{},
			SourceKinds:    append([]string(nil), stableThreadSourceKinds...),
			Archived:       false,
			// The server's default false path may scan JSONL logs and repair
			// metadata. State-DB-only makes this integration read-only.
			UseStateDBOnly: true,
		}
		var page threadListResponse
		if err := wire.call("thread/list", requestID, params, &page); err != nil {
			return nil, fmt.Errorf("codex app-server: page %d: %w", pageNumber, err)
		}
		if page.Data == nil {
			return nil, fmt.Errorf("codex app-server: page %d: malformed result missing data array", pageNumber)
		}
		for itemIndex, thread := range *page.Data {
			ref, err := mapAppServerThread(thread)
			if err != nil {
				return nil, fmt.Errorf("codex app-server: page %d item %d: %w", pageNumber, itemIndex+1, err)
			}
			if _, exists := seenThreads[ref.NativeID]; exists {
				return nil, fmt.Errorf("codex app-server: duplicate thread id %q across pages", ref.NativeID)
			}
			seenThreads[ref.NativeID] = struct{}{}
			refs = append(refs, ref)
		}

		if page.NextCursor == nil {
			sortSessionRefs(refs)
			return refs, nil
		}
		if *page.NextCursor == "" || !utf8.ValidString(*page.NextCursor) || len(*page.NextCursor) > 16<<10 {
			return nil, fmt.Errorf("codex app-server: page %d: invalid next cursor", pageNumber)
		}
		if _, exists := seenCursors[*page.NextCursor]; exists {
			return nil, fmt.Errorf("codex app-server: repeated next cursor on page %d", pageNumber)
		}
		if pageNumber == options.maxPages {
			return nil, fmt.Errorf("%w after %d pages", ErrAppServerPageLimit, options.maxPages)
		}
		seenCursors[*page.NextCursor] = struct{}{}
		next := *page.NextCursor
		cursor = &next
		requestID++
	}

	return nil, fmt.Errorf("%w after %d pages", ErrAppServerPageLimit, options.maxPages)
}

func validateInitializeResponse(response initializeResponse) error {
	if response.UserAgent == nil || response.PlatformFamily == nil || response.PlatformOS == nil || response.CodexHome == nil {
		return fmt.Errorf("codex app-server: malformed initialize result")
	}
	if *response.UserAgent == "" || *response.PlatformFamily == "" || *response.PlatformOS == "" {
		return fmt.Errorf("codex app-server: malformed initialize result contains empty runtime metadata")
	}
	if *response.CodexHome == "" || !filepath.IsAbs(*response.CodexHome) {
		return fmt.Errorf("codex app-server: malformed initialize result contains non-absolute codexHome")
	}
	return nil
}

func mapAppServerThread(thread appServerThread) (adapter.SessionRef, error) {
	if err := validateOpaqueNativeID("thread id", thread.ID); err != nil {
		return adapter.SessionRef{}, err
	}
	if err := validateOpaqueNativeID("session id", thread.SessionID); err != nil {
		return adapter.SessionRef{}, err
	}
	if thread.Preview == nil || thread.Ephemeral == nil || thread.ModelProvider == nil || thread.CreatedAt == nil || thread.UpdatedAt == nil || thread.CWD == nil || thread.CLIVersion == nil || thread.Turns == nil {
		return adapter.SessionRef{}, fmt.Errorf("thread %q is missing required stable metadata", thread.ID)
	}
	if len(*thread.Turns) != 0 {
		return adapter.SessionRef{}, fmt.Errorf("thread %q unexpectedly included turn contents", thread.ID)
	}
	if *thread.CWD == "" || !filepath.IsAbs(*thread.CWD) || !utf8.ValidString(*thread.CWD) {
		return adapter.SessionRef{}, fmt.Errorf("thread %q has invalid cwd", thread.ID)
	}
	if *thread.CreatedAt < 0 || *thread.UpdatedAt < 0 || *thread.CreatedAt > 253402300799 || *thread.UpdatedAt > 253402300799 {
		return adapter.SessionRef{}, fmt.Errorf("thread %q has out-of-range timestamps", thread.ID)
	}
	if *thread.UpdatedAt < *thread.CreatedAt {
		return adapter.SessionRef{}, fmt.Errorf("thread %q updatedAt precedes createdAt", thread.ID)
	}
	if !utf8.ValidString(*thread.Preview) || !utf8.ValidString(*thread.ModelProvider) || !utf8.ValidString(*thread.CLIVersion) {
		return adapter.SessionRef{}, fmt.Errorf("thread %q has invalid UTF-8 metadata", thread.ID)
	}
	if thread.Name != nil && !utf8.ValidString(*thread.Name) {
		return adapter.SessionRef{}, fmt.Errorf("thread %q has invalid UTF-8 title", thread.ID)
	}
	source, err := canonicalNativeSource(thread.Source)
	if err != nil {
		return adapter.SessionRef{}, fmt.Errorf("thread %q: %w", thread.ID, err)
	}
	if err := validateThreadStatus(thread.Status); err != nil {
		return adapter.SessionRef{}, fmt.Errorf("thread %q: %w", thread.ID, err)
	}

	title := ""
	if thread.Name != nil {
		title = *thread.Name
	}
	return adapter.SessionRef{
		Provider:    protocol.ProviderCodex,
		NativeID:    thread.ID,
		StartedAt:   time.Unix(*thread.CreatedAt, 0).UTC(),
		LastEventAt: time.Unix(*thread.UpdatedAt, 0).UTC(),
		Metadata: &adapter.SessionMetadata{
			NativeGroupID: thread.SessionID,
			Title:         title,
			Preview:       *thread.Preview,
			WorkingDir:    *thread.CWD,
			ModelProvider: *thread.ModelProvider,
			CLIVersion:    *thread.CLIVersion,
			NativeSource:  source,
			Ephemeral:     *thread.Ephemeral,
		},
	}, nil
}

func validateOpaqueNativeID(label, value string) error {
	if value == "" || len(value) > 256 || !utf8.ValidString(value) {
		return fmt.Errorf("invalid %s", label)
	}
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '-', r == '_', r == '.', r == ':':
		default:
			return fmt.Errorf("invalid %s %q", label, value)
		}
	}
	return nil
}

func canonicalNativeSource(raw json.RawMessage) (json.RawMessage, error) {
	if !hasJSONValue(raw) {
		return nil, fmt.Errorf("missing source metadata")
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("malformed source metadata: %w", err)
	}
	switch source := value.(type) {
	case string:
		switch source {
		case "cli", "vscode", "exec", "appServer", "unknown":
		default:
			return nil, fmt.Errorf("unsupported source metadata %q", source)
		}
	case map[string]any:
		if len(source) != 1 {
			return nil, fmt.Errorf("malformed source metadata object")
		}
		if custom, ok := source["custom"]; ok {
			if _, ok := custom.(string); !ok {
				return nil, fmt.Errorf("malformed custom source metadata")
			}
		} else if subAgent, ok := source["subAgent"]; ok {
			switch subAgent.(type) {
			case string, map[string]any:
			default:
				return nil, fmt.Errorf("malformed subAgent source metadata")
			}
		} else {
			return nil, fmt.Errorf("unsupported source metadata object")
		}
	default:
		return nil, fmt.Errorf("malformed source metadata type")
	}
	canonical, err := content.CanonicalJSON(value)
	if err != nil {
		return nil, fmt.Errorf("canonicalize source metadata: %w", err)
	}
	return canonical, nil
}

func validateThreadStatus(raw json.RawMessage) error {
	if !hasJSONValue(raw) {
		return fmt.Errorf("missing status metadata")
	}
	var status map[string]any
	if err := json.Unmarshal(raw, &status); err != nil {
		return fmt.Errorf("malformed status metadata: %w", err)
	}
	typeName, ok := status["type"].(string)
	if !ok || typeName == "" {
		return fmt.Errorf("malformed status metadata missing type")
	}
	return nil
}

func sortSessionRefs(refs []adapter.SessionRef) {
	sort.Slice(refs, func(i, j int) bool {
		if !refs[i].StartedAt.Equal(refs[j].StartedAt) {
			return refs[i].StartedAt.After(refs[j].StartedAt)
		}
		return refs[i].NativeID < refs[j].NativeID
	})
}

func hasControl(value string) bool {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}
