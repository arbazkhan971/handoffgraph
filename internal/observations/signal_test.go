package observations

import (
	"testing"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// TestPrecedenceOrder pins the ranking the whole coalescing design rests on.
func TestPrecedenceOrder(t *testing.T) {
	if !(Precedence(SignalNative) > Precedence(SignalHook) &&
		Precedence(SignalHook) > Precedence(SignalSDK) &&
		Precedence(SignalSDK) > Precedence(SignalImport)) {
		t.Fatal("precedence must be native > hook > sdk > import")
	}
	if Precedence(SignalSource("bogus")) != Precedence(SignalImport) {
		t.Fatal("an unknown source must rank no higher than import")
	}
}

func TestParseSignalSource(t *testing.T) {
	// Case and surrounding whitespace are normalized away.
	for _, in := range []string{"native", "HOOK", " sdk ", "import"} {
		if _, ok := ParseSignalSource(in); !ok {
			t.Errorf("ParseSignalSource(%q) rejected a valid source", in)
		}
	}
	for _, in := range []string{"", "vendor", "otlp", "nativ"} {
		if got, ok := ParseSignalSource(in); ok {
			t.Errorf("ParseSignalSource(%q) = %q, want rejected", in, got)
		}
	}
}

// TestDeriveSignalSourceMatrix walks the classification ladder end to end.
func TestDeriveSignalSourceMatrix(t *testing.T) {
	cases := []struct {
		name     string
		provider string
		attrs    map[string]any
		want     SignalSource
		declared bool
	}{
		{
			name:     "explicit declaration wins over every heuristic",
			provider: protocol.ProviderOTLP,
			attrs: map[string]any{
				SignalSourceAttr:       "native",
				"telemetry.sdk.name":   "opentelemetry",
				"gen_ai.request.model": "claude-opus",
			},
			want: SignalNative, declared: true,
		},
		{
			name:     "explicit declaration also overrides an adapter shape",
			provider: protocol.ProviderClaude,
			attrs:    map[string]any{SignalSourceAttr: "native"},
			want:     SignalNative, declared: true,
		},
		{
			name:     "an invalid declaration cannot promote itself",
			provider: protocol.ProviderOTLP,
			attrs:    map[string]any{SignalSourceAttr: "vendor-supreme"},
			want:     SignalImport,
		},
		{
			name:     "adapter-normalized events are hook",
			provider: protocol.ProviderClaude,
			want:     SignalHook,
		},
		{
			name:     "codex adapter is hook too",
			provider: protocol.ProviderCodex,
			attrs:    map[string]any{"gen_ai.request.model": "gpt-5.3"},
			want:     SignalHook,
		},
		{
			name:     "vendor-native instrumentation scope is native",
			provider: protocol.ProviderOTLP,
			attrs: map[string]any{
				"otlp.scope.name":      "com.anthropic.claude_code",
				"gen_ai.request.model": "claude-opus",
			},
			want: SignalNative,
		},
		{
			name:     "a sub-scope of a native scope is still native",
			provider: protocol.ProviderOTLP,
			attrs:    map[string]any{"otlp.scope.name": "claude_code.tools"},
			want:     SignalNative,
		},
		{
			name:     "an explicit native-telemetry marker is native",
			provider: protocol.ProviderOTLP,
			attrs:    map[string]any{nativeTelemetryAttr: true, "gen_ai.system": "anthropic"},
			want:     SignalNative,
		},
		{
			name:     "telemetry.sdk hints mean sdk",
			provider: protocol.ProviderOTLP,
			attrs:    map[string]any{"telemetry.sdk.name": "opentelemetry"},
			want:     SignalSDK,
		},
		{
			name:     "gen_ai instrumentation hints mean sdk",
			provider: protocol.ProviderOTLP,
			attrs:    map[string]any{"gen_ai.operation.name": "chat"},
			want:     SignalSDK,
		},
		{
			name:     "openinference instrumentation means sdk",
			provider: protocol.ProviderOTLP,
			attrs:    map[string]any{"openinference.span.kind": "LLM"},
			want:     SignalSDK,
		},
		{
			name:     "no hints at all is an import",
			provider: protocol.ProviderOTLP,
			attrs:    map[string]any{"service.version": "1.2.3"},
			want:     SignalImport,
		},
		{
			name: "no provider and no attributes is an import",
			want: SignalImport,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, declared := DeriveSignalSource(tc.provider, tc.attrs)
			if got != tc.want {
				t.Errorf("source = %q, want %q", got, tc.want)
			}
			if declared != tc.declared {
				t.Errorf("declared = %v, want %v", declared, tc.declared)
			}
		})
	}
}

