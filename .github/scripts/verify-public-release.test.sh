#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
validator="${script_dir}/verify-public-release.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/handoffgraph-public-release.XXXXXX")"
cleanup() {
  rm -rf -- "${test_root}"
}
trap cleanup EXIT

expect_fail() {
  local label="$1"
  shift
  if output="$(bash "${validator}" "$@" 2>&1)"; then
    echo "expected failure (${label}), got: ${output}" >&2
    exit 1
  fi
}

expect_fail "wrong repository" example/handoffgraph v0.8.0-beta.1 "${test_root}" "$(printf 'a%.0s' {1..40})"
expect_fail "invalid tag" handoffgraph/handoffgraph 0.8.0-beta.1 "${test_root}" "$(printf 'a%.0s' {1..40})"
expect_fail "invalid source SHA" handoffgraph/handoffgraph v0.8.0-beta.1 "${test_root}" not-a-sha
expect_fail "missing asset directory" handoffgraph/handoffgraph v0.8.0-beta.1 "${test_root}/missing" "$(printf 'a%.0s' {1..40})"

grep -Fq 'gh release verify ' "${validator}"
grep -Fq 'gh release verify-asset ' "${validator}"
grep -Fq 'verify-release-assets.sh' "${validator}"
grep -Fq 'git/ref/tags/' "${validator}"
grep -Fq 'published release tag must be an annotated tag object' "${validator}"

echo "public release verification contract tests passed"
