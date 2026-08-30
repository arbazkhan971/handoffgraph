#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
verifier="${script_dir}/verify-release-assets.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/handoffgraph-release-assets-test.XXXXXX")"
release_tag="v0.7.0-beta.1"
release_version="${release_tag#v}"

cleanup() {
  rm -rf -- "${test_root}"
}
trap cleanup EXIT

fixture_dir="${test_root}/fixture"
baseline_dir="${test_root}/baseline"
mkdir -p "${fixture_dir}/docs" "${baseline_dir}"
printf '%s\n' license >"${fixture_dir}/LICENSE"
printf '%s\n' readme >"${fixture_dir}/README.md"
printf '%s\n' privacy >"${fixture_dir}/docs/privacy.md"

write_fake_binary() {
  local tag="$1"
  local destination="$2"
  sed "s/__RELEASE_TAG__/${tag}/g" >"${destination}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  version)
    printf '%s\n' 'handoffgraph __RELEASE_TAG__'
    ;;
  --help)
    printf '%s\n' 'handoffgraph __RELEASE_TAG__'
    printf '%s\n' 'Usage: handoffgraph <command>'
    ;;
  doctor)
    test -n "${HFG_DATA_DIR:-}"
    mkdir -p "${HFG_DATA_DIR}"
    printf '%s\n' 'HandoffGraph doctor' 'status: OK'
    ;;
  *)
    exit 64
    ;;
esac
EOF
  chmod +x "${destination}"
}

write_checksums() {
  local assets="$1"
  : >"${assets}/checksums.txt"
  while IFS= read -r archive; do
    if command -v sha256sum >/dev/null 2>&1; then
      (cd "${assets}" && sha256sum "${archive}") >>"${assets}/checksums.txt"
    else
      digest="$(shasum -a 256 "${assets}/${archive}" | awk '{ print $1 }')"
      printf '%s  %s\n' "${digest}" "${archive}" >>"${assets}/checksums.txt"
    fi
  done <<EOF
handoffgraph_${release_version}_darwin_amd64.tar.gz
handoffgraph_${release_version}_darwin_arm64.tar.gz
handoffgraph_${release_version}_linux_amd64.tar.gz
handoffgraph_${release_version}_linux_arm64.tar.gz
handoffgraph_${release_version}_windows_amd64.zip
handoffgraph_${release_version}_windows_arm64.zip
EOF
}

build_assets() {
  local assets="$1"
  mkdir -p "${assets}"
  write_fake_binary "${release_tag}" "${fixture_dir}/handoffgraph"
  cp "${fixture_dir}/handoffgraph" "${fixture_dir}/handoffgraph.exe"

  for target in darwin_amd64 darwin_arm64 linux_amd64 linux_arm64; do
    tar -czf "${assets}/handoffgraph_${release_version}_${target}.tar.gz" \
      -C "${fixture_dir}" LICENSE README.md docs/privacy.md handoffgraph
  done
  for target in windows_amd64 windows_arm64; do
    (
      cd "${fixture_dir}"
      zip -q "${assets}/handoffgraph_${release_version}_${target}.zip" \
        LICENSE README.md docs/privacy.md handoffgraph.exe
    )
  done
  write_checksums "${assets}"
}

expect_pass() {
  local label="$1"
  local assets="$2"
  if ! output="$(bash "${verifier}" "${release_tag}" "${assets}" 2>&1)"; then
    echo "expected pass (${label}), got: ${output}" >&2
    exit 1
  fi
}

expect_fail() {
  local label="$1"
  local tag="$2"
  local assets="$3"
  if output="$(bash "${verifier}" "${tag}" "${assets}" 2>&1)"; then
    echo "expected failure (${label}), got: ${output}" >&2
    exit 1
  fi
}

build_assets "${baseline_dir}"
expect_pass "complete release assets" "${baseline_dir}"

