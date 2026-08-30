package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
)

const (
	// DefaultHostedAPIURL is the public hosted API origin. The sync command
	// appends its versioned event-batch path after validating this origin.
	DefaultHostedAPIURL = "https://api.handoffgraph.dev"

	// Hosted endpoint and credential overrides deliberately use environment
	// variables rather than command-line flags: a device token in argv is
	// exposed to shell history and process listings.
	HostedAPIURLEnv = "HFG_HOSTED_API_URL"
	DeviceTokenEnv  = "HFG_DEVICE_TOKEN"
)

// HostedConfig contains the non-repository-scoped settings used by an
// explicit hosted sync. DeviceToken is populated only from the environment;
// a config file may name a protected token file but may never contain the raw
// token itself.
type HostedConfig struct {
	APIURL      string `toml:"hosted_api_url"`
	TokenFile   string `toml:"hosted_token_file"`
	DeviceToken string `toml:"-"`
}

// LoadHosted loads hosted settings from the user config only, followed by
// environment overrides. It intentionally does not inspect a repository
// .handoffgraph.toml: otherwise entering an untrusted checkout could redirect
// a device credential to an attacker-controlled origin when `sync` is run.
func LoadHosted() (HostedConfig, error) {
	cfg := HostedConfig{APIURL: DefaultHostedAPIURL}
	path := filepath.Join(UserDataDir(), "config.toml")
	if _, err := os.Stat(path); err == nil {
		if _, err := toml.DecodeFile(path, &cfg); err != nil {
			return HostedConfig{}, fmt.Errorf("load hosted user config %s: %w", path, err)
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return HostedConfig{}, fmt.Errorf("stat hosted user config %s: %w", path, err)
	}
	if value := os.Getenv(HostedAPIURLEnv); value != "" {
		cfg.APIURL = value
	}
	if value := os.Getenv(DeviceTokenEnv); value != "" {
		cfg.DeviceToken = value
	}
	return cfg, nil
}
