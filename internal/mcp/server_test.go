package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// newTestServer opens a throwaway database and returns a server logging to
// the returned buffer so tests can assert diagnostics stay off stdout.
func newTestServer(t *testing.T) (*Server, *storage.DB, *bytes.Buffer) {
	t.Helper()
	db, err := storage.Open(filepath.Join(t.TempDir(), "mcp.db"))
	if err != nil {
		t.Fatalf("storage.Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	var stderr bytes.Buffer
	return NewServer(db, Options{Stderr: &stderr}), db, &stderr
}

// serveLines feeds lines to the server and returns the raw stdout lines.
func serveLines(t *testing.T, s *Server, lines ...string) []string {
	t.Helper()
	var out bytes.Buffer
	in := strings.NewReader(strings.Join(lines, "\n") + "\n")
	if err := s.Serve(context.Background(), in, &out); err != nil {
		t.Fatalf("Serve: %v", err)
	}
	raw := strings.TrimRight(out.String(), "\n")
	if raw == "" {
		return nil
	}
	return strings.Split(raw, "\n")
}

// decodeResponse decodes one JSON-RPC response line.
func decodeResponse(t *testing.T, line string) (id json.RawMessage, result json.RawMessage, code int, message string) {
	t.Helper()
	var resp struct {
		ID     *json.RawMessage `json:"id"`
		Result json.RawMessage  `json:"result"`
		Error  *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
		JSONRPC string `json:"jsonrpc"`
	}
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		t.Fatalf("response line is not JSON (%s): %v", line, err)
	}
	if resp.JSONRPC != "2.0" {
		t.Fatalf("response jsonrpc field = %q, want 2.0", resp.JSONRPC)
	}
	if resp.ID != nil {
		id = *resp.ID
	}
	if resp.Error != nil {
		return id, nil, resp.Error.Code, resp.Error.Message
	}
	return id, resp.Result, 0, ""
}

func mustCall(t *testing.T, s *Server, name string, args string) map[string]any {
	t.Helper()
	line := fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":%q,"arguments":%s}}`, name, args)
	responses := serveLines(t, s, line)
	if len(responses) != 1 {
		t.Fatalf("got %d responses, want 1: %v", len(responses), responses)
	}
	_, result, code, msg := decodeResponse(t, responses[0])
	if code != 0 {
		t.Fatalf("tools/call %s: rpc error %d: %s", name, code, msg)
	}
	var call struct {
		StructuredContent map[string]any `json:"structuredContent"`
	}
	if err := json.Unmarshal(result, &call); err != nil {
		t.Fatalf("decode tools/call result: %v", err)
	}
	return call.StructuredContent
}

// TestServeJSONRPCErrors is a table over the JSON-RPC 2.0 error taxonomy.
func TestServeJSONRPCErrors(t *testing.T) {
	tests := []struct {
		name     string
		line     string
		wantCode int
	}{
		{"parse error", `{not json`, CodeParseError},
		{"truncated json", `{"jsonrpc":"2.0","id":1`, CodeParseError},
		{"empty object", `{}`, CodeInvalidRequest},
		{"wrong version", `{"jsonrpc":"1.0","id":1,"method":"tools/list"}`, CodeInvalidRequest},
		{"missing version", `{"id":1,"method":"tools/list"}`, CodeInvalidRequest},
		{"version not string", `{"jsonrpc":2,"id":1,"method":"tools/list"}`, CodeInvalidRequest},
		{"method not string", `{"jsonrpc":"2.0","id":1,"method":42}`, CodeInvalidRequest},
		{"array request", `[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]`, CodeInvalidRequest},
		{"scalar request", `"hello"`, CodeInvalidRequest},
		{"null request", `null`, CodeInvalidRequest},
		{"id object", `{"jsonrpc":"2.0","id":{"a":1},"method":"tools/list"}`, CodeInvalidRequest},
		{"id boolean", `{"jsonrpc":"2.0","id":true,"method":"tools/list"}`, CodeInvalidRequest},
		{"unknown method", `{"jsonrpc":"2.0","id":7,"method":"resources/list"}`, CodeMethodNotFound},
		{"unknown method no id", `{"jsonrpc":"2.0","method":"bogus/method"}`, -1},                  // notification
		{"initialized notification", `{"jsonrpc":"2.0","method":"notifications/initialized"}`, -1}, // notification
		{"null id notification", `{"jsonrpc":"2.0","id":null,"method":"tools/list"}`, -1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, _, _ := newTestServer(t)
			responses := serveLines(t, s, tt.line)
			if tt.wantCode == -1 {
				if len(responses) != 0 {
					t.Fatalf("notification produced %d responses, want 0: %v", len(responses), responses)
				}
				return
			}
			if len(responses) != 1 {
				t.Fatalf("got %d responses, want 1: %v", len(responses), responses)
			}
			_, _, code, msg := decodeResponse(t, responses[0])
			if code != tt.wantCode {
				t.Fatalf("error code = %d (%s), want %d", code, msg, tt.wantCode)
			}
			if msg == "" {
				t.Fatal("error message is empty")
			}
		})
	}
}

