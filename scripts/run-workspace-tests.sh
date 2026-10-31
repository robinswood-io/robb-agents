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

PATH="$(dirname "$RESOLVED_BUN_BIN"):$PATH"
export PATH
BUN_TEST_FLAGS=()
if [[ -n "${BUN_TEST_ARGS:-}" ]]; then
  read -r -a BUN_TEST_FLAGS <<< "$BUN_TEST_ARGS"
fi
TEST_LIST="$(mktemp -t robb-tests.XXXXXX)"
ISOLATED_LIST="$(mktemp -t robb-isolated-tests.XXXXXX)"
WORKSPACE_LIST="$(mktemp -t robb-test-workspaces.XXXXXX)"
WORKSPACE_TEST_LIST="$(mktemp -t robb-workspace-tests.XXXXXX)"
TEST_CONFIG_DIR=""
if [ -z "${CRAFT_CONFIG_DIR:-}" ]; then
  TEST_CONFIG_DIR="$(mktemp -d -t robb-test-profile.XXXXXX)"
  export CRAFT_CONFIG_DIR="$TEST_CONFIG_DIR"
fi

cleanup() {
  rm -f "$TEST_LIST" "$ISOLATED_LIST" "$WORKSPACE_LIST" "$WORKSPACE_TEST_LIST"
  if [ -n "$TEST_CONFIG_DIR" ]; then rm -rf "$TEST_CONFIG_DIR"; fi
}
trap cleanup EXIT

cd "$ROOT_DIR"

find . \
  \( \
    -name 'node_modules' -o \
    -path './.worktrees' -o \
    -path './apps/electron/release' -o \
    -path './apps/electron/dist' -o \
    -path './apps/*/dist' -o \
    -path './packages/*/dist' -o \
    -path './coverage' \
  \) -prune -o \
  \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.cjs' \) \
  ! -name '*.e2e.test.ts' \
  ! -name '*.e2e.test.tsx' \
  ! -path './packages/server-core/src/sessions/refresh-connection-runtime.test.ts' \
  ! -path './packages/server-core/src/tasks/TaskRunner-recovers-non-terminal-paused-runs-after-restart-without-schedulin.test.ts' \
  -print \
  | sort > "$TEST_LIST"

find . \
  \( \
    -name 'node_modules' -o \
    -path './.worktrees' -o \
    -path './apps/electron/release' -o \
    -path './apps/electron/dist' -o \
    -path './apps/*/dist' -o \
    -path './packages/*/dist' -o \
    -path './coverage' \
  \) -prune -o \
  -name '*.isolated.ts' \
  ! -path './packages/shared/src/agent/core/__tests__/rtk-output.isolated.ts' \
  -print \
  | sort > "$ISOLATED_LIST"

# Its dedicated .test.ts wrapper already launches this payload in a fresh
# CRAFT_CONFIG_DIR. Running it again here would duplicate it without isolation.
# This suite replaces module exports that other server-core suites also mock.
printf '%s\n' './packages/server-core/src/sessions/refresh-connection-runtime.test.ts' >> "$ISOLATED_LIST"
# Keep synchronous durable recovery stress separate from live workspace timers.
printf '%s\n' './packages/server-core/src/tasks/TaskRunner-recovers-non-terminal-paused-runs-after-restart-without-schedulin.test.ts' >> "$ISOLATED_LIST"

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
    xargs "$RESOLVED_BUN_BIN" test --timeout 10000 ${BUN_TEST_FLAGS[@]+"${BUN_TEST_FLAGS[@]}"} < "$WORKSPACE_TEST_LIST"
  done < "$WORKSPACE_LIST"
fi

while IFS= read -r file; do
  [ -n "$file" ] || continue
  "$RESOLVED_BUN_BIN" test --timeout 10000 ${BUN_TEST_FLAGS[@]+"${BUN_TEST_FLAGS[@]}"} "$file"
done < "$ISOLATED_LIST"


python3 -m unittest discover -s scripts/tests -t . -p 'test_*.py'
"$RESOLVED_BUN_BIN" run test:doc-tools

# Isolate each OPS suite: the campaign guard forbids processes and network access,
# while runtime fixture tests intentionally spawn a local Python child.
OPS_TEST_PYTHONPATH="${ROOT_DIR}/ops/rbw-agents-oss/scripts:${ROOT_DIR}/ops/rbw-agents-oss/packages:${ROOT_DIR}/ops/rbw-agents-oss/apps/orchestrator-temporal:${ROOT_DIR}/ops/rbw-agents-oss/tests${PYTHONPATH:+:${PYTHONPATH}}"
for file in "${ROOT_DIR}"/ops/rbw-agents-oss/tests/test_*.py; do
  module="${file##*/}"
  RBW_OSS_ROOT="${ROOT_DIR}/ops/rbw-agents-oss" PYTHONPATH="$OPS_TEST_PYTHONPATH" python3 -m unittest "${module%.py}"
done

# Companion queue and ramp cases are collected by their owning suites once.
# Operational report commands are never run against live state by this runner.
for module in \
  robinswood_flow_profile_tests robinswood_pme_hdf_recovery_cohort_tests \
  rubypayeur_recouvrement_tests register_preflight_tests \
  evergreen_queue_continuity_tests \
  evergreen_sender_pilot_tests \
  robinswood_evergreen_france_tests \
  robinswood_media_contact_enrichment_2026_tests \
  scotland_daily40_tests \
  scotland_executive_conference_october_tests \
  scotland_gateway_read_retry_tests; do
  RBW_OSS_ROOT="${ROOT_DIR}/ops/rbw-agents-oss" PYTHONPATH="$OPS_TEST_PYTHONPATH" python3 -m unittest "$module"
done
