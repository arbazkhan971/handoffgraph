// Package redact implements the fail-closed redaction pipeline (v1).
//
// Pipeline stages, in order:
//  1. Path denylist (configurable).
//  2. Known token patterns (AWS keys, GitHub tokens, generic API keys, etc.).
//  3. High-entropy secret detection.
//  4. User-supplied regular expressions.
//
// Redaction is fail-closed: if any stage errors, the object is marked
// REDACTION_FAILED and must never be exported in its original form. The
// original secret is never written into the audit record.
package redact

import (
	"fmt"
	"math"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// Status values for redaction results.
const (
	StatusClean    = "clean"
	StatusRedacted = "redacted"
	StatusFailed   = "failed"
)

// RedactionVersion is the current redaction pipeline version.
const RedactionVersion = 1

// Mask is the replacement for redacted content.
const Mask = "[REDACTED]"

// Engine applies the redaction pipeline.
type Engine struct {
	denyPaths []string
	patterns  []*regexp.Regexp
	entropy   float64 // shannon entropy bits/char threshold
}

// Options configures the redaction engine.
type Options struct {
	DenyPaths []string
	// DenyPaths are glob patterns in path.Match syntax ('*', '?', '[...]'
	// character classes, '\' escapes) checked against file paths and
	// payload keys. A pattern matches the full path or any trailing
	// suffix starting at a '/' boundary; patterns built only from
	// literals and '*' additionally keep the v1 behavior in which '*'
	// crosses '/' boundaries. Malformed patterns are rejected here
	// (fail-closed), never silently ignored at match time.
	// UserPatterns are user-supplied regexes (compiled; invalid patterns error).
	UserPatterns []string
	// EntropyThreshold is the Shannon entropy threshold in bits per character
	// above which a token is considered a potential secret. Default 4.0.
	EntropyThreshold float64
}

// New builds a redaction engine.
func New(opts Options) (*Engine, error) {
	e := &Engine{
		denyPaths: append([]string(nil), opts.DenyPaths...),
		entropy:   opts.EntropyThreshold,
	}
	if e.entropy == 0 {
		e.entropy = 4.0
	}
	// Fail-closed: reject malformed deny globs at construction time so a
	// bad pattern can never silently stop denying paths at match time.
	for _, p := range opts.DenyPaths {
		if _, err := path.Match(strings.ToLower(p), ""); err != nil {
			return nil, fmt.Errorf("invalid redaction deny path %q: %w", p, err)
		}
	}
	for _, p := range opts.UserPatterns {
		re, err := regexp.Compile(p)
		if err != nil {
			return nil, fmt.Errorf("invalid redaction pattern %q: %w", p, err)
		}
		e.patterns = append(e.patterns, re)
	}
	return e, nil
}

// Result describes the outcome of redacting an object.
type Result struct {
	Status        string   `json:"status"`
	FieldsRemoved []string `json:"fields_removed,omitempty"`
	Version       int      `json:"version"`
}

// RedactEvent redacts an event's payload in place (returning a copy).
// On success the event's redaction field is updated with the fields removed.
// On failure the result status is "failed" and the payload is NOT modified.
func (e *Engine) RedactEvent(ev *protocol.Event) (*Result, error) {
	if len(ev.Payload) == 0 {
		return &Result{Status: StatusClean, Version: RedactionVersion}, nil
	}
	var payload map[string]any
	if err := jsonUnmarshal(ev.Payload, &payload); err != nil {
		return &Result{Status: StatusFailed, Version: RedactionVersion}, fmt.Errorf("payload unmarshal: %w", err)
	}

	var fields []string
	if err := e.redactMap(payload, &fields); err != nil {
		return &Result{Status: StatusFailed, Version: RedactionVersion}, err
	}

	if len(fields) == 0 {
		return &Result{Status: StatusClean, Version: RedactionVersion}, nil
	}

	newPayload, err := jsonMarshal(payload)
	if err != nil {
		return &Result{Status: StatusFailed, Version: RedactionVersion}, err
	}
	ev.Payload = newPayload
	ev.Redaction = &protocol.Redaction{
		Version:       RedactionVersion,
		FieldsRemoved: fields,
		Status:        StatusRedacted,
	}
	return &Result{Status: StatusRedacted, FieldsRemoved: fields, Version: RedactionVersion}, nil
}

// RedactValue redacts a single string value; used for preview and direct
// field redaction. Returns the redacted value and whether anything changed.
func (e *Engine) RedactValue(s string) (string, bool) {
	out := s
	changed := false

	for _, re := range builtinTokenPatterns {
		if re.MatchString(out) {
			out = re.ReplaceAllString(out, Mask)
			changed = true
		}
	}
	for _, re := range e.patterns {
		if re.MatchString(out) {
			out = re.ReplaceAllString(out, Mask)
			changed = true
		}
	}
	// High-entropy token detection over whitespace-delimited tokens.
	tokens := strings.FieldsFunc(out, func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\n' || r == '=' || r == ':' || r == ',' || r == ';' || r == '"' || r == '\''
	})
	for _, tok := range tokens {
		if len(tok) >= 16 && shannonEntropy(tok) >= e.entropy && looksLikeSecret(tok) {
			out = strings.ReplaceAll(out, tok, Mask)
			changed = true
		}
	}
	return out, changed
}