extra_dir="${test_root}/extra"
cp -R "${baseline_dir}" "${extra_dir}"
printf '%s\n' unexpected >"${extra_dir}/unexpected.txt"
expect_fail "extra asset" "${release_tag}" "${extra_dir}"

corrupt_dir="${test_root}/corrupt"
cp -R "${baseline_dir}" "${corrupt_dir}"
printf '%s\n' corruption >>"${corrupt_dir}/handoffgraph_${release_version}_linux_arm64.tar.gz"
expect_fail "checksum mismatch" "${release_tag}" "${corrupt_dir}"

wrong_version_dir="${test_root}/wrong-version"
cp -R "${baseline_dir}" "${wrong_version_dir}"
write_fake_binary "v0.7.0-beta.2" "${fixture_dir}/handoffgraph"
tar -czf "${wrong_version_dir}/handoffgraph_${release_version}_linux_amd64.tar.gz" \
  -C "${fixture_dir}" LICENSE README.md docs/privacy.md handoffgraph
write_checksums "${wrong_version_dir}"
expect_fail "wrong embedded version" "${release_tag}" "${wrong_version_dir}"

expect_fail "invalid release tag" "0.7.0-beta.1" "${baseline_dir}"

fake_bin="${test_root}/fake-bin"
mkdir "${fake_bin}"
sed "s|__EXPECTED_REPOSITORY__|handoffgraph/handoffgraph|g" >"${fake_bin}/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test "${1:-}" = api
shift
accept_header=false
version_header=false
endpoint=false
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -H)
      shift
      case "${1:-}" in
        'Accept: application/vnd.github+json') accept_header=true ;;
        'X-GitHub-Api-Version: 2026-03-10') version_header=true ;;
        *) exit 90 ;;
      esac
      ;;
    repos/__EXPECTED_REPOSITORY__/immutable-releases)
      endpoint=true
      ;;
    *)
      exit 91
      ;;
  esac
  shift
done
"${accept_header}" && "${version_header}" && "${endpoint}"
case "${FAKE_GH_MODE:-}" in
  enabled) printf '%s\n' '{"enabled":true,"enforced_by_owner":false}' ;;
  disabled) printf '%s\n' '{"enabled":false,"enforced_by_owner":false}' ;;
  malformed) printf '%s\n' '{"unexpected":true}' ;;
  invalid-json) printf '%s\n' 'not-json' ;;
  not-found) printf '%s\n' 'HTTP 404' >&2; exit 1 ;;
  *) exit 92 ;;
esac
EOF
chmod +x "${fake_bin}/gh"

expect_immutable_pass() {
  local label="$1"
  local mode="$2"
  if ! output="$(PATH="${fake_bin}:${PATH}" GH_TOKEN=test-token FAKE_GH_MODE="${mode}" \
    bash "${verifier}" --require-immutable-releases handoffgraph/handoffgraph 2>&1)"; then
    echo "expected immutable-state pass (${label}), got: ${output}" >&2
    exit 1
  fi
}

expect_immutable_fail() {
  local label="$1"
  local mode="$2"
  if output="$(PATH="${fake_bin}:${PATH}" GH_TOKEN=test-token FAKE_GH_MODE="${mode}" \
    bash "${verifier}" --require-immutable-releases handoffgraph/handoffgraph 2>&1)"; then
    echo "expected immutable-state failure (${label}), got: ${output}" >&2
    exit 1
  fi
}

expect_immutable_pass "enabled response" enabled
expect_immutable_fail "disabled response" disabled
expect_immutable_fail "malformed object" malformed
expect_immutable_fail "invalid JSON" invalid-json
expect_immutable_fail "HTTP 404" not-found
if output="$(PATH="${fake_bin}:${PATH}" FAKE_GH_MODE=enabled \
  bash "${verifier}" --require-immutable-releases handoffgraph/handoffgraph 2>&1)"; then
  echo "expected immutable-state failure (missing admin token), got: ${output}" >&2
  exit 1
fi

echo "release asset verifier tests passed"
