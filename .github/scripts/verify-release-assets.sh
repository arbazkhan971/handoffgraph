#!/usr/bin/env bash

set -euo pipefail

fail() {
  echo "release asset verification failed: $*" >&2
  exit 1
}

canonical_repository="handoffgraph/handoffgraph"
semver_pattern='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-([0-9A-Za-z-]+)(\.[0-9A-Za-z-]+)*)?(\+([0-9A-Za-z-]+)(\.[0-9A-Za-z-]+)*)?$'

sha256_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${path}" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${path}" | awk '{ print $1 }'
  else
    fail "neither sha256sum nor shasum is available"
  fi
}

validate_canonical_release_identity() {
  local repository="$1"
  local release_tag="$2"
  if [[ "${repository}" != "${canonical_repository}" ]]; then
    fail "GitHub release assets must come from ${canonical_repository}, got ${repository:-<empty>}"
  fi
  if [[ ! "${release_tag}" =~ ${semver_pattern} ]]; then
    fail "tag must be strict SemVer with a leading v, got ${release_tag:-<empty>}"
  fi
}

require_github_query_tools() {
  if ! command -v gh >/dev/null 2>&1; then
    fail "gh is required to query GitHub releases"
  fi
  if ! command -v jq >/dev/null 2>&1; then
    fail "jq is required to validate GitHub releases"
  fi
  if [[ -z "${GH_TOKEN:-}" ]]; then
    fail "GH_TOKEN with repository Contents permission is required"
  fi
}

list_github_releases() {
  local repository="$1"
  gh api --paginate --slurp \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2026-03-10' \
    "repos/${repository}/releases?per_page=100"
}

