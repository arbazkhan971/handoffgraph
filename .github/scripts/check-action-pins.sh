#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  workflow_files=()
  while IFS= read -r workflow; do
    workflow_files+=("${workflow}")
  done < <(find .github -type f \( -name '*.yml' -o -name '*.yaml' \) -print | sort)
  set -- "${workflow_files[@]}"
fi

if [[ "$#" -eq 0 ]]; then
  echo "no GitHub workflow or action YAML files found" >&2
  exit 1
fi

failures=0
for workflow in "$@"; do
  while IFS= read -r line; do
    action_ref="$(sed -E 's/.*uses:[[:space:]]*([^[:space:]#]+).*/\1/' <<< "${line}")"
    if [[ "${action_ref}" == ./* ]]; then
      continue
    fi
    if [[ ! "${action_ref}" =~ ^[^@[:space:]]+/[^@[:space:]]+@[0-9a-f]{40}$ ]]; then
      echo "${workflow}: external action is not pinned to a full commit SHA: ${action_ref}" >&2
      failures=1
    fi
  done < <(grep -E '^[[:space:]]*(-[[:space:]]+)?uses:' "${workflow}" || true)
done

if [[ "${failures}" -ne 0 ]]; then
  exit 1
fi

echo "all external workflow actions are pinned to full commit SHAs"
