package config

import (
	"os"

	"github.com/BurntSushi/toml"
)

// loadFile merges a TOML config file into cfg. Unknown keys are ignored so
// forward-compatible files do not break older binaries.
//
// It merges the file's keys and nothing more: use mergeFile for the scope
// semantics Load wants, where overriding data_dir also moves the store paths
// the file left implicit.
func loadFile(path string, cfg *Config) error {
	_, err := toml.DecodeFile(path, cfg)
	return err
}

// mergeFile merges one config scope into cfg. On top of loadFile it applies
// the rule that makes data_dir authoritative: if this scope set data_dir,
// every store path it did *not* pin explicitly is re-derived under the new
// directory. Pinning db_path/object_dir/log_dir/cache_dir in the same file
// still wins, so a deliberately split layout stays expressible.
func mergeFile(path string, cfg *Config) error {
	md, err := toml.DecodeFile(path, cfg)
	if err != nil {
		return err
	}
	if md.IsDefined("data_dir") {
		cfg.deriveFromDataDir(func(key string) bool { return md.IsDefined(key) })
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
