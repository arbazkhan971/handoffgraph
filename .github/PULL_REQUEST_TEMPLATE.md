<!--
Thanks for the PR! Keep it small and single-purpose; reference the issue
it closes. Ground rules from AGENTS.md apply: append-only events,
deterministic reducers (sort before emitting), fail-closed redaction,
provenance preserved, ULIDs via internal/ids, money as decimal strings.
See CONTRIBUTING.md before submitting.
-->

## What

One-paragraph summary of the change.

## Why

The problem or request this addresses (link the issue: `Closes #N`).

## How

Key implementation points a reviewer should look at first.

## Ground-rule check

- [ ] Events remain append-only; no stored event is mutated
- [ ] Reducers/materializers stay deterministic — sorted output, no
      map-iteration-order leakage
- [ ] Redaction is fail-closed (errors block export; never warn-and-export)
- [ ] Provenance labels (`OBSERVED`/`DECLARED`/`INFERRED`) are preserved
- [ ] IDs use `internal/ids` (ULID + prefix); deterministic where re-import
      idempotency matters
- [ ] Money/cost (if touched) is a decimal string with a provenance label
- [ ] Adapter changes (if any) install hooks idempotently and never
      overwrite user hook config

## Testing

- [ ] New behavior covered by table-driven tests
- [ ] Golden fixture added/updated under `testdata/fixtures/` (and the
      fixtures README + expected file count in `internal/verify` if a
      top-level file was added/removed)
- [ ] `gofmt -l .` prints nothing; `go vet ./...` is clean
- [ ] `go test ./...` and `go test -race ./...` pass locally
- [ ] 10k-ingestion / idempotency / out-of-order / deterministic-hash
      property tests still green

## Evidence

Paste the exact commands run and their outcome (test names + pass/fail),
plus `fixture verify` output if fixtures changed.
