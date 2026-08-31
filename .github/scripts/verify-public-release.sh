#!/usr/bin/env bash

set -euo pipefail

fail() {
  echo "public release verification failed: $*" >&2
  exit 1
}

canonical_repository="handoffgraph/handoffgraph"
repository="${1:-}"
release_tag="${2:-}"
assets_dir="${3:-}"
expected_commit="${4:-}"

if [[ "${repository}" != "${canonical_repository}" ]]; then
  fail "repository must be ${canonical_repository}, got ${repository:-<empty>}"
fi
if [[ ! "${release_tag}" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]]; then
  fail "tag must be strict SemVer with a leading v, got ${release_tag:-<empty>}"
fi
if [[ -z "${assets_dir}" || ! -d "${assets_dir}" ]]; then
  fail "asset directory does not exist: ${assets_dir:-<empty>}"
fi
if [[ ! "${expected_commit}" =~ ^[0-9a-f]{40}$ ]]; then
  fail "expected source commit must be a lowercase 40-hex SHA"
fi
command -v gh >/dev/null 2>&1 || fail "gh is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"
[[ -n "${GH_TOKEN:-}" ]] || fail "GH_TOKEN is required"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bash "${script_dir}/verify-release-assets.sh" "${release_tag}" "${assets_dir}"

release_response="$(gh api \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/${repository}/releases/tags/${release_tag}")" || fail "GitHub release lookup failed"
release_id="$(jq -er --arg tag "${release_tag}" \
  'select(type == "object" and .tag_name == $tag and .draft == false and .immutable == true) | .id | select(type == "number" and . > 0 and floor == .)' \
  <<<"${release_response}")" || fail "release is not a published immutable release"

# gh release verify performs GitHub's cryptographic release-attestation check.
# Keep the JSON only as a syntactic receipt: its internal Sigstore schema is
# owned by GitHub and must not be guessed here. The exact tag commit and seven
# asset subjects are bound independently below by the GitHub API and
# verify-asset, respectively.
attestation_file="$(mktemp "${TMPDIR:-/tmp}/handoffgraph-release-attestation.XXXXXX")"
cleanup() {
  rm -f -- "${attestation_file}"
}
trap cleanup EXIT
if ! gh release verify "${release_tag}" --repo "${repository}" --format json >"${attestation_file}"; then
  fail "GitHub release attestation verification failed"
fi
jq -e 'type == "array" or type == "object"' "${attestation_file}" >/dev/null \
  || fail "GitHub release attestation output was not valid JSON"

tag_response="$(gh api \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/${repository}/git/ref/tags/${release_tag}")" || fail "GitHub tag lookup failed"
tag_type="$(jq -er 'select(type == "object" and (.object.type == "tag" or .object.type == "commit")) | .object.type' <<<"${tag_response}")" \
  || fail "GitHub tag reference was malformed"
tag_object_sha="$(jq -er '.object.sha | select(type == "string" and test("^[0-9a-f]{40}$"))' <<<"${tag_response}")" \
  || fail "GitHub tag reference SHA was malformed"
[[ "${tag_type}" == "tag" ]] || fail "published release tag must be an annotated tag object"
annotated_response="$(gh api \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/${repository}/git/tags/${tag_object_sha}")" || fail "GitHub annotated tag lookup failed"
tag_commit="$(jq -er 'select(type == "object" and .object.type == "commit") | .object.sha | select(type == "string" and test("^[0-9a-f]{40}$"))' <<<"${annotated_response}")" \
  || fail "GitHub annotated tag target was malformed"
[[ "${tag_commit}" == "${expected_commit}" ]] || fail "published tag commit ${tag_commit} does not match ${expected_commit}"

bash "${script_dir}/verify-release-assets.sh" \
  --require-github-release-assets \
  "${repository}" \
  "${release_tag}" \
  "${assets_dir}" \
  published \
  "${release_id}"

release_version="${release_tag#v}"
assets=(
  "checksums.txt"
  "handoffgraph_${release_version}_darwin_amd64.tar.gz"
  "handoffgraph_${release_version}_darwin_arm64.tar.gz"
  "handoffgraph_${release_version}_linux_amd64.tar.gz"
  "handoffgraph_${release_version}_linux_arm64.tar.gz"
  "handoffgraph_${release_version}_windows_amd64.zip"
  "handoffgraph_${release_version}_windows_arm64.zip"
)
for asset in "${assets[@]}"; do
  [[ -f "${assets_dir}/${asset}" && ! -L "${assets_dir}/${asset}" ]] || fail "public asset is missing or not a regular file: ${asset}"
  gh release verify-asset "${release_tag}" "${assets_dir}/${asset}" \
    --repo "${repository}" >/dev/null \
    || fail "GitHub asset attestation verification failed for ${asset}"
done

echo "public immutable release verified for ${repository}@${release_tag}: exact tag commit, seven downloaded assets, release attestation, and per-asset attestations"
