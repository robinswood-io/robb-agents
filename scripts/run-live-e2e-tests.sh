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
E2E_TEST_LIST="$(mktemp -t robb-live-e2e-tests.XXXXXX)"
trap 'rm -f "$E2E_TEST_LIST"' EXIT

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
  \( -name '*.e2e.test.ts' -o -name '*.e2e.test.tsx' \) -print \
  | sort > "$E2E_TEST_LIST"

if [ ! -s "$E2E_TEST_LIST" ]; then
  echo "No live E2E tests found"
  exit 0
fi

while IFS= read -r file; do
  [ -n "$file" ] || continue
  echo "==> Running live E2E test ${file}"
  "$RESOLVED_BUN_BIN" test --timeout 30000 "$file"
done < "$E2E_TEST_LIST"
