#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DIRECT_TASK_CHECKS=()
while IFS= read -r match; do
  DIRECT_TASK_CHECKS+=("$match")
done < <(
  rg --line-number \
    --glob '!**/__tests__/**' \
    --glob '!**/*.test.*' \
    --glob '!**/*.spec.*' \
    "(toolName|tool_name|activity\\.toolName|entry\\.name)[[:space:]]*(===|!==|==|!=)[[:space:]]*['\"]Task['\"]|['\"]Task['\"][[:space:]]*(===|!==|==|!=)[[:space:]]*(toolName|tool_name|activity\\.toolName|entry\\.name)" \
    apps packages \
    || true
)

if ((${#DIRECT_TASK_CHECKS[@]} > 0)); then
  echo "Direct Task tool-name checks detected; use isParentTaskTool() so namespaced aliases remain supported:"
  printf '  %s\n' "${DIRECT_TASK_CHECKS[@]}"
  exit 1
fi

echo "Parent task tool-name check passed."
