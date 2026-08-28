package observations

import (
	"strconv"
	"strings"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// SignalSource names the pipeline that produced an observation (parity-plan
// row 5). One logical agent session can reach us through several pipelines at
// once — the vendor's own OTel exporter, our hook adapters, and a third-party
// SDK wrapper all describing the same run — so every observation records how
// it arrived and the read models coalesce instead of triple-counting.
type SignalSource string

const (
	// SignalNative is the provider's own telemetry emission (vendor-native
	// OTel from the coding agent itself).
	SignalNative SignalSource = "native"
	// SignalHook is our own adapter observing the provider's session files
	// or hook callbacks.
	SignalHook SignalSource = "hook"
	// SignalSDK is third-party instrumentation wrapping the provider.
	SignalSDK SignalSource = "sdk"
	// SignalImport is a bulk/offline import with no instrumentation hints.
	SignalImport SignalSource = "import"
)

// Precedence ranks signal sources; higher wins when the same logical session
// arrives more than once.
//
// Why native > hook > sdk > import: native is the provider's own emission —
// it is closest to the truth because the agent reports its own state with no
// intermediary to lose, reorder or reinterpret anything. A hook adapter is
// second: it observes the provider directly from the same machine, but from
// the outside, so it only sees what the provider chose to write down. A
// third-party SDK wrapper is third: it sees the calls it wraps, which is a
// strict subset of the run and is shaped by the wrapper's own conventions.
// An import is last: it carries no instrumentation hints at all, so we can
// say the least about how faithfully it reflects the original run.
func Precedence(s SignalSource) int {
	switch s {
	case SignalNative:
		return 3
	case SignalHook:
		return 2
	case SignalSDK:
		return 1
	default:
		return 0
	}
}

// ParseSignalSource validates a declared signal source. Unknown values are
// rejected rather than silently coerced: a bad declaration must not be able
// to promote itself past a real native emission.
func ParseSignalSource(s string) (SignalSource, bool) {
	switch SignalSource(strings.ToLower(strings.TrimSpace(s))) {
	case SignalNative:
		return SignalNative, true
	case SignalHook:
		return SignalHook, true
	case SignalSDK:
		return SignalSDK, true
	case SignalImport:
		return SignalImport, true
	default:
		return "", false
	}
}

// SignalSourceAttr is the attribute an emitter sets to declare its own signal
// source. A valid declaration always wins over the heuristics below.
const SignalSourceAttr = "handoffgraph.signal_source"

// nativeTelemetryAttr lets an emitter assert vendor-native emission without
// naming a scope we already know.
const nativeTelemetryAttr = "handoffgraph.native_telemetry"

// nativeScopes are OTel instrumentation scopes belonging to coding agents
// that emit their own telemetry. A span carrying one of these scopes came
// from the vendor's own exporter, not from a wrapper around it. The list is
// deliberately small and explicit; anything not listed falls through to the
// SDK/import heuristics, and any emitter can override it by declaring
// handoffgraph.signal_source directly.
var nativeScopes = []string{
	"claude_code",
	"claude-code",
	"com.anthropic.claude_code",
	"codex_cli",
	"codex-cli",
	"openai.codex",
	"gemini_cli",
	"com.google.gemini_cli",
}

// sdkAttrPrefixes mark third-party instrumentation. telemetry.sdk.* is the
// OTel SDK's own resource namespace; the rest are GenAI instrumentation
// conventions emitted by wrapper libraries.
var sdkAttrPrefixes = []string{
	"telemetry.sdk.",
	"gen_ai.",
	"llm.",
	"openinference.",
	"traceloop.",
	"langfuse.",
	"openlit.",
}

// DeriveSignalSource classifies one observation. It returns the source and
// whether the emitter declared it explicitly (an explicit declaration beats
// every heuristic, and beats a heuristic guess when the two disagree).
//
// The ladder:
//  1. handoffgraph.signal_source, when it names a known source.
//  2. A non-OTLP provider means one of our own adapters normalized it: the
//     event exists because a hook observed the provider, so it is `hook`.
//     This is read off the event shape — adapters need no changes.
//  3. OTLP with a vendor-native instrumentation scope (or an explicit
//     handoffgraph.native_telemetry marker) is `native`.
//  4. OTLP with telemetry.sdk.* / gen_ai.* style instrumentation hints is
//     `sdk`.
//  5. Anything else is `import`.
//
// keyManifest is the sorted attribute-key list a minimal-tier capture keeps
// in place of the values. It lets step 4 still recognize instrumentation when
// no value survived; steps 1 and 3 need values and cannot be recovered from
// it, so a minimal-tier capture of a vendor-native emission classifies as
// `sdk` rather than `native`. That is the honest answer: under minimal we
// deliberately kept less evidence, so we claim less.
func DeriveSignalSource(provider string, attrs map[string]any, keyManifest ...string) (SignalSource, bool) {
	if s, ok := ParseSignalSource(attrString(attrs, SignalSourceAttr)); ok {
		return s, true
	}
	if provider != "" && provider != protocol.ProviderOTLP {
		return SignalHook, false
	}
	if isNativeTelemetry(attrs) {
		return SignalNative, false
	}
	if hasSDKHint(attrs) || hasSDKHintKeys(keyManifest) {
		return SignalSDK, false
	}
	return SignalImport, false
}

func isNativeTelemetry(attrs map[string]any) bool {
	if truthy(attrs[nativeTelemetryAttr]) {
		return true
	}
	scope := strings.ToLower(strings.TrimSpace(attrString(attrs, "otlp.scope.name")))
	if scope == "" {
		return false
	}
	for _, want := range nativeScopes {
		if scope == want || strings.HasPrefix(scope, want+".") {
			return true
		}
	}
	return false
}

func hasSDKHint(attrs map[string]any) bool {
	for k := range attrs {
		if isSDKKey(k) {
			return true
		}
	}
	return false
}

func hasSDKHintKeys(keys []string) bool {
	for _, k := range keys {
		if isSDKKey(k) {
			return true
		}
	}
	return false
}

func isSDKKey(key string) bool {
	lk := strings.ToLower(key)
	for _, p := range sdkAttrPrefixes {
		if strings.HasPrefix(lk, p) {
			return true
		}
	}
	return false
}

// CanonicalProvider resolves the logical provider a session belongs to.
//
// Our adapters stamp the real provider on the event. OTLP is a transport, not
// a provider: an OTLP event records `otlp` and carries the emitting service
// name as its agent. Coalescing needs the two to agree, otherwise a session
// seen natively over OTLP and through the claude hook adapter would never
// meet. Mapping the agent label back onto the provider it describes is what
// makes (provider, native_session_id) a cross-pipeline identity.
func CanonicalProvider(provider, agent string) string {
	if provider != "" && provider != protocol.ProviderOTLP {
		return provider
	}
	switch a := strings.ToLower(strings.TrimSpace(agent)); {
	case a == "":
		return provider
	case strings.Contains(a, "claude"):
		return protocol.ProviderClaude
	case strings.Contains(a, "codex"):
		return protocol.ProviderCodex
	case a == "pi" || a == "pi-cli" || a == "pi_cli" || a == "pi-agent":
		// "pi" is too short for substring matching (it hides inside "api",
		// "pipeline", ...), so only exact agent labels map onto it.
		return protocol.ProviderPi
	default:
		return provider
	}
}

// CoalesceKey is the cross-pipeline identity of a session: the canonical
// provider plus the provider's own session id. An empty native session id
// yields an empty key, which means "not coalescable" — such a row is always
// its own group and can never be shadowed.
//
// The provider is length-prefixed rather than separated by a delimiter. A
// native session id is arbitrary provider-controlled text, so any delimiter
// could also appear inside it; length framing keeps the encoding unambiguous
// and, unlike a control byte, keeps the key printable in JSON output and
// readable in a SQL console.
func CoalesceKey(canonicalProvider, nativeSessionID string) string {
	if nativeSessionID == "" {
		return ""
	}
	return strconv.Itoa(len(canonicalProvider)) + ":" + canonicalProvider + ":" + nativeSessionID
}

func attrString(attrs map[string]any, key string) string {
	if attrs == nil {
		return ""
	}
	s, _ := attrs[key].(string)
	return s
}

func truthy(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return t == "true" || t == "1"
	case float64:
		return t != 0
	case int64:
		return t != 0
	default:
		return false
	}
}
