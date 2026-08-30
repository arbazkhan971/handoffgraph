# Releasing HandoffGraph

HandoffGraph releases are immutable, checksummed CLI archives built from a
SemVer tag. GitHub Actions and GoReleaser build Linux, macOS, and Windows
binaries for `amd64` and `arm64`; Windows artifacts are ZIP files and the
others are `tar.gz` files.

## One-time prerequisite

The canonical Go module is `github.com/handoffgraph/handoffgraph`. Before the
first public tag, the GitHub repository must exist at that location (prefer an
owner transfer so repository identity and redirects survive). Until it does,
the public `go install ...@version` path
cannot resolve even if a release exists in a differently named repository.
The tag workflow enforces this match and fails before publishing from a fork
or temporary personal repository.

Enable GitHub immutable releases on the canonical repository before pushing
the first tag. The workflow checks the repository setting through GitHub's
versioned REST API before it uploads a draft and again immediately before
promotion. A missing, disabled, or malformed response fails closed, leaving
the release unpublished.

Add a canonical-repository Actions secret named `RELEASE_ADMIN_TOKEN` for
those read-only setting checks. Use a fine-grained token restricted to
`handoffgraph/handoffgraph` with **Administration: read** (and the automatic
Metadata read permission); do not grant content write through this token. The
ordinary per-run `GITHUB_TOKEN` remains the only credential used to create the
draft, download its assets, and promote it.

Do not change `go.mod` to a temporary personal fork path. The module path is a
durable public API and must match the long-term repository location.

This first public baseline includes syntax-only D1 parser repairs in migrations
0003, 0004, and 0008. Because an isolated staging database already records
those migration names, the release gate must prove both a fresh 0001–0022
chain and a no-pending/foreign-key-clean existing staging ledger. After the
first public tag, shipped migration files are immutable; all later changes use
new numbered migrations.

## Preflight

Start from a clean, up-to-date `main`, then run the same gates as CI:

```bash
go build ./...
go build -trimpath \
  -ldflags "-X github.com/handoffgraph/handoffgraph/internal/buildinfo.version=0.7.0-beta.1" \
  -o /tmp/handoffgraph-beta-candidate ./cmd/handoffgraph
/tmp/handoffgraph-beta-candidate version
/tmp/handoffgraph-beta-candidate --help
go vet ./...
test -z "$(gofmt -l .)"
go mod tidy -diff
go test ./...
go test -race ./...
(cd web && npm ci && npm test && npm run lint && npm run build)
git diff --exit-code -- internal/webui/dist
(cd platform && npm ci && npm test && npm run typecheck && \
  ./node_modules/.bin/wrangler d1 migrations apply handoffgraph --local \
    --persist-to "$(mktemp -d)" && \
  npm run deploy:dry && npm run deploy:dry:staging)
node --test landing/*.test.mjs
(cd platform && ./node_modules/.bin/wrangler deploy --dry-run \
  --config ../landing/wrangler.toml --outdir "$(mktemp -d)")
goreleaser check
goreleaser release --snapshot --clean
(cd dist && shasum -a 256 -c checksums.txt)
test "$(find dist -maxdepth 1 -type f \( -name '*.tar.gz' -o -name '*.zip' \) | wc -l | tr -d ' ')" = 6
bash .github/scripts/check-action-pins.sh
bash .github/scripts/validate-release-tag.test.sh
bash .github/scripts/verify-release-assets.test.sh
```

Use the GoReleaser version pinned in the CI and release workflows (currently
v2.17.1) so local and hosted artifact generation use the same schema and
defaults.

The snapshot command exercises every release target without publishing. Check
that `dist/checksums.txt` verifies and that an extracted binary reports a
non-development version. CI performs the Linux archive check automatically.

## Publish

1. Confirm the release gate in [ROADMAP.md](../ROADMAP.md) is complete and
   add a reviewed, non-empty `docs/releases/<tag>.md` covering migrations,
   compatibility, and known gaps. The publish job passes this exact file to
   GoReleaser and will not fall back to an unreviewed first-tag commit dump.
2. Confirm immutable releases are enabled on
   `github.com/handoffgraph/handoffgraph`. This setting applies only to future
   releases, so it must be active before the prerelease is published.
3. Freeze `main`, confirm local `HEAD` equals `origin/main`, and record that
   approved commit SHA. The release policy requires the tag to resolve to the
   current remote `main` HEAD, not merely an older ancestor.
4. Create an annotated strict-SemVer tag with a leading `v`, for example
   `git tag -a v0.7.0-beta.1 -m "HandoffGraph v0.7.0-beta.1"`.
5. Push that exact tag: `git push origin v0.7.0-beta.1`.
6. The read-only `validate` job reruns the Go/web/platform gates and Worker
   dry-runs, builds and checks all six snapshot archives, and verifies action
   pins. Only after it succeeds does the minimal `publish` job receive
   `contents: write`, reconfirm the tag is current `main`, and ask GoReleaser
   to upload an unpublished draft with the tag-derived version and SHA-256
   checksums.
7. The publish job downloads that draft and requires exactly six expected
   platform archives plus `checksums.txt`. It verifies every digest and archive
   inventory, then checks the Linux amd64 binary's exact version, help header,
   and `doctor` result with a throwaway `HFG_DATA_DIR`.
8. The same job performs two independent `GOPROXY=direct` installs of
   `github.com/handoffgraph/handoffgraph/cmd/handoffgraph@v0.7.0-beta.1` with
   fresh module and build caches and `GOFLAGS=-trimpath`. Both binaries must
   report the exact tag, pass `doctor`, and have identical SHA-256 hashes.
9. Only after another tag/main and immutable-setting check does the workflow
   promote the draft to a prerelease. A final REST read must prove that it is
   published, marked as a prerelease, bound to the requested tag, and
   immutable. Independently downloading and checking an archive remains a
   useful release-owner smoke test, but is no longer the publication gate.

Never move or reuse a published tag. If a release is bad, document it and ship
a new patch tag.
