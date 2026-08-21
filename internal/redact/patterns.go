package redact

import (
	"encoding/json"
	"regexp"
)

// jsonUnmarshal / jsonMarshal are thin wrappers so the engine can be tested
// against standard library behavior without importing it everywhere.
func jsonUnmarshal(data []byte, v any) error { return json.Unmarshal(data, v) }
func jsonMarshal(v any) ([]byte, error)      { return json.Marshal(v) }

// builtinTokenPatterns are known secret/token formats that are redacted
// regardless of entropy.
var builtinTokenPatterns = []*regexp.Regexp{
	// AWS access key id + secret
	regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`),
	regexp.MustCompile(`\b(?i)aws[_\-]?secret[_\-]?access[_\-]?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{20,}`),
	// GitHub tokens
	regexp.MustCompile(`\bghp_[A-Za-z0-9]{36,}\b`),
	regexp.MustCompile(`\bgho_[A-Za-z0-9]{36,}\b`),
	regexp.MustCompile(`\bghu_[A-Za-z0-9]{36,}\b`),
	regexp.MustCompile(`\bghs_[A-Za-z0-9]{36,}\b`),
	// OpenAI / Anthropic / generic API keys
	regexp.MustCompile(`\bsk-[A-Za-z0-9]{20,}\b`),
	regexp.MustCompile(`\bsk-ant-[A-Za-z0-9\-]{20,}\b`),
	// Generic keyword-anchored secrets. `[_-]` (not \b) precedes the keyword
	// so underscore-qualified names like db_password=/api_secret= also anchor;
	// the value runs to end-of-value so multi-word secrets are fully masked.
	regexp.MustCompile(`(?i)(?:^|[^a-z0-9])(bearer|authorization|token|api[_-]?key|secret|password|passwd)["']?\s*[:=]\s*["']?[^"',;]{8,}`),
	// Private key blocks
	regexp.MustCompile(`-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----`),
	// Slack tokens
	regexp.MustCompile(`\bxox[baprs]-[A-Za-z0-9\-]{10,}\b`),
	// Stripe
	regexp.MustCompile(`\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b`),
	// Google API key
	regexp.MustCompile(`\bAIza[0-9A-Za-z\-_]{35}\b`),
	// Generic JWT
	regexp.MustCompile(`\beyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\b`),
}
