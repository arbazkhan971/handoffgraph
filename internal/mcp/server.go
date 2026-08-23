// Package mcp implements HandoffGraph's local MCP (Model Context Protocol)
// stdio server (roadmap v0.4.0, "Local MCP v0").
//
// The server speaks JSON-RPC 2.0 over newline-delimited stdio per the MCP
// transport rules: responses go to stdout, one JSON message per line, and all
// diagnostics go to stderr — stdout is reserved for the protocol.
//
// It exposes exactly nine goal-oriented tools backed by the local SQLite
// event store. Tool access is scoped: any workstream, repository, trace or
// checkpoint id that is not present in the local database is rejected, so no
// tool can read or write across workstreams.
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"strings"
	"sync"

	"github.com/handoffgraph/handoffgraph/internal/redact"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// JSON-RPC 2.0 error codes implemented by the server.
const (
	CodeParseError     = -32700
	CodeInvalidRequest = -32600
	CodeMethodNotFound = -32601
	CodeInvalidParams  = -32602
	CodeInternal       = -32603
)

// latestProtocolVersion is the MCP protocol revision this server targets
// when the client does not advertise one.
const latestProtocolVersion = "2025-06-18"

// maxMessageBytes caps one stdio message, matching the ingest spool limit.
const maxMessageBytes = 16 * 1024 * 1024

// serverInstructions is the guidance returned from initialize.
const serverInstructions = "HandoffGraph local continuity tools. Read context with get_workstream_context and get_trace_context before working; record decisions, verifications, and file claims as you go; hand off or complete the workstream when finished. All evidence keeps its provenance (OBSERVED/DECLARED/INFERRED) and every tool is scoped to workstreams in this local database."

// rpcError is a JSON-RPC error response payload.
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string { return fmt.Sprintf("json-rpc %d: %s", e.Code, e.Message) }

func errParse(msg string) *rpcError { return &rpcError{Code: CodeParseError, Message: msg} }
func errInvalidRequest(msg string) *rpcError {
	return &rpcError{Code: CodeInvalidRequest, Message: msg}
}
func errMethodNotFound(method string) *rpcError {
	return &rpcError{Code: CodeMethodNotFound, Message: fmt.Sprintf("method not found: %q", method)}
}
func errInvalidParams(msg string) *rpcError { return &rpcError{Code: CodeInvalidParams, Message: msg} }
func errInternal(err error) *rpcError {
	return &rpcError{Code: CodeInternal, Message: fmt.Sprintf("internal error: %v", err)}
}

// ToolError marks a domain-level tool failure: the request was valid and
// correctly scoped, but the operation itself must not be applied (for
// example, completing an already-completed workstream). Such failures
// surface as an MCP tool result with isError=true and
// structuredContent.isValidTool=false rather than as a protocol error.
type ToolError struct {
	Msg string
}

func (e *ToolError) Error() string { return e.Msg }

// Tool is one MCP tool exposed through tools/list and tools/call.
type Tool struct {
	Name        string
	Description string
	// InputSchema is the JSON Schema for the tool's arguments object.
	InputSchema map[string]any
	// Handler runs the tool. args is the raw arguments object; the handler
	// must validate it strictly. Protocol-level rejections are signalled by
	// returning a *rpcError; domain failures by returning a *ToolError.
	Handler func(ctx context.Context, args json.RawMessage) (any, error)
}

// Options configures NewServer.
type Options struct {
	// Version is reported in initialize serverInfo (defaults to "dev").
	Version string
	// Stderr receives diagnostics logs (defaults to io.Discard).
	Stderr io.Writer
	// Redaction supplies the user's fail-closed checkpoint export policy.
	Redaction *redact.Options
}

// Server is the local MCP stdio server.
type Server struct {
	name    string
	version string
	tools   []Tool
	log     *log.Logger
}

// NewServer returns a server exposing the nine v0.4.0 tools backed by db.
func NewServer(db *storage.DB, opts Options) *Server {
	stderr := opts.Stderr
	if stderr == nil {
		stderr = io.Discard
	}
	version := opts.Version
	if version == "" {
		version = "dev"
	}
	return &Server{
		name:    "handoffgraph",
		version: version,
		tools:   newToolsetWithRedaction(db, opts.Redaction),
		log:     log.New(stderr, "handoffgraph-mcp: ", log.LstdFlags|log.Lmsgprefix),
	}
}

// lockedWriter serializes response writes so the read loop is the only
// producer yet writes remain whole-message atomic.
type lockedWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (l *lockedWriter) write(b []byte) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, err := l.w.Write(b); err != nil {
		return err
	}
	_, err := l.w.Write([]byte("\n"))
	return err
}

