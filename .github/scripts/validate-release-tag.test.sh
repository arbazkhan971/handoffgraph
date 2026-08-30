#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
validator="${script_dir}/validate-release-tag.sh"
test_repository="$(mktemp -d "${TMPDIR:-/tmp}/handoffgraph-release-policy.XXXXXX")"

cleanup() {
  rm -rf -- "${test_repository}"
}
trap cleanup EXIT

git -C "${test_repository}" init -q -b main
git -C "${test_repository}" config user.name "HandoffGraph Release Test"
git -C "${test_repository}" config user.email "release-test@handoffgraph.dev"
git -C "${test_repository}" config commit.gpgsign false
git -C "${test_repository}" config tag.gpgsign false
git -C "${test_repository}" commit -q --allow-empty -m "older commit"
older_commit="$(git -C "${test_repository}" rev-parse HEAD)"
git -C "${test_repository}" commit -q --allow-empty -m "release commit"
main_commit="$(git -C "${test_repository}" rev-parse HEAD)"
git -C "${test_repository}" update-ref refs/remotes/origin/main "${main_commit}"
git -C "${test_repository}" tag -a v0.7.0-beta.1 -m "HandoffGraph v0.7.0-beta.1"
annotated_tag="$(git -C "${test_repository}" rev-parse refs/tags/v0.7.0-beta.1)"
git -C "${test_repository}" tag -a v1.2.3+build.001 -m "stable build metadata"
stable_tag="$(git -C "${test_repository}" rev-parse refs/tags/v1.2.3+build.001)"
git -C "${test_repository}" tag -a v1.2.3-01a -m "alphanumeric prerelease"
alphanumeric_tag="$(git -C "${test_repository}" rev-parse refs/tags/v1.2.3-01a)"
git -C "${test_repository}" tag v2.0.0

expect_pass() {
  local label="$1"
  shift
  if ! output="$(cd "${test_repository}" && bash "${validator}" "$@" 2>&1)"; then
    echo "expected pass (${label}), got: ${output}" >&2
    exit 1
  fi
}

expect_fail() {
  local label="$1"
  shift
  if output="$(cd "${test_repository}" && bash "${validator}" "$@" 2>&1)"; then
    echo "expected failure (${label}), got: ${output}" >&2
    exit 1
  fi
}

expect_pass "annotated beta tag" \
  handoffgraph/handoffgraph v0.7.0-beta.1 "${annotated_tag}" origin/main
expect_pass "stable tag with build metadata" \
  handoffgraph/handoffgraph v1.2.3+build.001 "${stable_tag}" origin/main
expect_pass "alphanumeric prerelease" \
  handoffgraph/handoffgraph v1.2.3-01a "${alphanumeric_tag}" origin/main

expect_fail "wrong repository" \
  example/handoffgraph v0.7.0-beta.1 "${main_commit}" origin/main
expect_fail "missing v prefix" \
  handoffgraph/handoffgraph 0.7.0-beta.1 "${main_commit}" origin/main
expect_fail "core leading zero" \
  handoffgraph/handoffgraph v01.2.3 "${main_commit}" origin/main
expect_fail "numeric prerelease leading zero" \
  handoffgraph/handoffgraph v1.2.3-01 "${main_commit}" origin/main
expect_fail "lightweight tag" \
  handoffgraph/handoffgraph v2.0.0 "${main_commit}" origin/main
expect_fail "empty prerelease identifier" \
  handoffgraph/handoffgraph v1.2.3-alpha..1 "${main_commit}" origin/main
expect_fail "trailing prerelease separator" \
  handoffgraph/handoffgraph v1.2.3-. "${main_commit}" origin/main
expect_fail "tag is not main HEAD" \
  handoffgraph/handoffgraph v0.7.0-beta.1 "${older_commit}" origin/main
expect_fail "missing release ref" \
  handoffgraph/handoffgraph v0.7.0-beta.1 deadbeef origin/main

echo "release tag validation tests passed"
