#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
validator="${script_dir}/verify-remote-release-tag.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/handoffgraph-remote-tag.XXXXXX")"
cleanup() {
  rm -rf -- "${test_root}" "${test_root}.git"
}
trap cleanup EXIT

git -C "${test_root}" init -q -b main
git -C "${test_root}" config user.name "HandoffGraph Release Test"
git -C "${test_root}" config user.email "release-test@handoffgraph.dev"
git -C "${test_root}" config commit.gpgsign false
git -C "${test_root}" config tag.gpgsign false
git -C "${test_root}" commit -q --allow-empty -m "release commit"
commit="$(git -C "${test_root}" rev-parse HEAD)"
git -C "${test_root}" tag -a v0.8.0-beta.1 -m "HandoffGraph v0.8.0-beta.1"
tag_object="$(git -C "${test_root}" rev-parse refs/tags/v0.8.0-beta.1)"
git clone -q --bare "${test_root}" "${test_root}.git"

expect_pass() {
  local label="$1"
  shift
  if ! output="$(bash "${validator}" "$@" 2>&1)"; then
    echo "expected pass (${label}), got: ${output}" >&2
    exit 1
  fi
}

expect_fail() {
  local label="$1"
  shift
  if output="$(bash "${validator}" "$@" 2>&1)"; then
    echo "expected failure (${label}), got: ${output}" >&2
    exit 1
  fi
}

expect_pass "annotated tag" "${test_root}.git" v0.8.0-beta.1 "${commit}" "${tag_object}"
wrong_commit="0${commit:1}"
if [[ "${wrong_commit}" == "${commit}" ]]; then
  wrong_commit="1${commit:1}"
fi
expect_fail "wrong expected commit" "${test_root}.git" v0.8.0-beta.1 "${wrong_commit}" "${tag_object}"
expect_fail "wrong local tag object" "${test_root}.git" v0.8.0-beta.1 "${commit}" "${commit}"

git -C "${test_root}" tag v0.8.1
git -C "${test_root}" push -q "${test_root}.git" refs/tags/v0.8.1
lightweight_object="$(git -C "${test_root}" rev-parse refs/tags/v0.8.1)"
expect_fail "lightweight tag" "${test_root}.git" v0.8.1 "${commit}" "${lightweight_object}"

git -C "${test_root}" commit -q --allow-empty -m "moved tag target"
moved_commit="$(git -C "${test_root}" rev-parse HEAD)"
git -C "${test_root}" tag -f -a v0.8.0-beta.1 -m "moved" >/dev/null
git -C "${test_root}" push -q --force "${test_root}.git" refs/tags/v0.8.0-beta.1
expect_fail "moved remote tag" "${test_root}.git" v0.8.0-beta.1 "${commit}" "${tag_object}"
test "${moved_commit}" != "${commit}"

echo "remote release tag verification tests passed"
