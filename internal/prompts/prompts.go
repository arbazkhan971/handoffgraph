// Package prompts implements prompt management on the append-only spine
// (parity rows 33-34): immutable content-addressed versions plus mutable
// labels as repointable pointers — the model that made Langfuse prompt
// rollbacks O(1), re-implemented as deterministic event derivation.
//
//	prompt.created  — version N of a named prompt (content in payload,
//	                  fail-closed above the size cap; hashes recorded)
//	prompt.labeled  — points a label (production/latest/custom) at a version
//
// Derived view: versions per name, current label table, and the newest
// version each label resolves to. Trace linkage: any event payload carrying
// prompt_name/prompt_version is listed by Links.
package prompts

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/handoffgraph/handoffgraph/internal/protocol"
)

// maxPromptBytes caps one prompt body (fail-closed beyond). Larger prompts
// should live in files referenced by the prompt, not in the spine.
const maxPromptBytes = 32 * 1024

// Label constants shared by CLI/MCP.
const (
	LabelProduction = "production"
	LabelLatest     = "latest"
)

// Version is one immutable prompt version.
type Version struct {
	Version   int       `json:"version"`
	Body      string    `json:"body"`
	Hash      string    `json:"hash"`
	CreatedAt time.Time `json:"created_at"`
	CreatedBy string    `json:"created_by,omitempty"`
}

// LabelRef points a label at a version of a named prompt.
type LabelRef struct {
	Label   string    `json:"label"`
	Version int       `json:"version"`
	SetAt   time.Time `json:"set_at"`
}

// Prompt is the derived view of one named prompt.
type Prompt struct {
	Name     string     `json:"name"`
	Versions []Version  `json:"versions"`
	Labels   []LabelRef `json:"labels"`
}

// Latest returns the highest version number (0 when none).
func (p *Prompt) Latest() int {
	max := 0
	for _, v := range p.Versions {
		if v.Version > max {
			max = v.Version
		}
	}
	return max
}

// Resolve maps each label to the version it currently points at. `latest`
// defaults to the newest version when never explicitly labeled. Deterministic:
// later label events win.
func (p *Prompt) Resolve() map[string]int {
	out := map[string]int{}
	latest := p.Latest()
	if latest > 0 {
		out[LabelLatest] = latest
	}
	for _, l := range p.Labels {
		out[l.Label] = l.Version
	}
	return out
}

// Materialize derives all prompts from the event log. Deterministic.
func Materialize(events []*protocol.Event) map[string]*Prompt {
	byName := map[string]*Prompt{}
	for _, ev := range events {
		switch ev.Kind {
		case protocol.EventPromptCreated:
			var p struct {
				Name      string `json:"name"`
				Version   int    `json:"version"`
				Body      string `json:"body"`
				Hash      string `json:"hash"`
				CreatedBy string `json:"created_by,omitempty"`
			}
			if json.Unmarshal(ev.Payload, &p) != nil || p.Name == "" || p.Version <= 0 {
				continue
			}
			pr, ok := byName[p.Name]
			if !ok {
				pr = &Prompt{Name: p.Name}
				byName[p.Name] = pr
			}
			pr.Versions = append(pr.Versions, Version{
				Version: p.Version, Body: p.Body, Hash: p.Hash,
				CreatedAt: ev.OccurredAt, CreatedBy: p.CreatedBy,
			})
		case protocol.EventPromptLabeled:
			var l struct {
				Name    string `json:"name"`
				Label   string `json:"label"`
				Version int    `json:"version"`
			}
			if json.Unmarshal(ev.Payload, &l) != nil || l.Name == "" || l.Label == "" {
				continue
			}
			pr, ok := byName[l.Name]
			if !ok {
				pr = &Prompt{Name: l.Name}
				byName[l.Name] = pr
			}
			pr.Labels = append(pr.Labels, LabelRef{Label: l.Label, Version: l.Version, SetAt: ev.OccurredAt})
		}
	}
	for _, pr := range byName {
		sort.Slice(pr.Versions, func(i, j int) bool { return pr.Versions[i].Version < pr.Versions[j].Version })
		sort.Slice(pr.Labels, func(i, j int) bool { return pr.Labels[i].SetAt.Before(pr.Labels[j].SetAt) })
	}
	return byName
}

