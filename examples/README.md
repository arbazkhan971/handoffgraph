# Examples

Realistic, machine-generated examples of the two artifacts HandoffGraph
emits for a workstream. Both files were produced by the actual local-core
code paths — they are not hand-drawn — using the golden fixture
[`testdata/fixtures/mixed-providers.jsonl`](../testdata/fixtures/mixed-providers.jsonl)
(a Claude session that hits its context limit, hands off to Codex via a
checkpoint, and is finally reviewed by Pi, all in one workstream).

| File | What it is | Producing command |
|---|---|---|
| [`workstream-checkpoint.json`](workstream-checkpoint.json) | A portable checkpoint (`hfg.checkpoint.v1`) built by the evidence-first, model-free builder. | `handoffgraph checkpoint --workstream <id> --objective "stabilize token refresh"` |
| [`workstream-graph.json`](workstream-graph.json) | The derived workstream graph (`{"nodes": [...], "edges": [...]}`), deterministically reduced from the append-only event log. | `handoffgraph graph --json` |

## Reading the checkpoint

- Every evidence item (decision, file, command, test) carries the event IDs
  in `evidence_refs` that support it — nothing in the file is unevidenced.
- `provenance` is preserved end-to-end: decisions are `DECLARED` (an agent
  or user asserted them), files/commands/tests are `OBSERVED` (captured from
  hooks, tools, or Git state). An inferred value would be `INFERRED`; the
  UI must render the labels distinctly.
- `integrity.graph_root_hash` is the deterministic hash of the normalized
  graph in `workstream-graph.json`; `integrity.score` is the transparent
  handoff-quality score (0–100, weights documented in
  `internal/checkpoint/checkpoint.go`). Here it is **70**: objective (10) +
  repository state (10) + dirty worktree/changed files (15) + decisions
  (10) + commands (10) + a test with an observed exit code (15). The
  remaining 30 points require failed approaches, next actions, and the
  handoff-time target/repository checks.
- Money/cost figures, when present in real checkpoints, are decimal strings
  with a provenance label — never floats, never unlabeled.

## Reading the graph

- Nodes and edges are emitted sorted (nodes by `id`, edges by
  `source`, `relation`, `target`) so the export — and its root hash — are
  byte-stable for the same event log regardless of delivery order.
- The cross-agent story is visible in the edges: all three session nodes
  `BELONGS_TO` the one workstream node, the resumed Codex session carries a
  `CAUSED` edge from the `handoff.created` event, and the reviewer's
  decision is `BASED_ON` evidence events from both earlier agents.
- Some edges reference event IDs that have no node of their own (for
  example the `handoff.created` event); the reducer preserves the reference
  rather than dropping or inventing structure.

## Reproducing

```bash
export HFG_DATA_DIR=$(mktemp -d)   # never pollute ~/.handoffgraph
handoffgraph init
WS=$(handoffgraph workstream new "stabilize token refresh")
handoffgraph event import testdata/fixtures/mixed-providers.jsonl
handoffgraph graph --json                # -> workstream-graph.json content
handoffgraph checkpoint --workstream "$WS" --objective "stabilize token refresh"
```

The only difference you will see is the freshly minted `checkpoint_id`
(ULIDs encode time) and Markdown rendering the CLI prints alongside the
JSON.
