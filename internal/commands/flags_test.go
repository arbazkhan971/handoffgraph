package commands

import (
	"flag"
	"testing"
)

// plainValue is a flag.Value that deliberately does not implement flag.Getter.
type plainValue struct{}

func (plainValue) String() string   { return "" }
func (plainValue) Set(string) error { return nil }

func newTestFS(t *testing.T, args ...string) *flag.FlagSet {
	t.Helper()
	fs := flag.NewFlagSet("test", flag.ContinueOnError)
	fs.Bool("bool", false, "")
	fs.String("string", "", "")
	fs.Var(plainValue{}, "plain", "")
	if err := fs.Parse(args); err != nil {
		t.Fatalf("parse %v: %v", args, err)
	}
	return fs
}

func TestBoolFlagPresentTrue(t *testing.T) {
	if !boolFlag(newTestFS(t, "-bool"), "bool") {
		t.Error(`boolFlag(fs, "bool") = false after -bool, want true`)
	}
}

func TestBoolFlagPresentFalse(t *testing.T) {
	if boolFlag(newTestFS(t), "bool") {
		t.Error(`boolFlag(fs, "bool") = true at default, want false`)
	}
}

func TestBoolFlagAbsent(t *testing.T) {
	if boolFlag(newTestFS(t), "missing") {
		t.Error(`boolFlag(fs, "missing") = true, want false`)
	}
}

func TestBoolFlagWrongType(t *testing.T) {
	if boolFlag(newTestFS(t, "-string=x"), "string") {
		t.Error(`boolFlag on string flag = true, want false`)
	}
}

func TestBoolFlagNonGetter(t *testing.T) {
	if boolFlag(newTestFS(t, "-plain=x"), "plain") {
		t.Error(`boolFlag on non-Getter flag = true, want false`)
	}
}

func TestStringFlagPresent(t *testing.T) {
	got := stringFlag(newTestFS(t, "-string", "abc"), "string")
	if got != "abc" {
		t.Errorf(`stringFlag(fs, "string") = %q, want "abc"`, got)
	}
}

func TestStringFlagDefault(t *testing.T) {
	if got := stringFlag(newTestFS(t), "string"); got != "" {
		t.Errorf(`stringFlag(fs, "string") = %q at default, want ""`, got)
	}
}

func TestStringFlagAbsent(t *testing.T) {
	if got := stringFlag(newTestFS(t), "missing"); got != "" {
		t.Errorf(`stringFlag(fs, "missing") = %q, want ""`, got)
	}
}

func TestStringFlagWrongType(t *testing.T) {
	if got := stringFlag(newTestFS(t, "-bool"), "bool"); got != "" {
		t.Errorf(`stringFlag on bool flag = %q, want ""`, got)
	}
}

func TestStringFlagNonGetter(t *testing.T) {
	if got := stringFlag(newTestFS(t, "-plain=x"), "plain"); got != "" {
		t.Errorf(`stringFlag on non-Getter flag = %q, want ""`, got)
	}
}

func TestShellQuoteSingleQuoteCannotBreakOut(t *testing.T) {
	input := "objective'; touch /tmp/handoffgraph-should-not-exist; #"
	want := "'objective'\\''; touch /tmp/handoffgraph-should-not-exist; #'"
	if got := shellQuote(input); got != want {
		t.Fatalf("shellQuote = %q, want %q", got, want)
	}
}

func TestFormatExecSpecQuotesCheckpointControlledPrompt(t *testing.T) {
	prompt := "Continue checkpoint cp_x. Objective: $(touch /tmp/nope) and 'quoted'"
	got := FormatExecSpec("claude", []string{prompt})
	want := "claude 'Continue checkpoint cp_x. Objective: $(touch /tmp/nope) and '\\''quoted'\\'''"
	if got != want {
		t.Fatalf("FormatExecSpec = %q, want %q", got, want)
	}
}
