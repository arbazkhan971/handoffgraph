#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
verifier="${script_dir}/verify-release-assets.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/handoffgraph-release-assets-test.XXXXXX")"
release_tag="v0.7.0-beta.1"
release_version="${release_tag#v}"
release_id="12345"

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
sed \
  -e "s|__EXPECTED_REPOSITORY__|handoffgraph/handoffgraph|g" \
  -e "s|__EXPECTED_TAG__|${release_tag}|g" \
  -e "s|__EXPECTED_RELEASE_ID__|${release_id}|g" \
  >"${fake_bin}/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test "${1:-}" = api
shift
accept_header=false
version_header=false
paginate=false
slurp=false
endpoint=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --paginate)
      paginate=true
      ;;
    --slurp)
      slurp=true
      ;;
    -H)
      shift
      case "${1:-}" in
        'Accept: application/vnd.github+json') accept_header=true ;;
        'X-GitHub-Api-Version: 2026-03-10') version_header=true ;;
        *) exit 90 ;;
      esac
      ;;
    repos/__EXPECTED_REPOSITORY__/immutable-releases)
      endpoint=immutable
      ;;
    repos/__EXPECTED_REPOSITORY__/releases\?per_page=100)
      endpoint=release-list
      ;;
    repos/__EXPECTED_REPOSITORY__/releases/tags/__EXPECTED_TAG__)
      endpoint=release
      ;;
    repos/__EXPECTED_REPOSITORY__/releases/__EXPECTED_RELEASE_ID__)
      endpoint=release
      ;;
    *)
      exit 91
      ;;
  esac
  shift
done
"${accept_header}" && "${version_header}" && test -n "${endpoint}"
if [[ "${endpoint}" == release-list ]]; then
  "${paginate}" && "${slurp}"
  if [[ -n "${FAKE_RELEASE_PAGES_JSON:-}" ]]; then
    cat "${FAKE_RELEASE_PAGES_JSON}"
  else
    test -n "${FAKE_RELEASE_JSON:-}"
    jq -c '[[.]]' "${FAKE_RELEASE_JSON}"
  fi
  exit 0
fi
if [[ "${endpoint}" == release ]]; then
  test -n "${FAKE_RELEASE_JSON:-}"
  cat "${FAKE_RELEASE_JSON}"
  exit 0
fi
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

write_release_json() {
  local state="$1"
  local destination="$2"
  local assets_json="${test_root}/assets-${state}.json"
  local next_json="${test_root}/assets-${state}.next.json"
  printf '%s\n' '[]' >"${assets_json}"
  while IFS= read -r asset; do
    if command -v sha256sum >/dev/null 2>&1; then
      digest="$(sha256sum "${baseline_dir}/${asset}" | awk '{ print $1 }')"
    else
      digest="$(shasum -a 256 "${baseline_dir}/${asset}" | awk '{ print $1 }')"
    fi
    size="$(wc -c <"${baseline_dir}/${asset}" | tr -d '[:space:]')"
    jq \
      --arg name "${asset}" \
      --argjson size "${size}" \
      --arg digest "sha256:${digest}" \
      --arg url "https://github.com/handoffgraph/handoffgraph/releases/download/${release_tag}/${asset}" \
      '. + [{name: $name, state: "uploaded", size: $size, digest: $digest, browser_download_url: $url}]' \
      "${assets_json}" >"${next_json}"
    mv "${next_json}" "${assets_json}"
  done <<EOF
checksums.txt
handoffgraph_${release_version}_darwin_amd64.tar.gz
handoffgraph_${release_version}_darwin_arm64.tar.gz
handoffgraph_${release_version}_linux_amd64.tar.gz
handoffgraph_${release_version}_linux_arm64.tar.gz
handoffgraph_${release_version}_windows_amd64.zip
handoffgraph_${release_version}_windows_arm64.zip
EOF

  if [[ "${state}" == draft ]]; then
    draft=true
    immutable=false
  else
    draft=false
    immutable=true
  fi
  jq -n \
    --arg tag "${release_tag}" \
    --arg repository "handoffgraph/handoffgraph" \
    --argjson release_id "${release_id}" \
    --argjson draft "${draft}" \
    --argjson immutable "${immutable}" \
    --slurpfile assets "${assets_json}" \
    '{id: $release_id, url: ("https://api.github.com/repos/" + $repository + "/releases/" + ($release_id | tostring)), tag_name: $tag, draft: $draft, prerelease: true, immutable: $immutable, assets: $assets[0]}' \
    >"${destination}"
}

expect_github_release_pass() {
  local label="$1"
  local state="$2"
  local release_json="$3"
  if ! output="$(PATH="${fake_bin}:${PATH}" GH_TOKEN=test-token FAKE_RELEASE_JSON="${release_json}" \
    bash "${verifier}" --require-github-release-assets \
      handoffgraph/handoffgraph "${release_tag}" "${baseline_dir}" "${state}" "${release_id}" 2>&1)"; then
    echo "expected GitHub release pass (${label}), got: ${output}" >&2
    exit 1
  fi
}

expect_github_release_fail() {
  local label="$1"
  local state="$2"
  local release_json="$3"
  if output="$(PATH="${fake_bin}:${PATH}" GH_TOKEN=test-token FAKE_RELEASE_JSON="${release_json}" \
    bash "${verifier}" --require-github-release-assets \
      handoffgraph/handoffgraph "${release_tag}" "${baseline_dir}" "${state}" "${release_id}" 2>&1)"; then
    echo "expected GitHub release failure (${label}), got: ${output}" >&2
    exit 1
  fi
}

