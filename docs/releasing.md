# Releasing HandoffGraph

HandoffGraph releases are immutable, checksummed CLI archives built from a
SemVer tag. GitHub Actions and GoReleaser build Linux, macOS, and Windows
binaries for `amd64` and `arm64`; Windows artifacts are ZIP files and the
others are `tar.gz` files.

## One-time prerequisite

The canonical Go module is `github.com/handoffgraph/handoffgraph`. Before the
first public tag, the GitHub repository must exist at that location (by
transfer or mirror). Until it does, the public `go install ...@version` path
cannot resolve even if a release exists in a differently named repository.
The tag workflow enforces this match and fails before publishing from a fork
or temporary personal repository.

Do not change `go.mod` to a temporary personal fork path. The module path is a
durable public API and must match the long-term repository location.

## Preflight

Start from a clean, up-to-date `main`, then run the same gates as CI:

```bash
go build ./...
go vet ./...
test -z "$(gofmt -l .)"
go test ./...
go test -race ./...
(cd web && npm ci && npm test && npm run lint && npm run build)
git diff --exit-code -- internal/webui/dist
(cd platform && npm ci && npm test && npm run typecheck && npm run deploy:dry)
node --test landing/*.test.mjs
(cd platform && ./node_modules/.bin/wrangler deploy --dry-run \
  --config ../landing/wrangler.toml --outdir "$(mktemp -d)")
goreleaser check
goreleaser release --snapshot --clean
```

Use the GoReleaser version pinned in the CI and release workflows (currently
v2.17.1) so local and hosted artifact generation use the same schema and
defaults.

The snapshot command exercises every release target without publishing. Check
that `dist/checksums.txt` verifies and that an extracted binary reports a
non-development version. CI performs the Linux archive check automatically.

## Publish

1. Confirm the release gate in [ROADMAP.md](../ROADMAP.md) is complete and
   prepare release notes covering migrations, compatibility, and known gaps.
2. Create an annotated SemVer tag with a leading `v`, for example
   `git tag -a v0.7.0 -m "HandoffGraph v0.7.0"`.
3. Push that exact tag: `git push origin v0.7.0`.
4. The `Release` workflow requires the tag commit to be reachable from `main`,
   reruns the Go/web/platform gates and Worker dry-runs, builds all six target
   binaries, injects the tag-derived version, generates SHA-256 checksums, and
   publishes the GitHub release.
5. Download one archive, verify it against `checksums.txt`, then smoke-test
   `handoffgraph version`, `handoffgraph --help`, and `handoffgraph doctor`
   with a throwaway `HFG_DATA_DIR`.
6. Once the canonical repository exists, verify the module distribution path:
   `go install github.com/handoffgraph/handoffgraph/cmd/handoffgraph@v0.7.0`.

Never move or reuse a published tag. If a release is bad, document it and ship
a new patch tag.
