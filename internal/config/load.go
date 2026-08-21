package config

import (
	"os"

	"github.com/BurntSushi/toml"
)

// loadFile merges a TOML config file into cfg. Unknown keys are ignored so
// forward-compatible files do not break older binaries.
func loadFile(path string, cfg *Config) error {
	var raw map[string]any
	if _, err := toml.DecodeFile(path, &raw); err != nil {
		return err
	}
	if _, err := toml.DecodeFile(path, cfg); err != nil {
		return err
	}
	return nil
}

// writeFile writes cfg as TOML to path with restrictive permissions.
func writeFile(path string, cfg *Config) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	return toml.NewEncoder(f).Encode(cfg)
}

// ensure config imports os (used by writeFile) and toml.
var _ = os.Getenv
