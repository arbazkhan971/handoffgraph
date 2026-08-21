# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project

HandoffGraph is a local-first, verified cross-agent continuity and
session-debugging layer for AI coding agents. Go CLI + core; TypeScript
(Cloudflare) and React/Vite (UI) come in later versions.

## Conventions

- Go 1.24+, Apache-2.0. Module path: `github.com/handoffgraph/handoffgraph`.
- All durable IDs are ULIDs via `internal/ids`. Never hand-roll IDs.
- Events are append-only. Do not mutate stored events; derive read models.
- The graph reducer and trace materializer must stay deterministic: do not
  introduce map-iteration-order dependence into their output. Sort before
  emitting.
- Redaction is fail-closed. Never "warn and export original" on a redaction
  error.
- Provenance (`OBSERVED`/`DECLARED`/`INFERRED`) must be preserved; never
  present an inferred value as observed.
- Money/cost is a decimal string, never a float.
- Adapter installs must be idempotent and fail-closed: never overwrite
  existing user hook config (`ErrHookConflict`); derived event IDs must be deterministic so re-import is idempotent.

## Commands

```bash
go build ./...
go test ./...
go test -race ./...
go vet ./...
gofmt -l .
```

## Test expectations

- New behavior needs a test. Golden fixtures live under `testdata/fixtures/`
  (add them alongside feature work).
- The 10,000-event ingestion, idempotency, out-of-order, crash/reopen, and
  deterministic-hash properties are non-negotiable.

## Layout

See `docs/architecture.md`. The `internal/` packages are intentionally
layered to avoid import cycles: `fixture` (leaf) → `storage`/`graph` →
`verify` (top).
