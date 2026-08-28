package otlp

import "testing"

func TestParseCaptureTier(t *testing.T) {
	if got, err := ParseCaptureTier(""); err != nil || got != CaptureFull {
		t.Fatalf("empty = %v, %v", got, err)
	}
	for _, in := range []string{"minimal", "metadata", "full"} {
		if _, err := ParseCaptureTier(in); err != nil {
			t.Fatalf("%s: %v", in, err)
		}
	}
	if _, err := ParseCaptureTier("yolo"); err == nil {
		t.Fatal("invalid tier accepted")
	}
}

func TestApplyTier(t *testing.T) {
	attrs := map[string]any{
		"gen_ai.request.model":      "gpt-5.3",
		"gen_ai.usage.input_tokens": int64(10),
		"gen_ai.input.messages":     "the secret prompt",
		"llm.prompt":                "also secret",
		"session.id":                "s1",
	}

	full, dropped, manifest := applyTier(attrs, CaptureFull)
	if len(full) != 5 || dropped != 0 || manifest != nil {
		t.Fatalf("full tier: %d kept, %d dropped", len(full), dropped)
	}

	meta, dropped, manifest := applyTier(attrs, CaptureMetadata)
	if dropped != 2 || manifest != nil {
		t.Fatalf("metadata: %d dropped, manifest %v", dropped, manifest)
	}
	if _, ok := meta["gen_ai.input.messages"]; ok {
		t.Fatal("body key survived metadata tier")
	}
	if meta["gen_ai.request.model"] != "gpt-5.3" {
		t.Fatal("metadata must keep structural attributes")
	}

	min, dropped, manifest := applyTier(attrs, CaptureMinimal)
	if len(min) != 0 || dropped != 5 {
		t.Fatalf("minimal: %d kept, %d dropped", len(min), dropped)
	}
	if len(manifest) != 5 {
		t.Fatalf("minimal manifest = %v", manifest)
	}
	if manifest[0] != "gen_ai.input.messages" {
		t.Fatalf("manifest not sorted: %v", manifest)
	}
}
