package commands

import (
	"flag"
	"fmt"
	"strings"
)

// shellQuote renders one argv element for COPY-PASTE display: it is
// single-quoted whenever it contains anything a shell would interpret, so a
// crafted value (backticks, $(...), ;, spaces) can never execute when the
// printed line is pasted. Display only — never used for execution.
func shellQuote(arg string) string {
	if arg == "" {
		return "''"
	}
	if strings.ContainsAny(arg, " \t\n'\"`$;&|<>\\*?[](){}#!~") {
		// A single quote cannot be backslash-escaped while a POSIX shell is
		// inside single quotes. Close the quote, emit an escaped quote, then
		// reopen it: a'b becomes 'a'\''b'. This keeps copy-pasted launch
		// commands inert even when checkpoint-controlled text contains a
		// quote followed by shell metacharacters.
		return "'" + strings.ReplaceAll(arg, "'", "'\\''") + "'"
	}
	return arg
}

// FormatExecSpec renders an ExecSpec as a safely quotable display line.
func FormatExecSpec(command string, args []string) string {
	parts := append([]string{command}, args...)
	for i, p := range parts {
		parts[i] = shellQuote(p)
	}
	return strings.Join(parts, " ")
}

var _ = fmt.Sprintf

// boolFlag returns the value of boolean flag name, or false when the flag is
// absent or its value is not a bool.
func boolFlag(fs *flag.FlagSet, name string) bool {
	f := fs.Lookup(name)
	if f == nil {
		return false
	}
	g, ok := f.Value.(flag.Getter)
	if !ok {
		return false
	}
	v, ok := g.Get().(bool)
	return ok && v
}

// stringFlag returns the value of string flag name, or "" when the flag is
// absent or its value is not a string.
func stringFlag(fs *flag.FlagSet, name string) string {
	f := fs.Lookup(name)
	if f == nil {
		return ""
	}
	g, ok := f.Value.(flag.Getter)
	if !ok {
		return ""
	}
	v, _ := g.Get().(string)
	return v
}
