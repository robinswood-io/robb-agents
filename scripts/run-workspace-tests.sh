#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${BUN_BIN:-}" ]; then
  RESOLVED_BUN_BIN="$BUN_BIN"
elif command -v bun >/dev/null 2>&1; then
  RESOLVED_BUN_BIN="$(command -v bun)"
elif [ -x "/Users/thibault/.bun/bin/bun" ]; then
  RESOLVED_BUN_BIN="/Users/thibault/.bun/bin/bun"
else
  echo "Unable to find bun. Set BUN_BIN=/absolute/path/to/bun." >&2
  exit 127
fi

export PATH="$(dirname "$RESOLVED_BUN_BIN"):$PATH"
TEST_LIST="$(mktemp -t robb-tests.XXXXXX)"
ISOLATED_LIST="$(mktemp -t robb-isolated-tests.XXXXXX)"
WORKSPACE_LIST="$(mktemp -t robb-test-workspaces.XXXXXX)"
WORKSPACE_TEST_LIST="$(mktemp -t robb-workspace-tests.XXXXXX)"

cleanup() {
  rm -f "$TEST_LIST" "$ISOLATED_LIST" "$WORKSPACE_LIST" "$WORKSPACE_TEST_LIST"
}
trap cleanup EXIT

cd "$ROOT_DIR"

find . \
  \( \
    -name 'node_modules' -o \
    -path './apps/electron/release' -o \
    -path './apps/electron/dist' -o \
    -path './apps/*/dist' -o \
    -path './packages/*/dist' -o \
    -path './coverage' \
  \) -prune -o \
  \( -name '*.test.ts' -o -name '*.test.tsx' \) \
  ! -name '*.e2e.test.ts' \
  ! -name '*.e2e.test.tsx' \
  -print \
  | sort > "$TEST_LIST"

find . \
  \( \
    -name 'node_modules' -o \
    -path './apps/electron/release' -o \
    -path './apps/electron/dist' -o \
    -path './apps/*/dist' -o \
    -path './packages/*/dist' -o \
    -path './coverage' \
  \) -prune -o \
  -name '*.isolated.ts' -print \
  | sort > "$ISOLATED_LIST"

if [ -s "$TEST_LIST" ]; then
  # Run each workspace in a fresh Bun process. Several suites intentionally
  # replace global modules and create native file watchers; sharing one process
  # across every workspace can leak that state and prevent Bun from exiting.
  awk -F/ '
    $2 == "apps" || $2 == "packages" { print $2 "/" $3; next }
    { print $2 }
  ' "$TEST_LIST" | sort -u > "$WORKSPACE_LIST"

  while IFS= read -r workspace; do
    [ -n "$workspace" ] || continue
    awk -v prefix="./${workspace}/" 'index($0, prefix) == 1' "$TEST_LIST" > "$WORKSPACE_TEST_LIST"
    [ -s "$WORKSPACE_TEST_LIST" ] || continue
    echo "==> Testing ${workspace}"
    xargs "$RESOLVED_BUN_BIN" test --timeout 10000 ${BUN_TEST_ARGS:-} < "$WORKSPACE_TEST_LIST"
  done < "$WORKSPACE_LIST"
fi

while IFS= read -r file; do
  [ -n "$file" ] || continue
  "$RESOLVED_BUN_BIN" test --timeout 10000 ${BUN_TEST_ARGS:-} "$file"
done < "$ISOLATED_LIST"