// TestInitializeResult checks the initialize response shape.
func TestInitializeResult(t *testing.T) {
	s, _, _ := newTestServer(t)
	responses := serveLines(t, s,
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test-client","version":"1.0"}}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
	)
	if len(responses) != 1 {
		t.Fatalf("got %d responses, want 1 (notification must not answer): %v", len(responses), responses)
	}
	id, result, code, msg := decodeResponse(t, responses[0])
	if code != 0 {
		t.Fatalf("initialize failed: %d %s", code, msg)
	}
	if string(id) != "1" {
		t.Fatalf("id = %s, want 1", id)
	}
	var res struct {
		ProtocolVersion string `json:"protocolVersion"`
		Capabilities    struct {
			Tools struct {
				ListChanged bool `json:"listChanged"`
			} `json:"tools"`
		} `json:"capabilities"`
		ServerInfo struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"serverInfo"`
		Instructions string `json:"instructions"`
	}
	if err := json.Unmarshal(result, &res); err != nil {
		t.Fatalf("decode initialize result: %v", err)
	}
	if res.ProtocolVersion != "2025-06-18" {
		t.Fatalf("protocolVersion = %q, want echo of client version", res.ProtocolVersion)
	}
	if res.Capabilities.Tools.ListChanged {
		t.Fatal("capabilities.tools.listChanged = true, want false")
	}
	if res.ServerInfo.Name != "handoffgraph" || res.ServerInfo.Version == "" {
		t.Fatalf("serverInfo = %+v", res.ServerInfo)
	}
	if res.Instructions == "" {
		t.Fatal("instructions is empty")
	}
}

// TestInitializeDefaultProtocol checks the fallback protocol version and
// strict validation of initialize params.
func TestInitializeParams(t *testing.T) {
	tests := []struct {
		name             string
		params           string
		wantCode         int
		wantProtocolVers string
	}{
		{"no params", "", 0, latestProtocolVersion},
		{"empty object", `{}`, 0, latestProtocolVersion},
		{"unknown field", `{"bogus":true}`, CodeInvalidParams, ""},
		{"protocolVersion not string", `{"protocolVersion":42}`, CodeInvalidParams, ""},
		{"meta allowed", `{"_meta":{"progressToken":1}}`, 0, latestProtocolVersion},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, _, _ := newTestServer(t)
			line := `{"jsonrpc":"2.0","id":2,"method":"initialize"`
			if tt.params != "" {
				line += `,"params":` + tt.params
			}
			line += `}`
			responses := serveLines(t, s, line)
			if len(responses) != 1 {
				t.Fatalf("got %d responses, want 1", len(responses))
			}
			_, result, code, msg := decodeResponse(t, responses[0])
			if code != tt.wantCode {
				t.Fatalf("code = %d (%s), want %d", code, msg, tt.wantCode)
			}
			if tt.wantCode == 0 {
				var res struct {
					ProtocolVersion string `json:"protocolVersion"`
				}
				if err := json.Unmarshal(result, &res); err != nil {
					t.Fatal(err)
				}
				if res.ProtocolVersion != tt.wantProtocolVers {
					t.Fatalf("protocolVersion = %q, want %q", res.ProtocolVersion, tt.wantProtocolVers)
				}
			}
		})
	}
}

// wantToolOrder is the shipped tool list, in order (v0.4.0 nine + the
// parity-P1 score primitive pair).
var wantToolOrder = []string{
	"get_workstream_context",
	"get_trace_context",
	"create_checkpoint",
	"record_decision",
	"record_verification",
	"record_score",
	"list_scores",
	"claim_files",
	"handoff_workstream",
	"accept_handoff",
	"complete_workstream",
}

// TestToolsList checks tools/list contents and determinism.
func TestToolsList(t *testing.T) {
	s, _, _ := newTestServer(t)
	responses := serveLines(t, s,
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
	)
	if len(responses) != 2 {
		t.Fatalf("got %d responses, want 2", len(responses))
	}
	// The ids differ by design; the results must be byte-identical.
	_, r1, c1, _ := decodeResponse(t, responses[0])
	_, r2, c2, _ := decodeResponse(t, responses[1])
	if c1 != 0 || c2 != 0 {
		t.Fatalf("tools/list failed: %d / %d", c1, c2)
	}
	if !bytes.Equal(r1, r2) {
		t.Fatalf("tools/list not deterministic:\n%s\n%s", r1, r2)
	}
	var res struct {
		Tools []struct {
			Name        string         `json:"name"`
			Description string         `json:"description"`
			InputSchema map[string]any `json:"inputSchema"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(r1, &res); err != nil {
		t.Fatal(err)
	}
	if len(res.Tools) != len(wantToolOrder) {
		t.Fatalf("got %d tools, want %d", len(res.Tools), len(wantToolOrder))
	}
	for i, tool := range res.Tools {
		if tool.Name != wantToolOrder[i] {
			t.Fatalf("tool[%d].Name = %q, want %q", i, tool.Name, wantToolOrder[i])
		}
		if tool.Description == "" {
			t.Fatalf("tool %q has empty description", tool.Name)
		}
		if tool.InputSchema["type"] != "object" {
			t.Fatalf("tool %q inputSchema.type = %v, want object", tool.Name, tool.InputSchema["type"])
		}
		if additional, ok := tool.InputSchema["additionalProperties"].(bool); !ok || additional {
			t.Fatalf("tool %q inputSchema must set additionalProperties:false", tool.Name)
		}
		props, ok := tool.InputSchema["properties"].(map[string]any)
		if !ok {
			t.Fatalf("tool %q inputSchema.properties missing", tool.Name)
		}
		if _, ok := props["workstream_id"]; !ok {
			t.Fatalf("tool %q inputSchema lacks workstream_id", tool.Name)
		}
		required, ok := tool.InputSchema["required"].([]any)
		if !ok || len(required) == 0 {
			t.Fatalf("tool %q inputSchema lacks required fields", tool.Name)
		}
		if required[0] != "workstream_id" {
			t.Fatalf("tool %q first required field = %v, want workstream_id", tool.Name, required[0])
		}
	}
}

// TestToolsCallValidation is a table over tools/call input validation.
func TestToolsCallValidation(t *testing.T) {
	tests := []struct {
		name     string
		params   string
		wantCode int
		wantMsg  string
	}{
		{
			name:     "missing params",
			params:   ``,
			wantCode: CodeInvalidParams,
			wantMsg:  "params",
		},
		{
			name:     "missing name",
			params:   `{"arguments":{}}`,
			wantCode: CodeInvalidParams,
			wantMsg:  "name",
		},
		{
			name:     "unknown tool",
			params:   `{"name":"delete_everything","arguments":{}}`,
			wantCode: CodeInvalidParams,
			wantMsg:  "unknown tool",
		},
		{
			name:     "unknown params field",
			params:   `{"name":"get_workstream_context","arguments":{},"bogus":1}`,
			wantCode: CodeInvalidParams,
			wantMsg:  "unknown field",
		},
		{
			name:     "arguments not object",
			params:   `{"name":"get_workstream_context","arguments":["ws_1"]}`,
			wantCode: CodeInvalidParams,
			wantMsg:  "object",
		},
		{
			name:     "arguments positional",
			params:   `{"name":"get_workstream_context","arguments":"ws_1"}`,
			wantCode: CodeInvalidParams,
			wantMsg:  "object",
		},
		{
			name:     "unknown argument field",
			params:   `{"name":"get_workstream_context","arguments":{"workstream_id":"ws_1","extra":true}}`,
			wantCode: CodeInvalidParams,
			wantMsg:  "unknown field",
		},
		{
			name:     "wrong argument type",
			params:   `{"name":"get_workstream_context","arguments":{"workstream_id":42}}`,
			wantCode: CodeInvalidParams,
			wantMsg:  "workstream_id",
		},
		{
			name:     "scoped access rejects unknown workstream",
			params:   `{"name":"get_workstream_context","arguments":{"workstream_id":"ws_missing"}}`,
			wantCode: CodeInvalidParams,
			wantMsg:  "not found in local database",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, _, _ := newTestServer(t)
			line := `{"jsonrpc":"2.0","id":1,"method":"tools/call"`
			if tt.params != "" {
				line += `,"params":` + tt.params
			}
			line += `}`
			responses := serveLines(t, s, line)
			if len(responses) != 1 {
				t.Fatalf("got %d responses, want 1", len(responses))
			}
			_, _, code, msg := decodeResponse(t, responses[0])
			if code != tt.wantCode {
				t.Fatalf("code = %d (%s), want %d", code, msg, tt.wantCode)
			}
			if !strings.Contains(msg, tt.wantMsg) {
				t.Fatalf("message %q does not contain %q", msg, tt.wantMsg)
			}
		})
	}
}