if [[ "${1:-}" == "--require-immutable-releases" ]]; then
  repository="${2:-}"
  if [[ ! "${repository}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    fail "repository must be in owner/name form, got ${repository:-<empty>}"
  fi
  if ! command -v gh >/dev/null 2>&1; then
    fail "gh is required to query the immutable releases setting"
  fi
  if ! command -v jq >/dev/null 2>&1; then
    fail "jq is required to validate the immutable releases response"
  fi
  if [[ -z "${GH_TOKEN:-}" ]]; then
    fail "GH_TOKEN with repository Administration read permission is required"
  fi
  if ! immutable_response="$(gh api \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2026-03-10' \
    "repos/${repository}/immutable-releases")"; then
    fail "GitHub did not confirm immutable releases for ${repository}"
  fi
  if ! jq -e 'type == "object" and .enabled == true' \
    >/dev/null 2>&1 <<<"${immutable_response}"; then
    fail "GitHub immutable releases response is disabled or malformed for ${repository}"
  fi
  echo "immutable GitHub releases are enabled for ${repository}"
  exit 0
fi

if [[ "${1:-}" == "--resolve-github-draft-id" ]]; then
  repository="${2:-}"
  release_tag="${3:-}"
  validate_canonical_release_identity "${repository}" "${release_tag}"
  require_github_query_tools
  if ! releases_response="$(list_github_releases "${repository}")"; then
    fail "GitHub did not list draft releases for ${repository}"
  fi
  if ! release_id="$(jq -er \
    --arg repository "${repository}" \
    --arg tag "${release_tag}" \
    '
      if type != "array" or any(.[]; type != "array") then error("invalid pages") else . end |
      [.[][] | select(.tag_name == $tag)] as $matches |
      if ($matches | length) != 1 then error("ambiguous tag") else $matches[0] end |
      select(
        .draft == true and
        (.id | type == "number" and . > 0 and . <= 9007199254740991 and floor == .) and
        .url == ("https://api.github.com/repos/" + $repository + "/releases/" + (.id | tostring))
      ) |
      .id
    ' <<<"${releases_response}")"; then
    fail "GitHub did not return exactly one canonical draft identity for ${release_tag}"
  fi
  printf '%s\n' "${release_id}"
  exit 0
fi

if [[ "${1:-}" == "--require-github-release-assets" ]]; then
  repository="${2:-}"
  release_tag="${3:-}"
  assets_dir="${4:-}"
  expected_state="${5:-}"
  expected_release_id="${6:-}"

  validate_canonical_release_identity "${repository}" "${release_tag}"
  if [[ -z "${assets_dir}" || ! -d "${assets_dir}" ]]; then
    fail "asset directory does not exist: ${assets_dir:-<empty>}"
  fi
  if [[ ! "${expected_release_id}" =~ ^[1-9][0-9]*$ ]]; then
    fail "expected GitHub release ID must be a positive integer, got ${expected_release_id:-<empty>}"
  fi
  case "${expected_state}" in
    draft)
      expected_draft=true
      expected_immutable=false
      ;;
    published)
      expected_draft=false
      expected_immutable=true
      ;;
    *)
      fail "GitHub release state must be draft or published, got ${expected_state:-<empty>}"
      ;;
  esac
  require_github_query_tools

  release_version="${release_tag#v}"
  version_without_build="${release_tag%%+*}"
  expected_prerelease=false
  if [[ "${version_without_build}" == *-* ]]; then
    expected_prerelease=true
  fi
  expected_assets_json="$(jq -cn \
    --arg checksums checksums.txt \
    --arg darwin_amd64 "handoffgraph_${release_version}_darwin_amd64.tar.gz" \
    --arg darwin_arm64 "handoffgraph_${release_version}_darwin_arm64.tar.gz" \
    --arg linux_amd64 "handoffgraph_${release_version}_linux_amd64.tar.gz" \
    --arg linux_arm64 "handoffgraph_${release_version}_linux_arm64.tar.gz" \
    --arg windows_amd64 "handoffgraph_${release_version}_windows_amd64.zip" \
    --arg windows_arm64 "handoffgraph_${release_version}_windows_arm64.zip" \
    '[$checksums, $darwin_amd64, $darwin_arm64, $linux_amd64, $linux_arm64, $windows_amd64, $windows_arm64] | sort')"

  if [[ "${expected_state}" == draft ]]; then
    if ! releases_response="$(list_github_releases "${repository}")"; then
      fail "GitHub did not list draft releases for ${repository}"
    fi
    if ! jq -e \
      --arg tag "${release_tag}" \
      'type == "array" and all(.[]; type == "array") and ([.[][] | select(.tag_name == $tag)] | length) == 1' \
      >/dev/null 2>&1 <<<"${releases_response}"; then
      fail "GitHub did not return exactly one draft candidate for ${release_tag}"
    fi
    release_response="$(jq -c \
      --arg tag "${release_tag}" \
      '[.[][] | select(.tag_name == $tag)][0]' \
      <<<"${releases_response}")"
  elif ! release_response="$(gh api \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2026-03-10' \
    "repos/${repository}/releases/${expected_release_id}")"; then
    fail "GitHub did not return release ID ${expected_release_id} from ${repository}"
  elif ! release_by_tag_response="$(gh api \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2026-03-10' \
    "repos/${repository}/releases/tags/${release_tag}")" ||
    ! jq -e \
      --argjson release_id "${expected_release_id}" \
      'type == "object" and .id == $release_id' \
      >/dev/null 2>&1 <<<"${release_by_tag_response}"; then
    fail "GitHub tag lookup did not resolve to release ID ${expected_release_id}"
  fi
  if ! jq -e \
    --arg repository "${repository}" \
    --arg tag "${release_tag}" \
    --argjson release_id "${expected_release_id}" \
    --argjson draft "${expected_draft}" \
    --argjson prerelease "${expected_prerelease}" \
    --argjson immutable "${expected_immutable}" \
    --argjson expected_assets "${expected_assets_json}" \
    '
      type == "object" and
      .id == $release_id and
      .url == ("https://api.github.com/repos/" + $repository + "/releases/" + ($release_id | tostring)) and
      .tag_name == $tag and
      .draft == $draft and
      .prerelease == $prerelease and
      .immutable == $immutable and
      (.assets | type == "array") and
      ([.assets[].name] | sort) == $expected_assets and
      all(.assets[];
        .state == "uploaded" and
        (.size | type == "number" and . > 0 and floor == .) and
        (.browser_download_url == ("https://github.com/" + $repository + "/releases/download/" + $tag + "/" + .name)) and
        (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$"))
      )
    ' >/dev/null 2>&1 <<<"${release_response}"; then
    fail "GitHub ${expected_state} release state, asset inventory, URLs, sizes, or SHA-256 digests were invalid"
  fi

  metadata_file="$(mktemp "${TMPDIR:-/tmp}/handoffgraph-github-release-assets.XXXXXX")"
  cleanup_github_metadata() {
    rm -f -- "${metadata_file}"
  }
  trap cleanup_github_metadata EXIT
  jq -r '.assets[] | [.name, (.size | tostring), .digest] | @tsv' \
    <<<"${release_response}" >"${metadata_file}"
  while IFS=$'\t' read -r asset api_size api_digest; do
    asset_path="${assets_dir}/${asset}"
    if [[ ! -f "${asset_path}" || -L "${asset_path}" ]]; then
      fail "downloaded GitHub asset must be a regular, non-symlink file: ${asset}"
    fi
    local_size="$(wc -c <"${asset_path}" | tr -d '[:space:]')"
    if [[ "${local_size}" != "${api_size}" ]]; then
      fail "GitHub size does not match downloaded bytes for ${asset}"
    fi
    local_digest="$(sha256_file "${asset_path}")"
    if [[ "sha256:${local_digest}" != "${api_digest}" ]]; then
      fail "GitHub digest does not match downloaded bytes for ${asset}"
    fi
  done <"${metadata_file}"

  echo "GitHub ${expected_state} release assets verified for ${release_tag}: canonical seven-asset inventory and matching SHA-256 digests"
  exit 0
fi

release_tag="${1:-}"
assets_dir="${2:-}"

if [[ ! "${release_tag}" =~ ${semver_pattern} ]]; then
  fail "tag must be strict SemVer with a leading v, got ${release_tag:-<empty>}"
fi
if [[ -z "${assets_dir}" || ! -d "${assets_dir}" ]]; then
  fail "asset directory does not exist: ${assets_dir:-<empty>}"
fi

release_version="${release_tag#v}"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/handoffgraph-release-assets.XXXXXX")"
cleanup() {
  rm -rf -- "${work_dir}"
}
trap cleanup EXIT

expected_archives="${work_dir}/expected-archives.txt"
expected_assets="${work_dir}/expected-assets.txt"
actual_assets="${work_dir}/actual-assets.txt"
checksum_assets="${work_dir}/checksum-assets.txt"

printf '%s\n' \
  "handoffgraph_${release_version}_darwin_amd64.tar.gz" \
  "handoffgraph_${release_version}_darwin_arm64.tar.gz" \
  "handoffgraph_${release_version}_linux_amd64.tar.gz" \
  "handoffgraph_${release_version}_linux_arm64.tar.gz" \
  "handoffgraph_${release_version}_windows_amd64.zip" \
  "handoffgraph_${release_version}_windows_arm64.zip" \
  | LC_ALL=C sort >"${expected_archives}"

{
  cat "${expected_archives}"
  printf '%s\n' checksums.txt
} | LC_ALL=C sort >"${expected_assets}"

find "${assets_dir}" -mindepth 1 -maxdepth 1 -print \
  | while IFS= read -r path; do basename "${path}"; done \
  | LC_ALL=C sort >"${actual_assets}"
if ! diff -u "${expected_assets}" "${actual_assets}"; then
  fail "downloaded asset inventory must contain exactly six platform archives and checksums.txt"
fi

while IFS= read -r asset; do
  if [[ ! -f "${assets_dir}/${asset}" || -L "${assets_dir}/${asset}" ]]; then
    fail "asset must be a regular, non-symlink file: ${asset}"
  fi
done <"${expected_assets}"

checksums_file="${assets_dir}/checksums.txt"
if ! awk '
  NF != 2 || length($1) != 64 || $1 ~ /[^0-9a-f]/ { exit 1 }
  { print $2 }
' "${checksums_file}" | LC_ALL=C sort >"${checksum_assets}"; then
  fail "checksums.txt must contain lowercase SHA-256 records in '<digest> <asset>' form"
fi
if ! diff -u "${expected_archives}" "${checksum_assets}"; then
  fail "checksums.txt must cover each archive exactly once and no other files"
fi

if command -v sha256sum >/dev/null 2>&1; then
  if ! (cd "${assets_dir}" && sha256sum --check --strict checksums.txt); then
    fail "an archive does not match checksums.txt"
  fi
elif command -v shasum >/dev/null 2>&1; then
  if ! (cd "${assets_dir}" && shasum -a 256 --check checksums.txt); then
    fail "an archive does not match checksums.txt"
  fi
else
  fail "neither sha256sum nor shasum is available"
fi

expected_tar_members="${work_dir}/expected-tar-members.txt"
expected_zip_members="${work_dir}/expected-zip-members.txt"
printf '%s\n' LICENSE README.md docs/privacy.md handoffgraph \
  | LC_ALL=C sort >"${expected_tar_members}"
printf '%s\n' LICENSE README.md docs/privacy.md handoffgraph.exe \
  | LC_ALL=C sort >"${expected_zip_members}"

while IFS= read -r archive_name; do
  archive_path="${assets_dir}/${archive_name}"
  archive_members="${work_dir}/${archive_name}.members"
  case "${archive_name}" in
    *.tar.gz)
      if ! tar -tzf "${archive_path}" | LC_ALL=C sort >"${archive_members}"; then
        fail "invalid tar.gz archive: ${archive_name}"
      fi
      if ! diff -u "${expected_tar_members}" "${archive_members}"; then
        fail "unexpected archive members in ${archive_name}"
      fi
      ;;
    *.zip)
      if ! unzip -Z1 "${archive_path}" | LC_ALL=C sort >"${archive_members}"; then
        fail "invalid zip archive: ${archive_name}"
      fi
      if ! diff -u "${expected_zip_members}" "${archive_members}"; then
        fail "unexpected archive members in ${archive_name}"
      fi
      ;;
    *)
      fail "unsupported archive format: ${archive_name}"
      ;;
  esac
