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

// Default returns the default configuration.
func Default() Config {
	home := UserDataDir()
	return Config{
		DataDir:         home,
		DBPath:          filepath.Join(home, "handoffgraph.db"),
		ObjectDir:       filepath.Join(home, "objects"),
		LogDir:          filepath.Join(home, "logs"),
		CacheDir:        filepath.Join(home, "cache"),
		CapturePolicy:   "full_local",
		RedactDenyPaths: defaultDenyPaths(),
	}
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
func Load(dir string) (*Config, error) {
	cfg := Default()

	userPath := filepath.Join(UserDataDir(), "config.toml")
	if _, err := os.Stat(userPath); err == nil {
		if err := loadFile(userPath, &cfg); err != nil {
			return nil, fmt.Errorf("load user config %s: %w", userPath, err)
		}
	}

	repoPath, err := FindRepoConfig(dir)
	if err != nil {
		return nil, err
	}
	if repoPath != "" {
		if err := loadFile(repoPath, &cfg); err != nil {
			return nil, fmt.Errorf("load repo config %s: %w", repoPath, err)
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
