# Golden fixtures (`testdata/fixtures/`)

One JSONL file = one captured session slice (or a delivery pathology).
Each non-empty line is a JSON object; canonical fixtures carry the
`hfg.event.v1` envelope (`internal/protocol/event.go`). Fixtures are the
shared language between the CLI, the verify harness, and CI — treat them
as test data, not as documentation prose.

## Verify contract

```bash
go run ./cmd/handoffgraph fixture verify testdata/fixtures
```

Every top-level fixture **must** import cleanly (parse + append +
deterministic graph rebuild), with exactly **one deliberate exception**:

- `truncated.jsonl` **must FAIL with exactly one bad-line error** — its
  final line is cut mid-JSON (a crash-mid-write spool). Its four complete
  lines still import; the truncated line surfaces as a verification
  failure instead of being silently rewritten. **This failure is the
  fixture's contract**; a run that reports zero failures for it is a bug.

Intentionally malformed fixtures that must *never* import live in the
`invalid/` subtree (the top-level `*.jsonl` glob wins over the recursive
walk, so they are excluded from directory verification).

Duplicate event IDs are not an error: the store is idempotent
(`INSERT OR IGNORE` on `event_id`), so duplicate-delivery fixtures import
with fewer appended events than lines.

## Top-level fixtures

| File | Scenario | Notes |
|---|---|---|
| `claude-full-session.jsonl` | Full claude turn: prompt → tools (incl. failure) → compaction → end | 15 lines, claude |
| `claude.jsonl` | Claude session: decision, file edit, failing test | The original golden fixture |
| `claude_tool_success.jsonl` | Claude tool call succeeds | |
| `claude_tool_failure.jsonl` | Claude tool call fails | |
| `codex_hook_events.jsonl` | Canonical codex hook events (`hfg.event.v1`) | |
| `codex_session.jsonl` | Native codex rollout transcript | Native format, swept on import |
| `codex_session_2.jsonl` | Second native codex rollout | |
| `codex-duplicate-delivery.jsonl` | Hook re-delivers two events byte-identically | 8 lines → 6 appended, 0 errors |
| `out_of_order.jsonl` | Delivery order ≠ `occurred_at` order | Root hash is order-independent |
| `out-of-order.jsonl` | Out-of-order delivery (observed-at lag, too) | Sequences 6,2,4,1,5,3 |
| `orphan_spans.jsonl` | Dangling parent/trace references (pi) | Reduces deterministically |
| `orphan-spans.jsonl` | Orphan spans + completed-without-started span | |
| `windows_paths.jsonl` | Windows path payloads + drive-letter remote | |
| `windows-paths.jsonl` | Backslash paths, UNC spool delete, `.\` args | |
| `large_object_ref.jsonl` | Big bodies stored as content-addressed refs | |
| `big-payload.jsonl` | One 64 KB base64 payload field inlined | Exercises the 16 MB scanner bound from below |
| `mixed-providers.jsonl` | claude → handoff → codex → pi in ONE workstream | Cross-agent continuity flagship; backs `examples/` |
| `invalid-utf8-attempt.jsonl` | Exotic but *valid* UTF-8/escapes (emoji, control chars, quotes) | Must pass — contrast with `invalid/utf8/` |
| `truncated.jsonl` | **Deliberately broken**: last line cut mid-JSON | Must fail with exactly 1 bad-line error |

(Inventories are as of this writing; parallel work adds fixtures — the
authoritative list is always the directory itself. The same applies to the
verify run: expect one failure per deliberately-broken top-level fixture,
zero otherwise.)

## `invalid/` subtree (must always fail)

| File | Malady | Contract |
|---|---|---|
| `invalid/truncated/truncated.jsonl` | Final line cut mid-JSON | Fails; only the 2 complete lines import |
| `invalid/utf8/invalid_utf8.jsonl` | Raw `0xFF` byte (invalid UTF-8) | Fails with a line-numbered error; 1 valid line imports |

## Conventions when adding a fixture

- Hand-craft realistic events; IDs follow `evt_`/`ws_`/`ses_` ULID prefixes
  and must be unique across the whole directory (verification imports all
  files into one shared store). Reserve a distinct ULID prefix block per
  fixture.
- Keep provenance honest: hooks/tools/Git state are `OBSERVED`, user or
  agent assertions are `DECLARED`, derived values `INFERRED`.
- If a fixture is *supposed* to fail, either put it in `invalid/` or
  document the exact expected failure here (see `truncated.jsonl`).
- Keep lines under 16 MB (the verifier's scanner bound).
- Update the table above and, if you add a top-level file, the expected
  file count in `internal/verify/verify_test.go`.
