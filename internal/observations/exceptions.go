package observations

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strconv"
	"strings"
)

// Exception grouping (parity-plan row 13).
//
// Two runs of the same bug rarely produce byte-identical messages: request
// ids, temp paths, line offsets and durations all change. Grouping folds a
// raw error into a stable template first, then hashes
// (error_type | template | top_frame). The template pipeline is a fixed,
// ordered sequence of replacements so the same input always yields the same
// template on every machine and every rebuild.

// Placeholders substituted into a normalized message template.
const (
	phString = "<str>"
	phUUID   = "<uuid>"
	phHex    = "<hex>"
	phPath   = "<path>"
	phNum    = "<num>"
)

var (
	// Quoted spans go first: their contents are payload, not structure, and
	// normalizing them piecemeal would leak the payload's shape into the
	// template.
	reQuoted = regexp.MustCompile("'[^']*'|\"[^\"]*\"|`[^`]*`")
	// UUIDs before generic hex so a uuid never decomposes into hex + digits.
	reUUID = regexp.MustCompile(`(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`)
	// 0x-prefixed words, plus bare hex runs of 8+ chars. The bare form is
	// filtered afterwards so an all-digit run stays a number.
	reHexPrefixed = regexp.MustCompile(`(?i)\b0x[0-9a-f]+\b`)
	reHexBare     = regexp.MustCompile(`(?i)\b[0-9a-f]{8,}\b`)
	reHexHasAlpha = regexp.MustCompile(`(?i)[a-f]`)
	// Paths before digits: a path is full of digits (python3.11, versioned
	// directories) and normalizing digits first would shred it into
	// fragments.
	//
	// Each alternative demands enough structure that ordinary prose is not
	// mistaken for a path: a Windows drive letter, a ./ or ../ prefix, two or
	// more segments after a leading slash, three or more bare segments, or a
	// bare relative path ending in a dotted filename. That last pair is what
	// separates "internal/client/retry.go" from "read/write" and "5/10".
	rePath = regexp.MustCompile(`(?i)(?:` +
		`[a-z]:\\[\w.+\\-]+` +
		`|\.{1,2}(?:/[\w.+-]+)+/?` +
		`|(?:/[\w.+-]+){2,}/?` +
		`|[\w.+-]+(?:/[\w.+-]+){2,}/?` +
		`|[\w+-]+(?:/[\w+-]+)*/[\w+-]+\.[a-z]\w*` +
		`)`)
	// Digit runs last, once every structure that contains digits is gone.
	reDigits = regexp.MustCompile(`\d+`)
	reSpace  = regexp.MustCompile(`\s+`)
)

// NormalizeMessage folds a raw error message into a stable template.
//
// The replacement order is load-bearing and fixed: quoted strings, uuids,
// hex ids, paths, digit runs, whitespace. Each stage runs over the output of
// the previous one, so a construct that contains another (a uuid inside a
// path inside a quoted string) is replaced at its outermost level exactly
// once.
func NormalizeMessage(msg string) string {
	s := reQuoted.ReplaceAllLiteralString(msg, phString)
	s = reUUID.ReplaceAllLiteralString(s, phUUID)
	s = reHexPrefixed.ReplaceAllLiteralString(s, phHex)
	s = reHexBare.ReplaceAllStringFunc(s, func(m string) string {
		// An 8+ digit run with no hex letter is a number (a timestamp, a
		// port, a byte count), not an identifier.
		if !reHexHasAlpha.MatchString(m) {
			return m
		}
		return phHex
	})
	s = rePath.ReplaceAllLiteralString(s, phPath)
	s = reDigits.ReplaceAllLiteralString(s, phNum)
	s = reSpace.ReplaceAllLiteralString(s, " ")
	return strings.TrimSpace(s)
}

// NormalizeFrame reduces a stack line to its stable part. Stack frames carry
// line and column numbers that move with every edit, so they go through the
// same template pipeline as the message.
func NormalizeFrame(frame string) string {
	return NormalizeMessage(strings.TrimSpace(frame))
}

// TopFrame returns the first non-empty line of a stack trace.
func TopFrame(stack string) string {
	for _, line := range strings.Split(stack, "\n") {
		if t := strings.TrimSpace(line); t != "" {
			return t
		}
	}
	return ""
}

// GroupHash is the deterministic grouping key: sha256 over the error type,
// the normalized message template and the normalized top frame.
//
// The three fields are length-prefixed rather than joined by a separator.
// Any separator can also occur inside a field — a message template may well
// contain a pipe — and a plain join would then let ("a|b", "c") and
// ("a", "b|c") hash identically, silently merging two different bugs into one
// group. Length framing makes the encoding unambiguous for every input.
func GroupHash(errorType, messageTemplate, topFrame string) string {
	h := sha256.New()
	for _, field := range []string{errorType, messageTemplate, topFrame} {
		h.Write([]byte(strconv.Itoa(len(field))))
		h.Write([]byte{':'})
		h.Write([]byte(field))
	}
	return hex.EncodeToString(h.Sum(nil))
}