// Serve reads newline-delimited JSON-RPC messages from in until EOF or
// context cancellation, writing one response line per request to out.
// Notifications never produce responses. Diagnostics go to stderr only.
func (s *Server) Serve(ctx context.Context, in io.Reader, out io.Writer) error {
	w := &lockedWriter{w: out}
	sc := bufio.NewScanner(in)
	sc.Buffer(make([]byte, 0, 64*1024), maxMessageBytes)
	for sc.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		resp := s.handleLine(ctx, line)
		if resp == nil {
			continue // notification
		}
		if err := w.write(resp); err != nil {
			return err
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	return ctx.Err()
}

// handleLine processes one raw message and returns the encoded response to
// write, or nil when the message is a notification.
func (s *Server) handleLine(ctx context.Context, line []byte) []byte {
	// Stage 1: JSON syntax. A non-object but valid JSON value is an
	// invalid request; a syntax error is a parse error.
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(line, &envelope); err != nil {
		var se *json.SyntaxError
		if errors.As(err, &se) {
			return s.errorResponse(nullID(), errParse("parse error: invalid JSON"))
		}
		return s.errorResponse(nullID(), errInvalidRequest("request must be a JSON object"))
	}
	if envelope == nil { // the literal `null`
		return s.errorResponse(nullID(), errInvalidRequest("request must be a JSON object"))
	}

	// Stage 2: envelope validity.
	var id json.RawMessage
	hasID := false
	if raw, ok := envelope["id"]; ok {
		hasID = true
		id = raw
	}
	var version string
	if raw, ok := envelope["jsonrpc"]; ok {
		if err := json.Unmarshal(raw, &version); err != nil {
			return s.errorResponse(id, errInvalidRequest(`"jsonrpc" must be a string`))
		}
	}
	if version != "2.0" {
		return s.errorResponse(id, errInvalidRequest(`"jsonrpc" must be "2.0"`))
	}
	method := ""
	if raw, ok := envelope["method"]; ok {
		if err := json.Unmarshal(raw, &method); err != nil {
			return s.errorResponse(id, errInvalidRequest(`"method" must be a string`))
		}
	}
	if method == "" {
		return s.errorResponse(id, errInvalidRequest(`"method" is required`))
	}
	if hasID && !validID(id) {
		return s.errorResponse(id, errInvalidRequest(`"id" must be a string, number, or null`))
	}

	// JSON-RPC 2.0: requests without an id are notifications and must not
	// receive a response. MCP notification methods ("notifications/*") are
	// always notifications; an id on one is logged as a protocol violation.
	isNotification := !hasID || string(bytes.TrimSpace(id)) == "null"
	if strings.HasPrefix(method, "notifications/") {
		if hasID && string(bytes.TrimSpace(id)) != "null" {
			s.log.Printf("protocol violation: notification %s carries an id; no response sent", method)
		} else {
			s.log.Printf("notification: %s", method)
		}
		return nil
	}
	if isNotification {
		s.log.Printf("notification: %s", method)
		return nil
	}

	// Stage 3: dispatch.
	result, rerr := s.dispatch(ctx, method, envelope["params"])
	if rerr != nil {
		return s.errorResponse(id, rerr)
	}
	return s.resultResponse(id, result)
}

// dispatch routes a validated request method.
func (s *Server) dispatch(ctx context.Context, method string, params json.RawMessage) (any, *rpcError) {
	switch method {
	case "initialize":
		return s.handleInitialize(params)
	case "tools/list":
		return s.handleToolsList(params)
	case "tools/call":
		return s.handleToolsCall(ctx, params)
	default:
		return nil, errMethodNotFound(method)
	}
}

// initializeParams is the MCP initialize request payload. _meta is allowed
// on every MCP request, so it is accepted here and ignored.
type initializeParams struct {
	ProtocolVersion string                     `json:"protocolVersion"`
	Capabilities    map[string]json.RawMessage `json:"capabilities"`
	ClientInfo      initializeClientInfo       `json:"clientInfo"`
	Meta            json.RawMessage            `json:"_meta"`
}

type initializeClientInfo struct {
	Name    string `json:"name"`
	Title   string `json:"title,omitempty"`
	Version string `json:"version,omitempty"`
}

func (s *Server) handleInitialize(params json.RawMessage) (any, *rpcError) {
	var p initializeParams
	if len(bytes.TrimSpace(params)) > 0 && string(bytes.TrimSpace(params)) != "null" {
		if e := decodeStrict(params, "params", &p); e != nil {
			return nil, e
		}
	}
	version := p.ProtocolVersion
	if version == "" {
		version = latestProtocolVersion
	}
	return map[string]any{
		"protocolVersion": version,
		"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
		"serverInfo":      map[string]any{"name": s.name, "version": s.version},
		"instructions":    serverInstructions,
	}, nil
}

// toolsListParams is the MCP tools/list request payload.
type toolsListParams struct {
	Cursor string          `json:"cursor,omitempty"`
	Meta   json.RawMessage `json:"_meta"`
}

func (s *Server) handleToolsList(params json.RawMessage) (any, *rpcError) {
	var p toolsListParams
	if len(bytes.TrimSpace(params)) > 0 && string(bytes.TrimSpace(params)) != "null" {
		if e := decodeStrict(params, "params", &p); e != nil {
			return nil, e
		}
	}
	tools := make([]map[string]any, 0, len(s.tools))
	for _, t := range s.tools {
		tools = append(tools, map[string]any{
			"name":        t.Name,
			"description": t.Description,
			"inputSchema": t.InputSchema,
		})
	}
	return map[string]any{"tools": tools}, nil
}

// toolsCallParams is the MCP tools/call request payload. Tool arguments are
// validated strictly by the tool handlers themselves.
type toolsCallParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
	Meta      json.RawMessage `json:"_meta"`
}