done <"${expected_archives}"

linux_archive="${assets_dir}/handoffgraph_${release_version}_linux_amd64.tar.gz"
extract_dir="${work_dir}/linux-amd64"
mkdir "${extract_dir}"
tar -xzf "${linux_archive}" -C "${extract_dir}"
binary="${extract_dir}/handoffgraph"
if [[ ! -f "${binary}" || -L "${binary}" || ! -x "${binary}" ]]; then
  fail "linux amd64 archive must contain an executable, non-symlink handoffgraph binary"
fi

expected_version="handoffgraph ${release_tag}"
actual_version="$("${binary}" version)"
if [[ "${actual_version}" != "${expected_version}" ]]; then
  fail "archive version does not match the requested release tag"
fi
help_first_line="$("${binary}" --help | sed -n '1p')"
if [[ "${help_first_line}" != "${expected_version}" ]]; then
  fail "archive help header does not match the requested release tag"
fi

doctor_data_dir="${work_dir}/doctor-data"
doctor_output="${work_dir}/doctor.txt"
if ! HFG_DATA_DIR="${doctor_data_dir}" "${binary}" doctor >"${doctor_output}"; then
  fail "archive doctor command failed on a fresh HFG_DATA_DIR"
fi
if ! grep -Fx 'status: OK' "${doctor_output}" >/dev/null; then
  fail "archive doctor command did not report status: OK"
fi

echo "release assets verified for ${release_tag}: six checksummed archives and healthy linux amd64 CLI"