// NewCreatedEvent builds an append-ready prompt.created event. Version
// numbering is the caller's policy (count existing versions of the name).
func NewCreatedEvent(eventID, workstreamID, name, body, createdBy string, at time.Time) (*protocol.Event, int, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, 0, fmt.Errorf("prompt name is required")
	}
	if body == "" {
		return nil, 0, fmt.Errorf("prompt body is required")
	}
	if len(body) > maxPromptBytes {
		return nil, 0, fmt.Errorf("prompt body exceeds %d bytes; store large prompts as files and reference them", maxPromptBytes)
	}
	hash := hashHex([]byte(body))
	payload, err := json.Marshal(map[string]any{
		"name": name, "version": 0, "body": body, "hash": hash, "created_by": createdBy,
	})
	if err != nil {
		return nil, 0, err
	}
	ev := &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       eventID,
		OccurredAt:    at,
		ObservedAt:    at,
		WorkstreamID:  workstreamID,
		Kind:          protocol.EventPromptCreated,
		Provenance:    protocol.ProvenanceObserved,
		Payload:       payload,
	}
	return ev, 0, nil
}

// AssignVersion stamps the version number onto a prompt.created payload.
// The caller derives it from the derived view (existing versions + 1) BEFORE
// the event id/payload are finalized.
func AssignVersion(ev *protocol.Event, version int) error {
	var m map[string]any
	if err := json.Unmarshal(ev.Payload, &m); err != nil {
		return err
	}
	m["version"] = version
	raw, err := json.Marshal(m)
	if err != nil {
		return err
	}
	ev.Payload = raw
	return nil
}

// NewLabeledEvent builds an append-ready prompt.labeled event.
func NewLabeledEvent(eventID, workstreamID, name, label string, version int, at time.Time) (*protocol.Event, error) {
	name = strings.TrimSpace(name)
	label = strings.TrimSpace(strings.ToLower(label))
	if name == "" || label == "" {
		return nil, fmt.Errorf("prompt name and label are required")
	}
	if version <= 0 {
		return nil, fmt.Errorf("label version must be positive")
	}
	payload, err := json.Marshal(map[string]any{"name": name, "label": label, "version": version})
	if err != nil {
		return nil, err
	}
	return &protocol.Event{
		SchemaVersion: protocol.SchemaVersionEvent,
		EventID:       eventID,
		OccurredAt:    at,
		ObservedAt:    at,
		WorkstreamID:  workstreamID,
		Kind:          protocol.EventPromptLabeled,
		Provenance:    protocol.ProvenanceObserved,
		Payload:       payload,
	}, nil
}

// Links returns event ids whose payloads reference a prompt name (and
// optionally version) — the prompt↔trace linkage view.
func Links(events []*protocol.Event, name string, version int) []string {
	var out []string
	for _, ev := range events {
		if ev.Kind == protocol.EventPromptCreated || ev.Kind == protocol.EventPromptLabeled {
			continue
		}
		var m map[string]any
		if json.Unmarshal(ev.Payload, &m) != nil {
			continue
		}
		refs := false
		for _, key := range []string{"prompt_name", "prompt.name", "langfuse.observation.prompt.name"} {
			if v, ok := m[key].(string); ok && v == name {
				refs = true
			}
		}
		if !refs || version <= 0 {
			if refs {
				out = append(out, ev.EventID)
			}
			continue
		}
		for _, key := range []string{"prompt_version", "prompt.version"} {
			if v, ok := m[key].(float64); ok && int(v) == version {
				out = append(out, ev.EventID)
			}
		}
	}
	sort.Strings(out)
	return out
}

func hashHex(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}
