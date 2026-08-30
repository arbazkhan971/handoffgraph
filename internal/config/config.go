// Package config loads HandoffGraph configuration from user and repository
// scopes, with the repository scope taking precedence.
//
// The on-disk location follows the roadmap:
//
//	~/.handoffgraph/
//	  config.toml
//	  handoffgraph.db
//	  objects/
//	  logs/
//	  cache/
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// Config is the merged local configuration.
type Config struct {
	DataDir   string `toml:"data_dir"`
	DBPath    string `toml:"db_path"`
	ObjectDir string `toml:"object_dir"`
	LogDir    string `toml:"log_dir"`
	CacheDir  string `toml:"cache_dir"`

	// Redaction configuration (redaction v1).
	RedactDenyPaths []string `toml:"redact_deny_paths"`
	RedactPatterns  []string `toml:"redact_patterns"` // user regexes

	// Capture defaults. LocalFull is the default capture policy; cloud
	// defaults to metadata-only and is not enabled here.
	CapturePolicy string `toml:"capture_policy"`

	// Telemetry is opt-in and content-free.
	TelemetryEnabled bool `toml:"telemetry_enabled"`
}

// derivedPaths is the single table describing every store path that hangs
// off data_dir: its TOML key (so a scope can pin it explicitly), its
// basename inside the data directory, and the field it lands in. Default()
// and every config scope that overrides data_dir both derive through this
// table, so the two can never drift into describing separate locations.
var derivedPaths = []struct {
	Key      string
	Basename string
	Field    func(*Config) *string
}{
	{"db_path", "handoffgraph.db", func(c *Config) *string { return &c.DBPath }},
	{"object_dir", "objects", func(c *Config) *string { return &c.ObjectDir }},
	{"log_dir", "logs", func(c *Config) *string { return &c.LogDir }},
	{"cache_dir", "cache", func(c *Config) *string { return &c.CacheDir }},
}

// deriveFromDataDir re-points every store path at c.DataDir, skipping the
// ones pinned reports as explicitly set by the scope doing the deriving. A
// nil pinned derives all of them.
//
// This is what makes an overridden data_dir mean what it says. Without it a
// scope that set only data_dir moved the directory while db_path and
// friends kept pointing into the *previous* scope's tree, so one Config
// described two unrelated locations at once — the split that let
// `reset --hard` wipe a directory that did not hold the store it claimed to
// be clearing, and report success while the real event log survived.
func (c *Config) deriveFromDataDir(pinned func(key string) bool) {
	for _, d := range derivedPaths {
		if pinned != nil && pinned(d.Key) {
			continue
		}
		*d.Field(c) = filepath.Join(c.DataDir, d.Basename)
	}
}

// Default returns the default configuration.
func Default() Config {
	c := Config{
		DataDir:         UserDataDir(),
		CapturePolicy:   "full_local",
		RedactDenyPaths: defaultDenyPaths(),
	}
	c.deriveFromDataDir(nil)
	return c
}

// UserDataDir returns the platform default data directory (~/.handoffgraph),
// overridable via the HFG_DATA_DIR environment variable (used by CI/tests).
func UserDataDir() string {
	if v := os.Getenv("HFG_DATA_DIR"); v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".handoffgraph")
}

// RepoConfigName is the repository-scoped config filename.
const RepoConfigName = ".handoffgraph.toml"

// Load merges the default config with the user config and any repository
// config found by walking up from dir. Repository scope wins over user scope,
// which wins over defaults. Missing files are not errors.
//
// A scope that overrides data_dir also re-derives the store paths it left
// implicit (see deriveFromDataDir), so the returned Config always describes
// one location rather than a directory from one scope and a database from
// another.
func Load(dir string) (*Config, error) {
	cfg := Default()

	userPath := filepath.Join(UserDataDir(), "config.toml")
	if _, err := os.Stat(userPath); err == nil {
		if err := mergeFile(userPath, &cfg); err != nil {
			return nil, fmt.Errorf("load user config %s: %w", userPath, err)
		}
	}

	repoPath, err := FindRepoConfig(dir)
	if err != nil {
		return nil, err
	}
	if repoPath != "" {
		if err := mergeFile(repoPath, &cfg); err != nil {
			return nil, fmt.Errorf("load repo config %s: %w", repoPath, err)
		}
	}

	if err := cfg.EnsureDirs(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// LoadUser loads only defaults and the user-scoped configuration. It is the
// safe loader for globally installed provider hooks: their current working
// directory is controlled by whichever repository the provider is running
// in, so consulting repository configuration there would let an untrusted
// checkout redirect captured prompt and tool payloads to an attacker-chosen
// database path.
func LoadUser() (*Config, error) {
	cfg := Default()
	userPath := filepath.Join(UserDataDir(), "config.toml")
	if _, err := os.Stat(userPath); err == nil {
		if err := mergeFile(userPath, &cfg); err != nil {
			return nil, fmt.Errorf("load user config %s: %w", userPath, err)
		}
	}
	if err := cfg.EnsureDirs(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// FindRepoConfig walks up from dir looking for .handoffgraph.toml.
// It returns "" if none is found.
func FindRepoConfig(dir string) (string, error) {
	if dir == "" {
		dir = "."
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	for {
		candidate := filepath.Join(abs, RepoConfigName)
		if st, err := os.Stat(candidate); err == nil && !st.IsDir() {
			return candidate, nil
		}
		parent := filepath.Dir(abs)
		if parent == abs {
			return "", nil
		}
		abs = parent
	}
}

// EnsureDirs creates the data directories with restrictive permissions.
func (c *Config) EnsureDirs() error {
	for _, d := range []string{c.DataDir, c.ObjectDir, c.LogDir, c.CacheDir} {
		if d == "" {
			continue
		}
		if err := os.MkdirAll(d, 0o700); err != nil {
			return fmt.Errorf("mkdir %s: %w", d, err)
		}
	}
	return nil
}

// DataDirs returns the configured data directory paths for doctor output.
func (c *Config) DataDirs() map[string]string {
	return map[string]string{
		"data_dir":   c.DataDir,
		"db_path":    c.DBPath,
		"object_dir": c.ObjectDir,
		"log_dir":    c.LogDir,
		"cache_dir":  c.CacheDir,
	}
}

func defaultDenyPaths() []string {
	return []string{
		".env", ".env.local", ".env.*", ".envrc", ".npmrc", ".pypirc",
		"credentials", "credentials.json", "service-account.json",
		"*.pem", "*.key", "*.p12", "*.pfx", "id_rsa", "id_ed25519",
		"*.pem", "secrets.yaml", "secrets.yml", ".secrets",
		".netrc", ".git-credentials", ".aws/credentials",
		"keychain", "*.keystore", "*.jks",
	}
}

// IsWindows reports whether the host is Windows (for path fixtures).
func IsWindows() bool { return runtime.GOOS == "windows" }

// Validate checks the configuration for obvious problems.
func (c *Config) Validate() error {
	if c.DataDir == "" {
		return errors.New("data_dir must not be empty")
	}
	switch c.CapturePolicy {
	case "metadata_only", "full_local", "sanitized", "encrypted":
	default:
		return fmt.Errorf("unknown capture_policy %q", c.CapturePolicy)
	}
	return nil
}
