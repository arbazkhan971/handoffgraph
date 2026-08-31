#!/usr/bin/env bash

set -euo pipefail

fail() {
  echo "remote release tag verification failed: $*" >&2
  exit 1
}

remote="${1:-}"
release_tag="${2:-}"
expected_commit="${3:-}"
expected_tag_object="${4:-}"

if [[ -z "${remote}" || -z "${release_tag}" ]]; then
  fail "remote and tag are required"
fi
if [[ ! "${release_tag}" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]]; then
  fail "tag must be strict SemVer with a leading v, got ${release_tag}"
fi
if [[ ! "${expected_commit}" =~ ^[0-9a-f]{40}$ ]]; then
  fail "expected peeled commit must be a lowercase 40-hex SHA"
fi
if [[ ! "${expected_tag_object}" =~ ^[0-9a-f]{40}$ ]]; then
  fail "expected annotated tag object must be a lowercase 40-hex SHA"
fi

tag_ref="refs/tags/${release_tag}"
peeled_ref="${tag_ref}^{}"
if ! remote_refs="$(git ls-remote "${remote}" "${tag_ref}" "${peeled_ref}")"; then
  fail "could not query ${remote}"
fi

tag_object=""
peeled_commit=""
line_count=0
while IFS=$'\t' read -r object ref; do
  [[ -n "${object}" && -n "${ref}" ]] || fail "malformed remote ref response"
  [[ "${object}" =~ ^[0-9a-f]{40}$ ]] || fail "remote ref ${ref} did not return a 40-hex SHA"
  case "${ref}" in
    "${tag_ref}")
      [[ -z "${tag_object}" ]] || fail "duplicate annotated tag ref ${tag_ref}"
      tag_object="${object}"
      ;;
    "${peeled_ref}")
      [[ -z "${peeled_commit}" ]] || fail "duplicate peeled tag ref ${peeled_ref}"
      peeled_commit="${object}"
      ;;
    *)
      fail "unexpected remote ref ${ref}"
      ;;
  esac
  line_count=$((line_count + 1))
done <<< "${remote_refs}"

if [[ "${line_count}" -ne 2 || -z "${tag_object}" || -z "${peeled_commit}" ]]; then
  fail "remote tag must be one annotated object plus one peeled commit"
fi
if [[ "${tag_object}" != "${expected_tag_object}" ]]; then
  fail "remote annotated tag object ${tag_object} does not match local object ${expected_tag_object}"
fi
if [[ "${peeled_commit}" != "${expected_commit}" ]]; then
  fail "remote tag commit ${peeled_commit} does not match expected commit ${expected_commit}"
fi

echo "remote annotated tag verified for ${release_tag}: object ${tag_object}, commit ${peeled_commit}"