// DeniedPath reports whether a file path (or payload key) matches the
// denylist. See matchPath for the exact glob semantics.
func (e *Engine) DeniedPath(path string) bool {
	base := path
	for _, pattern := range e.denyPaths {
		if matchPath(pattern, base) {
			return true
		}
	}
	return false
}

func (e *Engine) redactMap(m map[string]any, fields *[]string) error {
	for k, v := range m {
		switch t := v.(type) {
		case string:
			if e.DeniedPath(k) {
				m[k] = Mask
				*fields = append(*fields, k)
				continue
			}
			if nv, changed := e.RedactValue(t); changed {
				m[k] = nv
				*fields = append(*fields, k)
			}
		case map[string]any:
			if err := e.redactMap(t, fields); err != nil {
				return err
			}
		case []any:
			for i, item := range t {
				switch it := item.(type) {
				case string:
					if nv, changed := e.RedactValue(it); changed {
						t[i] = nv
						*fields = append(*fields, k)
					}
				case map[string]any:
					if err := e.redactMap(it, fields); err != nil {
						return err
					}
				}
			}
		}
	}
	return nil
}

// matchPath reports whether path is matched by the given deny pattern.
//
// Semantics (globbing upgrade per HANDOVER.md §8 item 5):
//
//   - Patterns use path.Match syntax: '*' matches any run of non-'/'
//     characters, '?' matches a single non-'/' character, "[...]" is a
//     character class (ranges like [a-z]; negation with '^', e.g.
//     [^a-z] — note that '!' is NOT a negation marker in path.Match,
//     it is a literal class member), and '\' escapes the next
//     character.
//   - In strict glob mode '*' does NOT cross '/' boundaries, and '**'
//     is treated exactly like '*'.
//   - A pattern also matches when it matches any trailing suffix of the
//     path starting at a '/' boundary (so ".env" denies "src/.env" and
//     "*.pem" denies "src/key.pem"), preserving v1 exact/basename/
//     directory-suffix behavior.
//   - v1 compatibility fallback: patterns built only from literals and
//     '*' keep the old subsequence match in which '*' DOES cross '/'
//     boundaries ("*.pem" still denies "key.pem.bak"; a lone "*" or
//     "**" denies every path). Redaction coverage is therefore a
//     superset of v1 — it never shrinks.
//   - Matching is case-insensitive (v1 behavior).
//   - Malformed patterns are rejected by New (fail-closed). Defensively,
//     matchPath treats a malformed pattern as a non-match rather than
//     widening what gets denied on error.
func matchPath(pattern, path string) bool {
	pattern = strings.ToLower(pattern)
	name := strings.ToLower(path)

	// Strict glob pass: full path plus every '/'-boundary suffix.
	for i := 0; ; {
		ok, err := globMatch(pattern, name[i:])
		if err != nil {
			// Malformed pattern: fail closed. Unreachable for engines
			// built by New, which validates patterns up front.
			return false
		}
		if ok {
			return true
		}
		j := strings.IndexByte(name[i:], '/')
		if j < 0 {
			break
		}
		i += j + 1
		if i == len(name) {
			break // trailing '/': no non-empty suffix left
		}
	}

	// v1 compatibility fallback: '*' as an unconstrained wildcard that
	// crosses '/' boundaries (literal chunks must appear in order).
	if strings.Contains(pattern, "*") && !strings.ContainsAny(pattern, "?[\\") {
		idx := 0
		for _, part := range strings.Split(pattern, "*") {
			if part == "" {
				continue
			}
			found := strings.Index(name[idx:], part)
			if found == -1 {
				return false
			}
			idx += found + len(part)
		}
		return true
	}
	return false
}

// globMatch applies path.Match semantics to name. On Windows it retries
// with filepath.Match so patterns also work against native
// '\'-separated input (where '\' is the separator, not an escape).
func globMatch(pattern, name string) (bool, error) {
	ok, err := path.Match(pattern, name)
	if ok || err != nil {
		return ok, err
	}
	if runtime.GOOS == "windows" {
		return filepath.Match(pattern, name)
	}
	return false, nil
}

func shannonEntropy(s string) float64 {
	if len(s) == 0 {
		return 0
	}
	freq := map[rune]int{}
	for _, r := range s {
		freq[r]++
	}
	var h float64
	n := float64(len(s))
	for _, c := range freq {
		p := float64(c) / n
		h -= p * math.Log2(p)
	}
	return h
}

func looksLikeSecret(s string) bool {
	// High entropy alone isn't enough; require mixed case + digits or
	// symbolic characters typical of secrets, and no spaces.
	if strings.ContainsAny(s, " \t\n") {
		return false
	}
	hasUpper := false
	hasLower := false
	hasDigit := false
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z':
			hasUpper = true
		case r >= 'a' && r <= 'z':
			hasLower = true
		case r >= '0' && r <= '9':
			hasDigit = true
		}
	}
	return hasUpper && hasLower && hasDigit
}
