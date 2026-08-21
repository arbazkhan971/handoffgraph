package config

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestUserDataDirEnvOverride(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HFG_DATA_DIR", dir)
	if got := UserDataDir(); got != dir {
		t.Fatalf("UserDataDir() = %q, want %q", got, dir)
	}
}

func TestUserDataDirDefault(t *testing.T) {
	t.Setenv("HFG_DATA_DIR", "")
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("no home dir: %v", err)
	}
	want := filepath.Join(home, ".handoffgraph")
	if got := UserDataDir(); got != want {
		t.Fatalf("UserDataDir() = %q, want %q", got, want)
	}
}

func TestDefaultDerivesFromDataDir(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HFG_DATA_DIR", dir)

	cfg := Default()
	if cfg.DataDir != dir {
		t.Errorf("DataDir = %q, want %q", cfg.DataDir, dir)
	}
	want := map[string]string{
		"DBPath":    filepath.Join(dir, "handoffgraph.db"),
		"ObjectDir": filepath.Join(dir, "objects"),
		"LogDir":    filepath.Join(dir, "logs"),
		"CacheDir":  filepath.Join(dir, "cache"),
	}
	for field, exp := range want {
		if got := map[string]string{
			"DBPath":    cfg.DBPath,
			"ObjectDir": cfg.ObjectDir,
			"LogDir":    cfg.LogDir,
			"CacheDir":  cfg.CacheDir,
		}[field]; got != exp {
			t.Errorf("%s = %q, want %q", field, got, exp)
		}
	}
	if cfg.CapturePolicy != "full_local" {
		t.Errorf("CapturePolicy = %q, want full_local", cfg.CapturePolicy)
	}
	if len(cfg.RedactDenyPaths) == 0 {
		t.Error("RedactDenyPaths must default to non-empty deny list")
	}
}