draft_release_json="${test_root}/draft-release.json"
published_release_json="${test_root}/published-release.json"
write_release_json draft "${draft_release_json}"
write_release_json published "${published_release_json}"

resolved_release_id="$(PATH="${fake_bin}:${PATH}" GH_TOKEN=test-token FAKE_RELEASE_JSON="${draft_release_json}" \
  bash "${verifier}" --resolve-github-draft-id handoffgraph/handoffgraph "${release_tag}")"
if [[ "${resolved_release_id}" != "${release_id}" ]]; then
  echo "resolved draft release ID = ${resolved_release_id}, want ${release_id}" >&2
  exit 1
fi

other_release_json="${test_root}/other-release.json"
jq \
  '.id = 54321 | .url = "https://api.github.com/repos/handoffgraph/handoffgraph/releases/54321" | .tag_name = "v9.9.9"' \
  "${draft_release_json}" >"${other_release_json}"
page_two_release_json="${test_root}/page-two-release.json"
jq -s '[[.[0]], [.[1]]]' "${other_release_json}" "${draft_release_json}" >"${page_two_release_json}"
if ! output="$(PATH="${fake_bin}:${PATH}" GH_TOKEN=test-token FAKE_RELEASE_PAGES_JSON="${page_two_release_json}" \
  bash "${verifier}" --require-github-release-assets \
    handoffgraph/handoffgraph "${release_tag}" "${baseline_dir}" draft "${release_id}" 2>&1)"; then
  echo "expected paginated draft pass, got: ${output}" >&2
  exit 1
fi

duplicate_release_json="${test_root}/duplicate-release.json"
jq -s '[[.[0]], [.[0]]]' "${draft_release_json}" >"${duplicate_release_json}"
if output="$(PATH="${fake_bin}:${PATH}" GH_TOKEN=test-token FAKE_RELEASE_PAGES_JSON="${duplicate_release_json}" \
  bash "${verifier}" --resolve-github-draft-id handoffgraph/handoffgraph "${release_tag}" 2>&1)"; then
  echo "expected duplicate draft identity failure, got: ${output}" >&2
  exit 1
fi

malformed_pages_json="${test_root}/malformed-pages.json"
printf '%s\n' '[{"not":"a page"}]' >"${malformed_pages_json}"
if output="$(PATH="${fake_bin}:${PATH}" GH_TOKEN=test-token FAKE_RELEASE_PAGES_JSON="${malformed_pages_json}" \
  bash "${verifier}" --resolve-github-draft-id handoffgraph/handoffgraph "${release_tag}" 2>&1)"; then
  echo "expected malformed paginated response failure, got: ${output}" >&2
  exit 1
fi

expect_github_release_pass "exact draft assets" draft "${draft_release_json}"
expect_github_release_pass "exact immutable assets" published "${published_release_json}"
expect_github_release_fail "published object cannot satisfy draft state" draft "${published_release_json}"

if output="$(PATH="${fake_bin}:${PATH}" GH_TOKEN= FAKE_RELEASE_JSON="${draft_release_json}" \
  bash "${verifier}" --resolve-github-draft-id handoffgraph/handoffgraph "${release_tag}" 2>&1)"; then
  echo "expected draft identity failure (missing token), got: ${output}" >&2
  exit 1
fi

wrong_digest_json="${test_root}/wrong-digest.json"
jq '(.assets[0].digest) = ("sha256:" + ("0" * 64))' \
  "${draft_release_json}" >"${wrong_digest_json}"
expect_github_release_fail "API digest differs from downloaded bytes" draft "${wrong_digest_json}"

missing_digest_json="${test_root}/missing-digest.json"
jq 'del(.assets[0].digest)' \
  "${draft_release_json}" >"${missing_digest_json}"
expect_github_release_fail "missing API digest" draft "${missing_digest_json}"

wrong_url_json="${test_root}/wrong-url.json"
jq '(.assets[0].browser_download_url) = "https://example.invalid/checksums.txt"' \
  "${draft_release_json}" >"${wrong_url_json}"
expect_github_release_fail "non-canonical asset URL" draft "${wrong_url_json}"

pending_asset_json="${test_root}/pending-asset.json"
jq '(.assets[0].state) = "open"' \
  "${draft_release_json}" >"${pending_asset_json}"
expect_github_release_fail "asset not uploaded" draft "${pending_asset_json}"

wrong_size_json="${test_root}/wrong-size.json"
jq '(.assets[0].size) += 1' \
  "${draft_release_json}" >"${wrong_size_json}"
expect_github_release_fail "API size differs from downloaded bytes" draft "${wrong_size_json}"

extra_asset_json="${test_root}/extra-asset.json"
jq '.assets += [(.assets[0] | .name = "unexpected.txt")]' \
  "${draft_release_json}" >"${extra_asset_json}"
expect_github_release_fail "extra REST asset" draft "${extra_asset_json}"

mutable_published_json="${test_root}/mutable-published.json"
jq '.immutable = false' "${published_release_json}" >"${mutable_published_json}"
expect_github_release_fail "published release not immutable" published "${mutable_published_json}"

if output="$(PATH="${fake_bin}:${PATH}" GH_TOKEN=test-token FAKE_RELEASE_JSON="${draft_release_json}" \
  bash "${verifier}" --require-github-release-assets \
    arbazkhan971/handoffgraph "${release_tag}" "${baseline_dir}" draft "${release_id}" 2>&1)"; then
  echo "expected GitHub release failure (non-canonical repository), got: ${output}" >&2
  exit 1
fi

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