// TestDeriveSignalSourceFromKeyManifest: a minimal-tier capture keeps only
// the attribute keys, and instrumentation is still recognizable from them.
func TestDeriveSignalSourceFromKeyManifest(t *testing.T) {
	got, declared := DeriveSignalSource(protocol.ProviderOTLP, nil,
		"gen_ai.request.model", "service.version")
	if got != SignalSDK || declared {
		t.Fatalf("manifest classification = (%q, %v), want (sdk, false)", got, declared)
	}
	// Keys with no instrumentation meaning leave it an import.
	if got, _ := DeriveSignalSource(protocol.ProviderOTLP, nil, "service.version"); got != SignalImport {
		t.Fatalf("uninformative manifest = %q, want import", got)
	}
	// A manifest cannot prove native emission — the scope value is gone — so
	// the strongest claim available is sdk.
	if got, _ := DeriveSignalSource(protocol.ProviderOTLP, nil,
		"otlp.scope.name", "gen_ai.system"); got != SignalSDK {
		t.Fatalf("native scope key without its value = %q, want sdk", got)
	}
}

func TestCanonicalProvider(t *testing.T) {
	cases := []struct{ provider, agent, want string }{
		// An adapter already knows its provider; the agent label is ignored.
		{protocol.ProviderClaude, "anything", protocol.ProviderClaude},
		{protocol.ProviderCodex, "", protocol.ProviderCodex},
		// OTLP is a transport: the emitting service names the real provider.
		{protocol.ProviderOTLP, "claude-code", protocol.ProviderClaude},
		{protocol.ProviderOTLP, "Claude Code CLI", protocol.ProviderClaude},
		{protocol.ProviderOTLP, "codex-cli", protocol.ProviderCodex},
		{protocol.ProviderOTLP, "pi", protocol.ProviderPi},
		// "pi" is too short to substring-match: these must not become pi.
		{protocol.ProviderOTLP, "api-gateway", protocol.ProviderOTLP},
		{protocol.ProviderOTLP, "pipeline-runner", protocol.ProviderOTLP},
		{protocol.ProviderOTLP, "", protocol.ProviderOTLP},
		{protocol.ProviderOTLP, "some-unknown-agent", protocol.ProviderOTLP},
	}
	for _, tc := range cases {
		if got := CanonicalProvider(tc.provider, tc.agent); got != tc.want {
			t.Errorf("CanonicalProvider(%q, %q) = %q, want %q", tc.provider, tc.agent, got, tc.want)
		}
	}
}

func TestCoalesceKey(t *testing.T) {
	// The whole point: a session seen natively over OTLP and through the
	// claude hook adapter must land on the same key.
	native := CoalesceKey(CanonicalProvider(protocol.ProviderOTLP, "claude-code"), "sess-1")
	hook := CoalesceKey(CanonicalProvider(protocol.ProviderClaude, ""), "sess-1")
	if native != hook {
		t.Fatalf("cross-pipeline keys differ: %q vs %q", native, hook)
	}
	if CoalesceKey(protocol.ProviderClaude, "") != "" {
		t.Fatal("a session with no native id must not be coalescable")
	}
	if CoalesceKey(protocol.ProviderClaude, "a") == CoalesceKey(protocol.ProviderCodex, "a") {
		t.Fatal("the same native id under different providers must not collide")
	}
}