// TestToolsCallResultEnvelope checks the structured content + isValidTool
// envelope on a successful call.
func TestToolsCallResultEnvelope(t *testing.T) {
	s, db, _ := newTestServer(t)
	ctx := context.Background()
	if err := db.CreateWorkstream(ctx, "ws_env", "envelope test", ""); err != nil {
		t.Fatal(err)
	}
	responses := serveLines(t, s,
		`{"jsonrpc":"2.0","id":"call-1","method":"tools/call","params":{"name":"get_workstream_context","arguments":{"workstream_id":"ws_env"}}}`,
	)
	if len(responses) != 1 {
		t.Fatalf("got %d responses, want 1", len(responses))
	}
	id, result, code, msg := decodeResponse(t, responses[0])
	if code != 0 {
		t.Fatalf("tools/call failed: %d %s", code, msg)
	}
	if string(id) != `"call-1"` {
		t.Fatalf("id = %s, want \"call-1\"", id)
	}
	var call struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		StructuredContent map[string]any `json:"structuredContent"`
		IsError           bool           `json:"isError"`
	}
	if err := json.Unmarshal(result, &call); err != nil {
		t.Fatal(err)
	}
	if call.IsError {
		t.Fatal("isError = true, want false")
	}
	if len(call.Content) != 1 || call.Content[0].Type != "text" {
		t.Fatalf("content = %+v, want one text entry", call.Content)
	}
	if v, ok := call.StructuredContent["isValidTool"].(bool); !ok || !v {
		t.Fatalf("structuredContent.isValidTool = %v, want true", call.StructuredContent["isValidTool"])
	}
	var textAsJSON map[string]any
	if err := json.Unmarshal([]byte(call.Content[0].Text), &textAsJSON); err != nil {
		t.Fatalf("content text is not JSON: %v", err)
	}
	if textAsJSON["workstream_id"] != "ws_env" {
		t.Fatalf("content text workstream_id = %v", textAsJSON["workstream_id"])
	}
}

