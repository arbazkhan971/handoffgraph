package redact

import (
	"encoding/json"
	"errors"
	"path"
	"strings"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

func testEngine(t *testing.T) *Engine {
	t.Helper()
	e, err := New(Options{})
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestRedactAWSAccessKey(t *testing.T) {
	e := testEngine(t)
	out, changed := e.RedactValue("key AKIAIOSFODNN7EXAMPLE here")
	if !changed {
		t.Fatal("expected change")
	}
	if strings.Contains(out, "AKIAIOSFODNN7EXAMPLE") {
		t.Fatalf("secret not redacted: %s", out)
	}
}

func TestRedactGitHubToken(t *testing.T) {
	e := testEngine(t)
	out, changed := e.RedactValue("token=ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD")
	if !changed {
		t.Fatal("expected change")
	}
	if strings.Contains(out, "ghp_") {
		t.Fatalf("secret not redacted: %s", out)
	}
}

func TestRedactHighEntropy(t *testing.T) {
	e := testEngine(t)
	secret := "Xk9pQ2wL8mN4vB7cR1tY6uJ3hG5fD0sA" // 32 chars, mixed case + digits
	out, changed := e.RedactValue("password=" + secret)
	if !changed {
		t.Fatal("expected change for high-entropy token")
	}
	if strings.Contains(out, secret) {
		t.Fatalf("high-entropy secret not redacted: %s", out)
	}
}

func TestRedactEventPayload(t *testing.T) {
	e := testEngine(t)
	ev := &protocol.Event{
		EventID: "evt_test",
		Payload: json.RawMessage(`{"api_key":"AKIAIOSFODNN7EXAMPLE","message":"all good"}`),
	}
	res, err := e.RedactEvent(ev)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != StatusRedacted {
		t.Fatalf("status = %s, want %s", res.Status, StatusRedacted)
	}
	var m map[string]any
	if err := json.Unmarshal(ev.Payload, &m); err != nil {
		t.Fatal(err)
	}
	if m["api_key"] != Mask {
		t.Fatalf("api_key not masked: %v", m["api_key"])
	}
	if m["message"] != "all good" {
		t.Fatalf("unrelated field changed: %v", m["message"])
	}
	if ev.Redaction == nil || len(ev.Redaction.FieldsRemoved) == 0 {
		t.Fatal("redaction metadata not recorded")
	}
}

func TestRedactCleanPayload(t *testing.T) {
	e := testEngine(t)
	ev := &protocol.Event{
		EventID: "evt_test",
		Payload: json.RawMessage(`{"message":"all good"}`),
	}
	res, err := e.RedactEvent(ev)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != StatusClean {
		t.Fatalf("status = %s, want %s", res.Status, StatusClean)
	}
}

func TestDeniedPath(t *testing.T) {
	e, err := New(Options{DenyPaths: []string{".env", ".env.local", "secrets.yaml", "id_rsa", "*.pem"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{".env", "secrets.yaml", "src/.env.local", "id_rsa", "key.pem"} {
		if !e.DeniedPath(p) {
			t.Errorf("expected denied path: %s", p)
		}
	}
	if e.DeniedPath("src/main.go") {
		t.Errorf("unexpected denied path: src/main.go")
	}
}

func TestFailClosedOnInvalidPattern(t *testing.T) {
	_, err := New(Options{UserPatterns: []string{"["}})
	if err == nil {
		t.Fatal("expected error for invalid regex")
	}
}

func TestMatchPathGlob(t *testing.T) {
	tests := []struct {
		name    string
		pattern string
		path    string
		want    bool
	}{
		// Anchoring: full path, basename, and '/'-boundary suffix (v1 behavior).
		{"exact", "src/main.go", "src/main.go", true},
		{"basename", "main.go", "src/main.go", true},
		{"dotfile suffix", ".env", "src/.env", true},
		{"not substring", ".env", "src/foo.env", false},
		{"multi-segment literal", ".aws/credentials", "home/user/.aws/credentials", true},

		// '*' within a single segment.
		{"star suffix", "*.pem", "key.pem", true},
		{"star across dir suffix", "*.pem", "src/key.pem", true},
		{"star matches empty run", "key*pem", "keypem", true},
		{"explicit mid star", "src/*/server.pem", "src/keys/server.pem", true},
		{"strict star does not cross /", "src/?*.pem", "src/keys/server.pem", false},
		{"strict star single segment", "src/?*.pem", "src/k.pem", true},

		// v1 compatibility: pure-literal-and-star patterns keep the old
		// crossing behavior, so coverage never shrinks.
		{"lone star denies all (v1)", "*", "a/b/c", true},
		{"double star like star (v1)", "**", "a/b", true},
		{"double star in pattern (v1)", "src/**", "src/x/deep.pem", true},
		{"star crosses trailing text (v1)", "*.pem", "key.pem.bak", true},
		{"mid star crosses dirs (v1)", "src/*.pem", "src/keys/server.pem", true},

		// '?'
		{"question single char", "?.pem", "k.pem", true},
		{"question exact count", "?.pem", "kk.pem", false},
		{"question in segment", "src/?.go", "src/a.go", true},
		{"question not separator", "src/?", "src/", false},
		{"question matches dot", "?env", ".env", true},

		// Character classes.
		{"class member", "[abc].yaml", "a.yaml", true},
		{"class non-member", "[abc].yaml", "d.yaml", false},
		{"class range", "[a-z0-9].conf", "7.conf", true},
		{"class negation caret", "[^a]bc", "xbc", true},
		{"class negation caret reject", "[^a]bc", "abc", false},
		// path.Match has no '!' negation: '!' is a literal class member.
		{"bang is literal member", "[!a].env", "!.env", true},
		{"bang is literal member 2", "[!a].env", "a.env", true},
		{"bang is not negation", "[!a].env", "b.env", false},

		// Escaping.
		{"escaped star literal", `\*.md`, "*.md", true},
		{"escaped star not glob", `\*.md`, "a.md", false},
		{"escaped question literal", `a\?b`, "a?b", true},
		{"escaped question not glob", `a\?b`, "axb", false},

		// Case-insensitive (v1 behavior).
		{"case-insensitive literal", "SECRETS.YAML", "secrets.yaml", true},
		{"case-insensitive star", "*.PEM", "key.pem", true},

		// Malformed patterns fail closed (non-match; New rejects them).
		{"unclosed bracket", "[", "abc", false},
		{"dangling range", "[a-", "a", false},
		{"empty class", "[]", "x", false},
		{"trailing escape", `a\`, "a", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := matchPath(tt.pattern, tt.path); got != tt.want {
				t.Errorf("matchPath(%q, %q) = %v, want %v", tt.pattern, tt.path, got, tt.want)
			}
		})
	}
}

func TestNewRejectsBadDenyPath(t *testing.T) {
	for _, p := range []string{"[", "[a-", "[]", `x\`} {
		_, err := New(Options{DenyPaths: []string{p}})
		if err == nil {
			t.Errorf("expected error for deny path %q", p)
			continue
		}
		if !errors.Is(err, path.ErrBadPattern) {
			t.Errorf("error for %q does not wrap path.ErrBadPattern: %v", p, err)
		}
	}
}

func TestDeniedPathGlob(t *testing.T) {
	e, err := New(Options{DenyPaths: []string{
		"?.env", "sec[r,t].yaml", "[^a]*.key", `*\[x\].pem`,
	}})
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"a.env", "secr.yaml", "sect.yaml", "my.key", "dir/[x].pem"} {
		if !e.DeniedPath(p) {
			t.Errorf("expected denied path: %s", p)
		}
	}
	for _, p := range []string{"env", "secx.yaml", "a.key", "dir/y.pem"} {
		if e.DeniedPath(p) {
			t.Errorf("unexpected denied path: %s", p)
		}
	}
}

func TestRedactEventDeniesKey(t *testing.T) {
	e, err := New(Options{DenyPaths: []string{"api_key"}})
	if err != nil {
		t.Fatal(err)
	}
	ev := &protocol.Event{
		EventID: "evt_test",
		Payload: json.RawMessage(`{"api_key":"AKIAIOSFODNN7EXAMPLE","note":"fine"}`),
	}
	res, err := e.RedactEvent(ev)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != StatusRedacted {
		t.Fatalf("status = %s, want %s", res.Status, StatusRedacted)
	}
	var m map[string]any
	if err := json.Unmarshal(ev.Payload, &m); err != nil {
		t.Fatal(err)
	}
	if m["api_key"] != Mask {
		t.Fatalf("denied key not masked: %v", m["api_key"])
	}
}
