package hostedsync

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// ResolveDeviceToken returns a device credential from the environment value
// or, when that is empty, a protected token file. Raw tokens are never
// accepted as command-line flags or persisted in HandoffGraph config/state.
func ResolveDeviceToken(environmentValue, tokenFile string) (string, error) {
	if environmentValue != "" {
		return validateDeviceToken(environmentValue)
	}
	if tokenFile == "" {
		return "", fmt.Errorf("hosted device credential is missing: set HFG_DEVICE_TOKEN or hosted_token_file in the user config")
	}
	if !filepath.IsAbs(tokenFile) {
		return "", fmt.Errorf("hosted_token_file must be an absolute path")
	}
	info, err := os.Lstat(tokenFile)
	if err != nil {
		return "", fmt.Errorf("read hosted device credential: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return "", fmt.Errorf("hosted_token_file must be a regular file, not a symlink")
	}
	file, err := os.Open(tokenFile)
	if err != nil {
		return "", fmt.Errorf("read hosted device credential: %w", err)
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(info, opened) {
		return "", fmt.Errorf("hosted_token_file changed while it was being opened")
	}
	if runtime.GOOS != "windows" && opened.Mode().Perm()&0o077 != 0 {
		return "", fmt.Errorf("hosted_token_file permissions are too broad: require mode 0600 or stricter")
	}
	if opened.Size() < 1 || opened.Size() > 512 {
		return "", fmt.Errorf("hosted_token_file has an invalid size")
	}
	raw, err := io.ReadAll(io.LimitReader(file, 513))
	if err != nil {
		return "", fmt.Errorf("read hosted device credential: %w", err)
	}
	if len(raw) > 512 {
		return "", fmt.Errorf("hosted_token_file has an invalid size")
	}
	value := strings.TrimSuffix(strings.TrimSuffix(string(raw), "\n"), "\r")
	return validateDeviceToken(value)
}

func validateDeviceToken(token string) (string, error) {
	if token != strings.TrimSpace(token) || strings.ContainsAny(token, " \t\r\n") {
		return "", fmt.Errorf("hosted device credential contains whitespace")
	}
	if len(token) < 16 || len(token) > 256 || !strings.HasPrefix(token, "hfg_dev_") {
		return "", fmt.Errorf("hosted device credential has an invalid format")
	}
	return token, nil
}

// NormalizeEndpoint validates a trusted API origin and returns its canonical
// origin plus the fixed ingest URL. HTTP is accepted only for loopback test
// and local-development servers; remote credentials always require HTTPS.
func NormalizeEndpoint(raw string) (origin, batchURL string, err error) {
	if raw == "" || raw != strings.TrimSpace(raw) {
		return "", "", fmt.Errorf("hosted_api_url is empty or contains surrounding whitespace")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", "", fmt.Errorf("invalid hosted_api_url: %w", err)
	}
	if u.Scheme == "" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", "", fmt.Errorf("hosted_api_url must be an origin without credentials, query, or fragment")
	}
	if u.Path != "" && u.Path != "/" {
		return "", "", fmt.Errorf("hosted_api_url must not contain a path")
	}
	u.Scheme = strings.ToLower(u.Scheme)
	hostname := strings.ToLower(u.Hostname())
	loopback := strings.EqualFold(hostname, "localhost")
	if ip := net.ParseIP(hostname); ip != nil && ip.IsLoopback() {
		loopback = true
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
		return "", "", fmt.Errorf("hosted_api_url must use HTTPS (HTTP is allowed only on loopback)")
	}
	port := u.Port()
	if (u.Scheme == "https" && port == "443") || (u.Scheme == "http" && port == "80") {
		port = ""
	}
	if strings.Contains(hostname, ":") {
		u.Host = "[" + hostname + "]"
	} else {
		u.Host = hostname
	}
	if port != "" {
		u.Host = net.JoinHostPort(hostname, port)
	}
	u.Path = ""
	u.RawPath = ""
	origin = strings.TrimSuffix(u.String(), "/")
	return origin, origin + "/v1/event-batches", nil
}

func isNotExist(err error) bool { return errors.Is(err, fs.ErrNotExist) }
