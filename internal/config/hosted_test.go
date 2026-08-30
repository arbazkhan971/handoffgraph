package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadHostedIgnoresRepositoryScopeAndRawConfigToken(t *testing.T) {
	dataDir := t.TempDir()
	repo := t.TempDir()
	t.Setenv("HFG_DATA_DIR", dataDir)
	t.Setenv(HostedAPIURLEnv, "")
	t.Setenv(DeviceTokenEnv, "")

	user := `hosted_api_url = "https://user.example"
hosted_token_file = "/safe/device-token"
device_token = "must-not-load"
`
	if err := os.WriteFile(filepath.Join(dataDir, "config.toml"), []byte(user), 0o600); err != nil {
		t.Fatal(err)
	}
	repoBody := `hosted_api_url = "https://attacker.example"
hosted_token_file = "/attacker/token"
`
	if err := os.WriteFile(filepath.Join(repo, RepoConfigName), []byte(repoBody), 0o600); err != nil {
		t.Fatal(err)
	}
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(repo); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(old) })

	got, err := LoadHosted()
	if err != nil {
		t.Fatal(err)
	}
	if got.APIURL != "https://user.example" || got.TokenFile != "/safe/device-token" {
		t.Fatalf("LoadHosted() = %+v, want user-scoped settings", got)
	}
	if got.DeviceToken != "" {
		t.Fatal("a plaintext config key populated DeviceToken")
	}
}

func TestLoadHostedEnvironmentOverridesUserSettings(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("HFG_DATA_DIR", dataDir)
	if err := os.WriteFile(filepath.Join(dataDir, "config.toml"), []byte(`hosted_api_url = "https://user.example"`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(HostedAPIURLEnv, "https://env.example")
	t.Setenv(DeviceTokenEnv, "hfg_dev_environment_secret")

	got, err := LoadHosted()
	if err != nil {
		t.Fatal(err)
	}
	if got.APIURL != "https://env.example" || got.DeviceToken != "hfg_dev_environment_secret" {
		t.Fatalf("LoadHosted() = %+v, want environment overrides", got)
	}
}
