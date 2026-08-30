package adapter

import (
	"strings"
	"testing"
)

func TestDefaultHookCommandQuotesExecutableAsOneShellWord(t *testing.T) {
	tests := []struct {
		executable string
		provider   string
		want       string
	}{
		{"/usr/local/bin/handoffgraph", "codex", "/usr/local/bin/handoffgraph hook codex"},
		{"/tmp/Handoff Graph/bin/handoffgraph", "claude", "'/tmp/Handoff Graph/bin/handoffgraph' hook claude"},
		{"/tmp/hfg'; touch /tmp/pwned; 'x", "codex", "'/tmp/hfg'\"'\"'; touch /tmp/pwned; '\"'\"'x' hook codex"},
	}
	for _, tc := range tests {
		got, err := HookCommandForOS(tc.executable, tc.provider, "linux")
		if err != nil {
			t.Fatalf("HookCommandForOS(%q, %q): %v", tc.executable, tc.provider, err)
		}
		if got != tc.want {
			t.Errorf("DefaultHookCommand(%q, %q) = %q, want %q", tc.executable, tc.provider, got, tc.want)
		}
	}
}

func TestHookCommandForWindowsUsesCmdQuotingAndFailsClosed(t *testing.T) {
	got, err := HookCommandForOS(`C:\Program Files\HandoffGraph\handoffgraph.exe`, "codex", "windows")
	if err != nil {
		t.Fatal(err)
	}
	if want := `"C:\Program Files\HandoffGraph\handoffgraph.exe" hook codex`; got != want {
		t.Fatalf("windows command = %q, want %q", got, want)
	}

	for _, executable := range []string{
		`C:\unsafe\%PATH%\handoffgraph.exe`,
		`C:\unsafe\!PATH!\handoffgraph.exe`,
		"C:\\unsafe\\line\nbreak.exe",
	} {
		if _, err := HookCommandForOS(executable, "claude", "windows"); err == nil || !strings.Contains(err.Error(), "cannot be represented safely") {
			t.Errorf("unsafe Windows executable %q error = %v", executable, err)
		}
	}
	if _, err := HookCommandForOS(`/bin/handoffgraph`, `codex & calc`, "linux"); err == nil {
		t.Fatal("unsafe provider name succeeded")
	}
}
