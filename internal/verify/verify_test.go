package verify

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/fixture"
)

func TestGenerateSyntheticDeterministicCount(t *testing.T) {
	events := fixture.GenerateSynthetic(100)
	// 3 (workstream/session/trace) + 1 (agent span) + 2*100 (span start+command)
	// + 1 (failing test) = 205.
	if len(events) != 205 {
		t.Fatalf("len = %d, want 205", len(events))
	}
}

func TestVerifyFixtureDir(t *testing.T) {
	dir := t.TempDir()
	events := fixture.GenerateSynthetic(20)

	var out []byte
	for _, ev := range events {
		b, err := json.Marshal(ev)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, b...)
		out = append(out, '\n')
	}
	if err := os.WriteFile(filepath.Join(dir, "synthetic.jsonl"), out, 0o600); err != nil {
		t.Fatal(err)
	}

	res, err := Verify(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Failures) > 0 {
		t.Fatalf("failures: %v", res.Failures)
	}
	if res.Events == 0 {
		t.Fatal("expected events")
	}
}

func TestVerifyFixtureDirWithCorruptFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "corrupt.jsonl"), []byte("{not valid json"), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err := Verify(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Failures) == 0 {
		t.Fatal("expected failures for corrupt file")
	}
}

// TestVerifyRepoGoldenFixtures runs the fixture harness over every top-level
// *.jsonl in testdata/fixtures. The file set is globbed dynamically because
// fixtures are contributed by multiple lanes; each file must verify with zero
// failures unless listed in expectedFailures (name -> exact failure count).
// Contract: truncated.jsonl has one deliberately truncated final line and
// must fail with exactly one bad-line error; every other fixture must pass.
func TestVerifyRepoGoldenFixtures(t *testing.T) {
	dir := "../../testdata/fixtures"
	files, err := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Fatal("no golden fixtures found")
	}

	expectedFailures := map[string]int{
		"truncated.jsonl": 1, // deliberate: final line cut mid-JSON
	}

	res, err := Verify(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.FilesChecked != len(files) {
		t.Fatalf("FilesChecked = %d, want %d (globbed)", res.FilesChecked, len(files))
	}

	// Group failures per file: Verify prefixes failure messages with the
	// base file name ("<file>: <err>").
	got := map[string]int{}
	for _, f := range res.Failures {
		base := f
		if i := indexOf(f, ':'); i > 0 {
			base = f[:i]
		}
		got[base]++
	}
	for _, path := range files {
		base := filepath.Base(path)
		want := expectedFailures[base] // zero for unlisted files
		if got[base] != want {
			t.Errorf("%s: got %d failure(s), want %d (failures: %v)", base, got[base], want, res.Failures)
		}
	}
	if res.Events == 0 {
		t.Fatal("expected events across golden fixtures")
	}
}

func indexOf(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}
