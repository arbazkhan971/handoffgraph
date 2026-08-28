package observations

import "testing"

// TestNormalizeMessageTable pins the template pipeline: every construct that
// varies run-to-run collapses to its placeholder, and everything that
// identifies the bug survives.
func TestNormalizeMessageTable(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{
			name: "digit runs become <num>",
			in:   "retry 3 of 10 failed after 1500ms",
			want: "retry <num> of <num> failed after <num>ms",
		},
		{
			name: "uuids collapse whole, not digit by digit",
			in:   "request 4f8a2b1c-9d3e-4a5b-8c7d-1e2f3a4b5c6d timed out",
			want: "request <uuid> timed out",
		},
		{
			name: "uppercase uuids too",
			in:   "req 4F8A2B1C-9D3E-4A5B-8C7D-1E2F3A4B5C6D",
			want: "req <uuid>",
		},
		{
			name: "0x hex ids",
			in:   "segfault at address 0xdeadbeef",
			want: "segfault at address <hex>",
		},
		{
			name: "bare hex ids of 8 or more chars",
			in:   "object deadbeefcafe not found",
			want: "object <hex> not found",
		},
		{
			name: "a long run of digits is a number, not a hex id",
			in:   "timestamp 1756382400 rejected",
			want: "timestamp <num> rejected",
		},
		{
			name: "absolute paths collapse before their digits do",
			in:   "cannot open /usr/lib/python3.11/site-packages/mod.py",
			want: "cannot open <path>",
		},
		{
			name: "relative paths starting with ./",
			in:   "parse error in ./src/handler/v2/main.go",
			want: "parse error in <path>",
		},
		{
			name: "windows drive paths",
			in:   `missing C:\Users\dev\project\main.go`,
			want: "missing <path>",
		},
		{
			name: "single-segment slashes are prose, not paths",
			in:   "read/write ratio 5/10 exceeded",
			want: "read/write ratio <num>/<num> exceeded",
		},
		{
			name: "single-quoted strings",
			in:   "column 'user_id_42' does not exist",
			want: "column <str> does not exist",
		},
		{
			name: "double-quoted strings",
			in:   `unexpected token "}" at offset 91`,
			want: "unexpected token <str> at offset <num>",
		},
		{
			name: "backquoted strings",
			in:   "unknown table `events_2026`",
			want: "unknown table <str>",
		},
		{
			name: "a quoted path is one string, replaced once",
			in:   "open '/tmp/build/17/out.log' failed",
			want: "open <str> failed",
		},
		{
			name: "whitespace collapses and trims",
			in:   "  connection   reset\tby peer\n",
			want: "connection reset by peer",
		},
		{
			name: "a message with nothing variable is unchanged",
			in:   "context deadline exceeded",
			want: "context deadline exceeded",
		},
		{
			name: "empty stays empty",
			in:   "",
			want: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := NormalizeMessage(tc.in); got != tc.want {
				t.Errorf("NormalizeMessage(%q)\n got %q\nwant %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestNormalizeMessageGroupsVariants is the property the whole feature exists
// for: two runs of the same bug must produce the same template, and two
// different bugs must not.
func TestNormalizeMessageGroupsVariants(t *testing.T) {
	a := NormalizeMessage("timeout after 30000ms calling /v1/models/claude-opus (req 4f8a2b1c-9d3e-4a5b-8c7d-1e2f3a4b5c6d)")
	b := NormalizeMessage("timeout after 45000ms calling /v1/models/claude-opus (req 11112222-3333-4444-5555-666677778888)")
	if a != b {
		t.Fatalf("the same failure produced different templates:\n%q\n%q", a, b)
	}
	c := NormalizeMessage("connection refused calling /v1/models/claude-opus")
	if a == c {
		t.Fatal("different failures must not share a template")
	}
}

func TestTopFrame(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"first non-empty line", "\n\n  at foo.go:12\n  at bar.go:44\n", "at foo.go:12"},
		{"single line", "at main.go:1", "at main.go:1"},
		{"empty stack", "   \n\n", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := TopFrame(tc.in); got != tc.want {
				t.Errorf("TopFrame(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestNormalizeFrameStripsLineNumbers: a frame must keep identifying the same
// code after an edit shifts its line number.
func TestNormalizeFrameStripsLineNumbers(t *testing.T) {
	before := NormalizeFrame("  at internal/client/retry.go:118 +0x2f")
	after := NormalizeFrame("at internal/client/retry.go:204 +0x9c")
	if before != after {
		t.Fatalf("a moved frame changed identity:\n%q\n%q", before, after)
	}
}

// TestGroupHashDeterministic pins the hash contract: stable across calls,
// sensitive to each of the three inputs.
func TestGroupHashDeterministic(t *testing.T) {
	base := GroupHash("TimeoutError", "deadline exceeded", "client.go:<num>")
	if base != GroupHash("TimeoutError", "deadline exceeded", "client.go:<num>") {
		t.Fatal("group hash is not stable across calls")
	}
	if len(base) != 64 {
		t.Fatalf("group hash length = %d, want 64 hex chars", len(base))
	}
	variants := []struct{ typ, tmpl, frame string }{
		{"RateLimitError", "deadline exceeded", "client.go:<num>"},
		{"TimeoutError", "connection reset", "client.go:<num>"},
		{"TimeoutError", "deadline exceeded", "server.go:<num>"},
	}
	for _, v := range variants {
		if GroupHash(v.typ, v.tmpl, v.frame) == base {
			t.Errorf("hash collided for %+v", v)
		}
	}
	// The separator must not let one field bleed into the next.
	if GroupHash("a|b", "c", "d") == GroupHash("a", "b|c", "d") {
		t.Fatal("field boundaries are not encoded in the hash")
	}
}
