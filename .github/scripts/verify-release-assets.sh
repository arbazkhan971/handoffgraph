#!/usr/bin/env bash

set -euo pipefail

fail() {
  echo "release asset verification failed: $*" >&2
  exit 1
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

release_tag="${1:-}"
assets_dir="${2:-}"

semver_pattern='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-([0-9A-Za-z-]+)(\.[0-9A-Za-z-]+)*)?(\+([0-9A-Za-z-]+)(\.[0-9A-Za-z-]+)*)?$'
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
