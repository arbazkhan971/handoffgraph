package adapter

import (
	"fmt"
	"runtime"
	"strings"
)

// DefaultHookCommand returns the shell command installed for a provider's
// stdin hook. Provider hook commands are interpreted by the host shell, so
// executable paths must be quoted for the current OS rather than copied into
// a command string verbatim.
func DefaultHookCommand(executable, provider string) (string, error) {
	return HookCommandForOS(executable, provider, runtime.GOOS)
}

// HookCommandForOS is the testable implementation of DefaultHookCommand.
// Windows providers execute hook strings through cmd.exe; POSIX providers use
// a POSIX shell. Values that cmd.exe can expand even inside double quotes are
// rejected instead of installing a command that could run a different path.
func HookCommandForOS(executable, provider, goos string) (string, error) {
	if executable == "" {
		executable = "handoffgraph"
	}
	if provider == "" || strings.IndexFunc(provider, func(r rune) bool {
		return !((r >= 'a' && r <= 'z') ||
			(r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') ||
			strings.ContainsRune("_-", r))
	}) != -1 {
		return "", fmt.Errorf("hook command: unsafe provider name %q", provider)
	}
	if goos == "windows" {
		if strings.ContainsAny(executable, "\x00\r\n\"%!") {
			return "", fmt.Errorf("hook command: executable path %q cannot be represented safely for cmd.exe", executable)
		}
		return `"` + executable + `" hook ` + provider, nil
	}
	return shellWord(executable) + " hook " + shellWord(provider), nil
}

func shellWord(value string) string {
	if value != "" && strings.IndexFunc(value, func(r rune) bool {
		return !((r >= 'a' && r <= 'z') ||
			(r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') ||
			strings.ContainsRune("_@%+=:,./-", r))
	}) == -1 {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}
