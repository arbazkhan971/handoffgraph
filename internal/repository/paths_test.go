package repository

import (
	"strings"
	"testing"
)

// TestNormalizePath exercises both OS branches of the pure path normalizer on
// any host OS (both branches use POSIX path.Clean semantics internally, so
// results are deterministic everywhere). These are the "Windows and Unix path
// fixtures" required by the v0.1.0 roadmap gate.
func TestNormalizePath(t *testing.T) {
	tests := []struct {
		name string
		in   string
		win  bool
		want string
	}{
		// --- Windows branch ---
		{"win backslash separators", `C:\Users\arbaz\proj`, true, "C:/Users/arbaz/proj"},
		{"win drive letter upper-cased", `c:\users\arbaz\proj`, true, "C:/users/arbaz/proj"},
		{"win already-forward-slash", "C:/Users/arbaz/proj", true, "C:/Users/arbaz/proj"},
		{"win mixed separators", `C:/Users\arbaz/../arbaz\proj`, true, "C:/Users/arbaz/proj"},
		{"win dot segments", `C:\.\proj\sub\..\sub`, true, "C:/proj/sub"},
		{"win root", `C:\`, true, "C:"},
		{"win relative backslash", `foo\bar\..\baz`, true, "foo/baz"},
		{"win relative forward", "foo/bar", true, "foo/bar"},
		{"win UNC", `\\server\share\repo`, true, "//server/share/repo"},
		{"win UNC forward slashes", "//server/share/repo", true, "//server/share/repo"},
		{"win UNC mixed separators", `\\Server/Share\repo`, true, "//Server/Share/repo"},
		{"win UNC bare share", `\\server\share`, true, "//server/share"},
		{"win trims spaces", `  C:\proj  `, true, "C:/proj"},
		{"win empty", "", true, ""},

		// --- Unix branch ---
		{"unix absolute", "/home/arbaz/proj", false, "/home/arbaz/proj"},
		{"unix trailing slash", "/home/arbaz/proj/", false, "/home/arbaz/proj"},
		{"unix dot segments", "./proj/../proj/./sub", false, "proj/sub"},
		{"unix parent refs", "/a/b/../c", false, "/a/c"},
		{"unix backslash is literal", `weird\name`, false, `weird\name`},
		{"unix drive-letter-looking name", "C:notaseparator", false, "C:notaseparator"},
		{"unix relative", "src/pkg", false, "src/pkg"},
		{"unix trims spaces", "  /tmp/x  ", false, "/tmp/x"},
		{"unix empty", "", false, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizePath(tt.in, tt.win); got != tt.want {
				t.Errorf("normalizePath(%q, %v) = %q, want %q", tt.in, tt.win, got, tt.want)
			}
		})
	}
}

func TestNormalizeRemote(t *testing.T) {
	tests := []struct{ name, in, want string }{
		{"scp-like", "git@github.com:org/repo.git", "github.com/org/repo"},
		{"scp-like no user", "github.com:org/repo.git", "github.com/org/repo"},
		{"https", "https://github.com/org/repo.git", "github.com/org/repo"},
		{"https with user", "https://user@github.com/org/repo", "github.com/org/repo"},
		{"ssh with port", "ssh://git@host:2222/org/repo.git", "host:2222/org/repo"},
		{"no suffix", "https://github.com/org/repo", "github.com/org/repo"},
		{"local path untouched", "/srv/git/repo", "/srv/git/repo"},
		{"windows drive remote kept intact", `C:\repos\hfg`, `C:\repos\hfg`},
		{"trims whitespace", "  git@github.com:org/repo  ", "github.com/org/repo"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeRemote(tt.in); got != tt.want {
				t.Errorf("normalizeRemote(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestNormalizePathMatchesDetectFallbackPrefix(t *testing.T) {
	got := normalizePath("/tmp/demo/../demo", false)
	if !strings.HasPrefix(got, "/") || strings.Contains(got, "..") {
		t.Errorf("fallback form %q not canonical", got)
	}
}