// TestStdoutCarriesOnlyProtocol asserts every stdout line is JSON and
// diagnostics go to stderr.
func TestStdoutCarriesOnlyProtocol(t *testing.T) {
	s, _, stderr := newTestServer(t)
	responses := serveLines(t, s,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{garbage`,
		`{"jsonrpc":"2.0","id":9,"method":"no/such/method"}`,
		``,
		`{"jsonrpc":"2.0","method":"cancelled"}`,
	)
	if len(responses) != 2 {
		t.Fatalf("got %d responses, want 2 (parse error + method not found): %v", len(responses), responses)
	}
	for _, line := range responses {
		var v any
		if err := json.Unmarshal([]byte(line), &v); err != nil {
			t.Fatalf("stdout line is not JSON: %q", line)
		}
	}
	if stderr.Len() == 0 {
		t.Fatal("expected notification logs on stderr, got none")
	}
}

// TestHandlerInternalErrorMapsTo32603 verifies non-rpcError handler failures
// surface as -32603 (triggered by a closed database).
func TestHandlerInternalErrorMapsTo32603(t *testing.T) {
	s, db, _ := newTestServer(t)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	responses := serveLines(t, s,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_workstream_context","arguments":{"workstream_id":"ws_any"}}}`,
	)
	if len(responses) != 1 {
		t.Fatalf("got %d responses, want 1", len(responses))
	}
	_, _, code, _ := decodeResponse(t, responses[0])
	if code != CodeInternal {
		t.Fatalf("code = %d, want %d", code, CodeInternal)
	}
}

// TestServeContextCancel stops the loop when the context is cancelled.
func TestServeContextCancel(t *testing.T) {
	s, _, _ := newTestServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var out bytes.Buffer
	err := s.Serve(ctx, strings.NewReader("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n"), &out)
	if err != context.Canceled {
		t.Fatalf("Serve error = %v, want context.Canceled", err)
	}
	if out.Len() != 0 {
		t.Fatalf("cancelled context produced output: %q", out.String())
	}
}
