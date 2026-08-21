package content

import (
	"encoding/json"
	"testing"
)

func TestCanonicalJSONDeterministic(t *testing.T) {
	a := map[string]any{"b": 1, "a": 2, "c": map[string]any{"z": 1, "y": 2}}
	b := map[string]any{"a": 2, "c": map[string]any{"y": 2, "z": 1}, "b": 1}

	ca, err := CanonicalJSON(a)
	if err != nil {
		t.Fatal(err)
	}
	cb, err := CanonicalJSON(b)
	if err != nil {
		t.Fatal(err)
	}
	if string(ca) != string(cb) {
		t.Fatalf("canonical encoding not deterministic:\n%s\n%s", ca, cb)
	}
}

func TestCanonicalJSONNoHTMLEscaping(t *testing.T) {
	got, err := CanonicalJSON(map[string]any{"html": "<script>&"})
	if err != nil {
		t.Fatal(err)
	}
	s := string(got)
	if s != `{"html":"<script>&"}` {
		t.Fatalf("unexpected encoding: %s", s)
	}
}

func TestHashStable(t *testing.T) {
	h1, err := Hash(map[string]any{"a": 1, "b": []any{1, 2, 3}})
	if err != nil {
		t.Fatal(err)
	}
	h2, err := Hash(map[string]any{"b": []any{1, 2, 3}, "a": 1})
	if err != nil {
		t.Fatal(err)
	}
	if h1 != h2 {
		t.Fatalf("hash not stable: %s != %s", h1, h2)
	}
}

func TestHashBytesPrefix(t *testing.T) {
	h := HashBytes([]byte("hello"))
	if len(h) != 7+64 { // "sha256:" + 64 hex
		t.Fatalf("unexpected hash length: %s", h)
	}
}

func TestNormalizeRawMessage(t *testing.T) {
	raw := json.RawMessage(`{"z":1,"a":{"m":2,"l":1}}`)
	got, err := CanonicalJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != `{"a":{"l":1,"m":2},"z":1}` {
		t.Fatalf("raw message not normalized: %s", got)
	}
}