func TestDefaultDenyPathsContainsCoreEntries(t *testing.T) {
	deny := defaultDenyPaths()
	want := []string{".env", ".env.*", "*.pem", "*.key", ".aws/credentials"}
	for _, w := range want {
		found := false
		for _, d := range deny {
			if d == w {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("defaultDenyPaths() missing %q", w)
		}
	}
}

func TestLoadDefaultsWhenNoConfigFiles(t *testing.T) {
	dataDir := t.TempDir()
	repo := t.TempDir()
	t.Setenv("HFG_DATA_DIR", dataDir)

	cfg, err := Load(repo)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	def := Default()
	if cfg.CapturePolicy != def.CapturePolicy {
		t.Errorf("CapturePolicy = %q, want default %q", cfg.CapturePolicy, def.CapturePolicy)
	}
	if cfg.DataDir != dataDir {
		t.Errorf("DataDir = %q, want %q", cfg.DataDir, dataDir)
	}
	// Load must ensure directories exist.
	for _, d := range []string{cfg.ObjectDir, cfg.LogDir, cfg.CacheDir} {
		st, err := os.Stat(d)
		if err != nil || !st.IsDir() {
			t.Errorf("Load did not create dir %s (err=%v)", d, err)
		}
	}
}

func TestLoadUserConfigOverridesDefaults(t *testing.T) {
	dataDir := t.TempDir()
	repo := t.TempDir()
	t.Setenv("HFG_DATA_DIR", dataDir)

	userCfg := `capture_policy = "sanitized"
telemetry_enabled = true
`
	if err := os.WriteFile(filepath.Join(dataDir, "config.toml"), []byte(userCfg), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(repo)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.CapturePolicy != "sanitized" {
		t.Errorf("CapturePolicy = %q, want sanitized", cfg.CapturePolicy)
	}
	if !cfg.TelemetryEnabled {
		t.Error("TelemetryEnabled = false, want true")
	}
	// Untouched fields keep defaults.
	if cfg.DataDir != dataDir {
		t.Errorf("DataDir = %q, want %q", cfg.DataDir, dataDir)
	}
}

func TestLoadRepoConfigOverridesUserConfig(t *testing.T) {
	dataDir := t.TempDir()
	repo := t.TempDir()
	t.Setenv("HFG_DATA_DIR", dataDir)

	userCfg := `capture_policy = "sanitized"
redact_patterns = ["user"]
`
	if err := os.WriteFile(filepath.Join(dataDir, "config.toml"), []byte(userCfg), 0o600); err != nil {
		t.Fatal(err)
	}
	repoCfg := `capture_policy = "metadata_only"
redact_patterns = ["repo"]
`
	if err := os.WriteFile(filepath.Join(repo, RepoConfigName), []byte(repoCfg), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(repo)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.CapturePolicy != "metadata_only" {
		t.Errorf("CapturePolicy = %q, want metadata_only (repo scope must win)", cfg.CapturePolicy)
	}
	if len(cfg.RedactPatterns) != 1 || cfg.RedactPatterns[0] != "repo" {
		t.Errorf("RedactPatterns = %v, want [repo]", cfg.RedactPatterns)
	}
}

func TestLoadFindsRepoConfigWalkingUp(t *testing.T) {
	dataDir := t.TempDir()
	root := t.TempDir()
	t.Setenv("HFG_DATA_DIR", dataDir)

	if err := os.WriteFile(filepath.Join(root, RepoConfigName), []byte("capture_policy = \"encrypted\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(root, "a", "b", "c")
	if err := os.MkdirAll(nested, 0o700); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(nested)
	if err != nil {
		t.Fatalf("Load(%q) error = %v", nested, err)
	}
	if cfg.CapturePolicy != "encrypted" {
		t.Errorf("CapturePolicy = %q, want encrypted", cfg.CapturePolicy)
	}
}

func TestFindRepoConfig(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "x", "y")
	if err := os.MkdirAll(nested, 0o700); err != nil {
		t.Fatal(err)
	}

	got, err := FindRepoConfig(nested)
	if err != nil {
		t.Fatalf("FindRepoConfig() error = %v", err)
	}
	if got != "" {
		t.Fatalf("FindRepoConfig() = %q, want \"\" before file exists", got)
	}

	want := filepath.Join(root, RepoConfigName)
	if err := os.WriteFile(want, []byte("\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err = FindRepoConfig(nested)
	if err != nil {
		t.Fatalf("FindRepoConfig() error = %v", err)
	}
	if got != want {
		t.Fatalf("FindRepoConfig() = %q, want %q", got, want)
	}

	// A directory named like the config file must be skipped.
	if err := os.Remove(want); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(want, 0o700); err != nil {
		t.Fatal(err)
	}
	got, err = FindRepoConfig(nested)
	if err != nil {
		t.Fatalf("FindRepoConfig() error = %v", err)
	}
	if got != "" {
		t.Fatalf("FindRepoConfig() = %q, want \"\" when only a directory matches", got)
	}
}

func TestLoadMalformedTOMLIsError(t *testing.T) {
	dataDir := t.TempDir()
	repo := t.TempDir()
	t.Setenv("HFG_DATA_DIR", dataDir)

	bad := "this is not [ valid toml ==="
	if err := os.WriteFile(filepath.Join(dataDir, "config.toml"), []byte(bad), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(repo); err == nil {
		t.Fatal("Load() with malformed user TOML: want error, got nil")
	}

	if err := os.WriteFile(filepath.Join(repo, RepoConfigName), []byte(bad), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dataDir, "config.toml")); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(repo); err == nil {
		t.Fatal("Load() with malformed repo TOML: want error, got nil")
	}
}

func TestLoadIgnoresUnknownKeys(t *testing.T) {
	dataDir := t.TempDir()
	repo := t.TempDir()
	t.Setenv("HFG_DATA_DIR", dataDir)

	cfgText := "future_key = \"value\"\ncapture_policy = \"full_local\"\n"
	if err := os.WriteFile(filepath.Join(dataDir, "config.toml"), []byte(cfgText), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(repo); err != nil {
		t.Fatalf("Load() with unknown keys error = %v, want nil", err)
	}
}

func TestEnsureDirs(t *testing.T) {
	base := t.TempDir()
	cfg := &Config{
		DataDir:   filepath.Join(base, "data"),
		ObjectDir: filepath.Join(base, "objects"),
		LogDir:    filepath.Join(base, "logs"),
		CacheDir:  filepath.Join(base, "cache"),
	}
	if err := cfg.EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs() error = %v", err)
	}
	for _, d := range []string{cfg.DataDir, cfg.ObjectDir, cfg.LogDir, cfg.CacheDir} {
		st, err := os.Stat(d)
		if err != nil || !st.IsDir() {
			t.Errorf("dir %s not created (err=%v)", d, err)
			continue
		}
		if runtime.GOOS != "windows" {
			if perm := st.Mode().Perm(); perm != 0o700 {
				t.Errorf("dir %s perm = %o, want 700", d, perm)
			}
		}
	}

	// Empty entries are skipped, not errors.
	empty := &Config{}
	if err := empty.EnsureDirs(); err != nil {
		t.Errorf("EnsureDirs() on empty config error = %v, want nil", err)
	}
}

func TestDataDirs(t *testing.T) {
	cfg := Default()
	dirs := cfg.DataDirs()
	want := map[string]string{
		"data_dir":   cfg.DataDir,
		"db_path":    cfg.DBPath,
		"object_dir": cfg.ObjectDir,
		"log_dir":    cfg.LogDir,
		"cache_dir":  cfg.CacheDir,
	}
	for k, v := range want {
		if dirs[k] != v {
			t.Errorf("DataDirs()[%q] = %q, want %q", k, dirs[k], v)
		}
	}
}

func TestValidate(t *testing.T) {
	valid := Default()
	if err := valid.Validate(); err != nil {
		t.Errorf("Validate() on defaults error = %v, want nil", err)
	}

	for _, policy := range []string{"metadata_only", "full_local", "sanitized", "encrypted"} {
		c := Default()
		c.CapturePolicy = policy
		if err := c.Validate(); err != nil {
			t.Errorf("Validate() with capture_policy %q error = %v", policy, err)
		}
	}

	noDir := Default()
	noDir.DataDir = ""
	if err := noDir.Validate(); err == nil {
		t.Error("Validate() with empty DataDir: want error, got nil")
	}

	bad := Default()
	bad.CapturePolicy = "yolo"
	if err := bad.Validate(); err == nil {
		t.Error("Validate() with unknown capture_policy: want error, got nil")
	}
}

func TestWriteFileRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	in := Default()
	in.CapturePolicy = "sanitized"
	in.TelemetryEnabled = true

	if err := writeFile(path, &in); err != nil {
		t.Fatalf("writeFile() error = %v", err)
	}

	var out Config
	if err := loadFile(path, &out); err != nil {
		t.Fatalf("loadFile() error = %v", err)
	}
	if out.CapturePolicy != in.CapturePolicy {
		t.Errorf("round-trip CapturePolicy = %q, want %q", out.CapturePolicy, in.CapturePolicy)
	}
	if out.TelemetryEnabled != in.TelemetryEnabled {
		t.Errorf("round-trip TelemetryEnabled = %v, want %v", out.TelemetryEnabled, in.TelemetryEnabled)
	}

	if runtime.GOOS != "windows" {
		st, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if perm := st.Mode().Perm(); perm != 0o600 {
			t.Errorf("written config perm = %o, want 600", perm)
		}
	}
}

func TestIsWindowsMatchesRuntime(t *testing.T) {
	if got, want := IsWindows(), runtime.GOOS == "windows"; got != want {
		t.Fatalf("IsWindows() = %v, want %v", got, want)
	}
}
