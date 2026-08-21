// Package content provides deterministic (canonical) JSON encoding and
// content hashing used for integrity checks and the object store.
//
// Canonical encoding guarantees that logically identical objects produce
// identical bytes and therefore identical hashes, which is what makes the
// deterministic reducer and graph rebuild possible.
package content

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
)

// CanonicalJSON returns a deterministic JSON encoding of v.
//
// It normalizes JSON object keys to sorted order and encodes with
// html-escaping disabled so that "<" and ">" are not rewritten. Numbers are
// preserved as Go's encoding/json emits them.
func CanonicalJSON(v any) ([]byte, error) {
	normalized, err := normalize(v)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(normalized); err != nil {
		return nil, err
	}
	// json.Encoder appends a trailing newline; strip it for a stable form.
	b := buf.Bytes()
	return bytes.TrimRight(b, "\n"), nil
}

// Hash returns the sha256 hex digest of a canonical JSON encoding of v.
func Hash(v any) (string, error) {
	b, err := CanonicalJSON(v)
	if err != nil {
		return "", err
	}
	return HashBytes(b), nil
}

// HashBytes returns the sha256 hex digest of raw bytes.
func HashBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// normalize converts maps to a sorted-key representation so that two maps
// with the same content always serialize identically.
func normalize(v any) (any, error) {
	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		out := make(map[string]any, len(t))
		for _, k := range keys {
			nv, err := normalize(t[k])
			if err != nil {
				return nil, err
			}
			out[k] = nv
		}
		return out, nil
	case []any:
		out := make([]any, len(t))
		for i, item := range t {
			nv, err := normalize(item)
			if err != nil {
				return nil, err
			}
			out[i] = nv
		}
		return out, nil
	case json.RawMessage:
		var raw any
		dec := json.NewDecoder(bytes.NewReader(t))
		dec.UseNumber()
		if err := dec.Decode(&raw); err != nil {
			return nil, fmt.Errorf("normalize raw json: %w", err)
		}
		return normalize(raw)
	default:
		return v, nil
	}
}
