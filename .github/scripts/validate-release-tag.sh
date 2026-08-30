#!/usr/bin/env bash

set -euo pipefail

canonical_repository="handoffgraph/handoffgraph"
repository="${1:-${GITHUB_REPOSITORY:-}}"
release_tag="${2:-${GITHUB_REF_NAME:-}}"
release_ref="${3:-${GITHUB_SHA:-}}"
main_ref="${4:-origin/main}"

fail() {
  echo "release validation failed: $*" >&2
  exit 1
}

if [[ "${repository}" != "${canonical_repository}" ]]; then
  fail "repository must be ${canonical_repository}, got ${repository:-<empty>}"
fi

# SemVer 2.0.0 with a mandatory leading v. The shape check rejects empty
# identifiers; the loop below enforces the no-leading-zero rule for numeric
# prerelease identifiers.
semver_pattern='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-([0-9A-Za-z-]+)(\.[0-9A-Za-z-]+)*)?(\+([0-9A-Za-z-]+)(\.[0-9A-Za-z-]+)*)?$'
if [[ ! "${release_tag}" =~ ${semver_pattern} ]]; then
  fail "tag must be strict SemVer with a leading v, got ${release_tag:-<empty>}"
fi

tag_ref="refs/tags/${release_tag}"
if ! git rev-parse --verify --quiet --end-of-options "${tag_ref}" >/dev/null; then
  fail "annotated tag ref does not exist: ${tag_ref}"
fi
if [[ "$(git cat-file -t "${tag_ref}")" != "tag" ]]; then
  fail "release tag must be an annotated tag object: ${tag_ref}"
fi

version_without_build="${release_tag%%+*}"
if [[ "${version_without_build}" == *-* ]]; then
  prerelease="${version_without_build#*-}"
  IFS='.' read -r -a prerelease_identifiers <<< "${prerelease}"
  for identifier in "${prerelease_identifiers[@]}"; do
    if [[ "${identifier}" =~ ^[0-9]+$ && "${identifier}" != "0" && "${identifier}" == 0* ]]; then
      fail "numeric prerelease identifiers must not contain leading zeroes: ${identifier}"
    fi
  done
fi

if ! release_commit="$(git rev-parse --verify --end-of-options "${release_ref}^{commit}" 2>/dev/null)"; then
  fail "release ref does not resolve to a commit: ${release_ref:-<empty>}"
fi
tag_commit="$(git rev-parse --verify --end-of-options "${tag_ref}^{commit}")"
if [[ "${release_commit}" != "${tag_commit}" ]]; then
  fail "release ref ${release_commit} does not match annotated tag commit ${tag_commit}"
fi
if ! main_commit="$(git rev-parse --verify --end-of-options "${main_ref}^{commit}" 2>/dev/null)"; then
  fail "main ref does not resolve to a commit: ${main_ref:-<empty>}"
fi

if [[ "${release_commit}" != "${main_commit}" ]]; then
  fail "tag commit ${release_commit} must equal current main HEAD ${main_commit}"
fi

echo "release validation passed for ${repository}@${release_tag} (${release_commit})"
