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

// consumePositionals drains fs.Args() after the framework's initial parse.
// Go's flag package stops at the first positional argument, so commands
// that interleave positionals with flags (subcommands, file arguments)
// re-parse the remainder here: each pass takes one positional and re-parses
// the rest until nothing is left. Returns the positional arguments in
// order.
func consumePositionals(fs *flag.FlagSet) ([]string, error) {
	var positional []string
	for {
		rem := fs.Args()
		if len(rem) == 0 {
			return positional, nil
		}
		positional = append(positional, rem[0])
		if err := fs.Parse(rem[1:]); err != nil {
			// Unknown flags and malformed values are usage errors; surface
			// them to the command unchanged.
			return positional, err
		}
	}
}
