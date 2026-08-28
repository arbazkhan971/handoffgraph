package commands

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/config"
	"github.com/handoffgraph/handoffgraph/internal/storage"
)

// findDoctorCheck returns the named check from a doctorReport, or nil.
func findDoctorCheck(t *testing.T, out, name string) *Check {
	t.Helper()
	var report doctorReport
	if err := json.Unmarshal([]byte(out), &report); err != nil {
		t.Fatalf("decode doctor --json output: %v\n%s", err, out)
	}
	for i := range report.Checks {
		if report.Checks[i].Name == name {
			return &report.Checks[i]
		}
	}
	return nil
}

func TestDoctorBasicPassesOnFreshDir(t *testing.T) {
	isolateDataDir(t)
	app := newRegisteredApp(t)

	out, _, err := runRegisteredApp(app, "doctor")
	if err != nil {
		t.Fatalf("doctor: %v\n%s", err, out)
	}
	if !strings.Contains(out, "status: OK") {
		t.Fatalf("doctor output missing status: OK:\n%s", out)
	}
	if !strings.Contains(out, "db_opens") {
		t.Fatalf("doctor output missing basic checks:\n%s", out)
	}
	// The plain (non --verify) form must not run the deep checks.
	if strings.Contains(out, "schema_at_expected_version") {
		t.Fatalf("doctor without --verify ran a deep check:\n%s", out)
	}
}

func TestDoctorVerifyFailsUntilObservationsRebuilt(t *testing.T) {
	isolateDataDir(t)
	app := newRegisteredApp(t)

	out, _, err := runRegisteredApp(app, "doctor", "--verify", "--json")
	if err == nil {
		t.Fatalf("doctor --verify on a never-indexed store: want a non-zero exit, got none\n%s", out)
	}
	ck := findDoctorCheck(t, out, "observations_fresh")
	if ck == nil {
		t.Fatalf("observations_fresh check missing:\n%s", out)
	}
	if ck.Passed {
		t.Fatalf("observations_fresh expected to fail before any rebuild: %+v", *ck)
	}

	// index rebuild materializes the read model; doctor --verify must go
	// green afterward with no other state change.
	if _, _, err := runRegisteredApp(app, "index", "rebuild"); err != nil {
		t.Fatalf("index rebuild: %v", err)
	}
	out2, _, err := runRegisteredApp(app, "doctor", "--verify", "--json")
	if err != nil {
		t.Fatalf("doctor --verify after rebuild: %v\n%s", err, out2)
	}
	var report doctorReport
	if jerr := json.Unmarshal([]byte(out2), &report); jerr != nil {
		t.Fatalf("decode: %v\n%s", jerr, out2)
	}
	if !report.Passed {
		t.Fatalf("doctor --verify expected to pass after rebuild: %+v", report)
	}
	if !report.Deep {
		t.Fatalf("report.Deep = false, want true for --verify")
	}
}

func TestDoctorVerifySchemaAtExpectedVersion(t *testing.T) {
	isolateDataDir(t)
	app := newRegisteredApp(t)

	out, _, _ := runRegisteredApp(app, "doctor", "--verify", "--json")
	ck := findDoctorCheck(t, out, "schema_at_expected_version")
	if ck == nil {
		t.Fatalf("schema_at_expected_version check missing:\n%s", out)
	}
	if !ck.Passed {
		t.Fatalf("a freshly opened, freshly migrated store must be at the expected schema version: %+v", *ck)
	}
	want := storage.LatestSchemaVersion()
	if want == 0 {
		t.Fatal("storage.LatestSchemaVersion() returned 0, want the real latest migration version")
	}
}

func TestDoctorVerifyRedactionPatternCompileFailure(t *testing.T) {
	isolateDataDir(t)
	dataDir := config.UserDataDir()
	// An invalid regex in the user config makes the redaction engine fail
	// to construct; doctor --verify must surface that as a failing check
	// rather than crashing or silently passing.
	cfgToml := "redact_patterns = [\"[\"]\n"
	if err := os.WriteFile(filepath.Join(dataDir, "config.toml"), []byte(cfgToml), 0o600); err != nil {
		t.Fatal(err)
	}
	app := newRegisteredApp(t)

	out, _, err := runRegisteredApp(app, "doctor", "--verify", "--json")
	if err == nil {
		t.Fatalf("doctor --verify with an invalid redaction pattern: want a non-zero exit\n%s", out)
	}
	ck := findDoctorCheck(t, out, "redaction_patterns_compile")
	if ck == nil {
		t.Fatalf("redaction_patterns_compile check missing:\n%s", out)
	}
	if ck.Passed {
		t.Fatalf("redaction_patterns_compile expected to fail on an invalid regex: %+v", *ck)
	}
}

func TestDoctorVerifyDataDirDiskUsageReported(t *testing.T) {
	isolateDataDir(t)
	app := newRegisteredApp(t)

	out, _, err := runRegisteredApp(app, "doctor", "--verify", "--json")
	_ = err // may be non-nil (observations not yet built); disk usage is independent
	ck := findDoctorCheck(t, out, "data_dir_disk_usage")
	if ck == nil {
		t.Fatalf("data_dir_disk_usage check missing:\n%s", out)
	}
	if !ck.Passed {
		t.Fatalf("data_dir_disk_usage expected to succeed on a readable temp dir: %+v", *ck)
	}
	if ck.Detail == "" {
		t.Fatal("data_dir_disk_usage detail is empty")
	}
}