func (s *Server) handleToolsCall(ctx context.Context, params json.RawMessage) (any, *rpcError) {
	if len(bytes.TrimSpace(params)) == 0 {
		return nil, errInvalidParams("params are required")
	}
	var p toolsCallParams
	if e := decodeStrict(params, "params", &p); e != nil {
		return nil, e
	}
	if p.Name == "" {
		return nil, errInvalidParams(`"name" is required`)
	}
	tool := s.toolByName(p.Name)
	if tool == nil {
		return nil, errInvalidParams(fmt.Sprintf("unknown tool %q (available: %s)", p.Name, s.toolNames()))
	}
	args := p.Arguments
	trimmed := bytes.TrimSpace(args)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		args = json.RawMessage("{}")
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(args, &obj); err != nil {
		return nil, errInvalidParams(`"arguments" must be a JSON object`)
	}

	payload, err := tool.Handler(ctx, args)
	if err != nil {
		var re *rpcError
		if errors.As(err, &re) {
			return nil, re
		}
		var te *ToolError
		if errors.As(err, &te) {
			structured := map[string]any{
				"tool":        tool.Name,
				"isValidTool": false,
				"error":       te.Msg,
			}
			return toolCallResult(structured, true), nil
		}
		return nil, errInternal(err)
	}

	// Re-marshal the payload into a generic object so the envelope can add
	// the isValidTool flag. encoding/json sorts map keys, so the encoding
	// stays deterministic.
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, errInternal(err)
	}
	structured := map[string]any{}
	if err := json.Unmarshal(raw, &structured); err != nil {
		return nil, errInternal(err)
	}
	structured["isValidTool"] = true
	return toolCallResult(structured, false), nil
}

// toolCallResult shapes an MCP tools/call result: a text rendering of the
// structured payload plus the structured content itself, and isError.
func toolCallResult(structured map[string]any, isErr bool) map[string]any {
	text, err := json.Marshal(structured)
	if err != nil {
		text = []byte(`{"error":"tool result marshal failed"}`)
	}
	return map[string]any{
		"content": []any{
			map[string]any{"type": "text", "text": string(text)},
		},
		"structuredContent": structured,
		"isError":           isErr,
	}
}

// toolByName finds a tool by name; tool registration order is the roadmap
// order, so lookups and listings are deterministic.
func (s *Server) toolByName(name string) *Tool {
	for i := range s.tools {
		if s.tools[i].Name == name {
			return &s.tools[i]
		}
	}
	return nil
}

func (s *Server) toolNames() string {
	names := make([]string, 0, len(s.tools))
	for _, t := range s.tools {
		names = append(names, t.Name)
	}
	return strings.Join(names, ", ")
}

// validID reports whether a raw id value is a JSON string, number, or null.
func validID(raw json.RawMessage) bool {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return false
	}
	switch v.(type) {
	case string, float64, nil:
		return true
	}
	return false
}

// nullID is the id used for responses to requests whose id could not be
// recovered (parse errors, invalid envelopes).
func nullID() json.RawMessage { return json.RawMessage("null") }

func (s *Server) resultResponse(id json.RawMessage, result any) []byte {
	return marshalMessage(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func (s *Server) errorResponse(id json.RawMessage, e *rpcError) []byte {
	return marshalMessage(map[string]any{"jsonrpc": "2.0", "id": id, "error": e})
}

// marshalMessage encodes a response; it cannot fail for our types, but a
// hard-coded internal error is kept as a last resort.
func marshalMessage(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte(`{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"internal error: response marshal failed"}}`)
	}
	return b
}

// decodeStrict decodes a JSON object into v, rejecting unknown fields,
// non-object input, and trailing data. label names the payload in error
// messages ("params" or "arguments").
func decodeStrict(raw json.RawMessage, label string, v any) *rpcError {
	if len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		return errInvalidParams(label + " are required")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	err := dec.Decode(v)
	if err == nil && dec.More() {
		err = errors.New("unexpected trailing data")
	}
	if err != nil {
		var te *json.UnmarshalTypeError
		if errors.As(err, &te) && te.Field != "" {
			return errInvalidParams(fmt.Sprintf("invalid %s %q: %s", label, te.Field, err))
		}
		return errInvalidParams(fmt.Sprintf("invalid %s: %s", label, err))
	}
	return nil
}
