package otlp

import (
	"fmt"
	"sort"
	"strings"
)

// CaptureTier is the emit-time privacy tier (parity-plan row 23; OpenLIT's
// product concept enforced with fail-closed semantics):
//
//	minimal  — no attribute values land at all; a sorted key manifest
//	           preserves structure without content
//	metadata — structural attributes (model, usage, tool names, session,
//	           kinds) are kept; prompt/completion/retrieval bodies are
//	           dropped and counted
//	full     — everything kept (still sanitized; local-first default)
type CaptureTier string

const (
	CaptureMinimal  CaptureTier = "minimal"
	CaptureMetadata CaptureTier = "metadata"
	CaptureFull     CaptureTier = "full"
)

// ParseCaptureTier is total: empty means full (the local-first default).
func ParseCaptureTier(s string) (CaptureTier, error) {
	switch CaptureTier(s) {
	case "", CaptureFull:
		return CaptureFull, nil
	case CaptureMinimal:
		return CaptureMinimal, nil
	case CaptureMetadata:
		return CaptureMetadata, nil
	default:
		return "", fmt.Errorf("invalid capture tier %q (want minimal, metadata, or full)", s)
	}
}

// bodyAttrPrefixes are attribute namespaces whose VALUES are content bodies.
// Under metadata these keys are dropped (and counted); under minimal every
// value is dropped anyway. Keys are evaluated case-insensitively on the
// exact prefixes below.
var bodyAttrPrefixes = []string{
	"gen_ai.input.messages",
	"gen_ai.output.messages",
	"gen_ai.prompt",
	"gen_ai.completion",
	"gen_ai.content",
	"llm.prompt",
	"llm.completion",
	"input.value",
	"output.value",
	"retrieval.documents",
	"prompt.body",
	"response.body",
	"coding_agent.transcript",
	"coding_agent.diff",
}

// isBodyAttr reports whether the key carries content bodies.
func isBodyAttr(key string) bool {
	lk := strings.ToLower(key)
	for _, p := range bodyAttrPrefixes {
		if strings.HasPrefix(lk, p) {
			return true
		}
	}
	return false
}

// applyTier filters a sanitized attribute map for the capture tier. It
// returns the (possibly reduced) map, the number of keys dropped by the
// tier, and — under minimal — the sorted key manifest that preserves
// structure without content. Reserved-key drops and validation already
// happened upstream; a tier drop is recorded, never silent.
func applyTier(attrs map[string]any, tier CaptureTier) (map[string]any, int, []string) {
	if len(attrs) == 0 || tier == CaptureFull {
		return attrs, 0, nil
	}
	if tier == CaptureMinimal {
		keys := make([]string, 0, len(attrs))
		for k := range attrs {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		return nil, len(attrs), keys
	}
	// metadata: drop body keys.
	out := make(map[string]any, len(attrs))
	dropped := 0
	for k, v := range attrs {
		if isBodyAttr(k) {
			dropped++
			continue
		}
		out[k] = v
	}
	return out, dropped, nil
}
