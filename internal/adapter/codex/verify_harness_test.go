// Package codex_test holds tests that exercise the codex adapter through
// packages that themselves depend on the adapter (the fixture-verification
// harness). They live in an external test package so importing those
// packages cannot create an import cycle with the package under test.
package codex_test

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/adapter/codex"
	"github.com/handoffgraph/handoffgraph/internal/verify"
)

// TestNormalizeStreamVerifyHarness runs the golden-fixture harness over
// testdata/fixtures with the codex adapter's NormalizeStream injected as
// the native normalizer, so every native codex rollout fixture in the repo
// is verified through the adapter (provider/provenance/stable-id checks)
// instead of being skipped or verified only through the per-line fallback.
// Only the deliberately truncated.jsonl fixture may fail.
func TestNormalizeStreamVerifyHarness(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed; cannot locate testdata/fixtures")
	}
	dir := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "testdata", "fixtures")
	if _, err := os.Stat(dir); err != nil {
		t.Skipf("fixtures unavailable: %v", err)
	}

	res, err := verify.Verify(context.Background(), dir, verify.VerifyOptions{
		NormalizeNative: (&codex.Codex{}).NormalizeStream,
	})
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	for _, failure := range res.Failures {
		if !strings.HasPrefix(failure, "truncated.jsonl:") {
			t.Errorf("unexpected fixture failure: %s", failure)
		}
	}
	if res.Events == 0 {
		t.Error("no events verified")
	}
}
