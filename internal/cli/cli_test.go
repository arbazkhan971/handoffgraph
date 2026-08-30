package cli

import (
	"bytes"
	"context"
	"flag"
	"strings"
	"testing"
)

func TestCommandHelpPrintsUsageAndFlagsWithoutRunning(t *testing.T) {
	app := NewApp("hfg", "test")
	ran := false
	app.Register(&Command{
		Name:    "sample",
		Summary: "Sample command",
		Usage:   "[--value <text>]",
		Flags: func(fs *flag.FlagSet) {
			fs.String("value", "default", "sample value")
		},
		Run: func(context.Context, *Context, *flag.FlagSet) error {
			ran = true
			return nil
		},
	})
	var stdout, stderr bytes.Buffer
	ctx := &Context{Stdout: &stdout, Stderr: &stderr, Stdin: strings.NewReader("")}

	if err := app.Run(context.Background(), ctx, "sample", []string{"--help"}); err != nil {
		t.Fatalf("help returned error: %v", err)
	}
	if ran {
		t.Fatal("help executed command")
	}
	if !strings.Contains(stdout.String(), "Usage: hfg sample") || !strings.Contains(stdout.String(), "-value string") {
		t.Fatalf("help output missing usage/defaults: %q", stdout.String())
	}
	if stderr.Len() != 0 {
		t.Fatalf("help wrote stderr: %q", stderr.String())
	}
}

func TestUnknownFlagStillFails(t *testing.T) {
	app := NewApp("hfg", "test")
	app.Register(&Command{Name: "sample", Run: func(context.Context, *Context, *flag.FlagSet) error { return nil }})
	var stdout, stderr bytes.Buffer
	ctx := &Context{Stdout: &stdout, Stderr: &stderr}
	if err := app.Run(context.Background(), ctx, "sample", []string{"--nope"}); err == nil {
		t.Fatal("unknown flag succeeded")
	}
}
