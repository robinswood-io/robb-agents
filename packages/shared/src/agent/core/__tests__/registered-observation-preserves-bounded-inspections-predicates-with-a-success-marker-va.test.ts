import { describe, expect, it } from "bun:test";
import { isObjectiveShellEvidenceCommand, isObjectiveShellObservationCommand } from "../registered-observation.ts";

describe('objective shell evidence registration grammar', () => {
  it('preserves bounded inspections, predicates with a success marker, validators, HTTP reads and test scripts', () => {
    for (const command of [
      'cat /tmp/state.json',
      "cd /srv/release && printf '%s\\n' '--- revision ---' && git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager rev-parse HEAD",
      'test -s /tmp/report.json && printf present',
      'grep -q ready /tmp/report.json && echo ready',
      'cmp -s /tmp/report.json /tmp/expected.json && printf identical',
      'test -s /tmp/report.json && grep -q ready /tmp/report.json && echo ready',
      'python3 /tmp/verify_report.py',
      'node /tmp/check-release.mjs',
      'curl --fail --silent https://example.com/health',
      'curl --head https://example.com/health',
      'bun test result.ts',
      'bun run test:orion-contract',
      'npm run check:release',
      'pnpm run lint-workspace',
      'yarn run typecheck_app',
      'pytest -q tests/test_report.py',
      'go test ./...',
      'cargo test --workspace',
      'tsc -p tsconfig.json --noEmit',
    ]) expect(isObjectiveShellEvidenceCommand(command)).toBe(true);
  });

  it('rejects inline programs, fabricated output, ambiguous control flow and mutations before criteria freeze', () => {
    for (const command of [
      `python3 -c "print({'exists': True})"`,
      `python3 -c 'import json; print(json.dumps({'exists': True}))'`,
      "python3 -c 'import json; print(json.dumps({\"exists\": True}))'",
      "python3 - <<'PY'\nprint('{\"ok\":true}')\nPY",
      'python3 -',
      'node -e "console.log(JSON.stringify({ok:true}))"',
      'bun -e "console.log(JSON.stringify({ok:true}))"',
      'printf \'{"ok":true}\\n\'',
      'echo PASS',
      'true && printf PASS',
      'python3 -c "print(1)" && printf PASS',
      'bun run deploy',
      'bun run testing',
      'bun run test:orion-contract || printf PASS',
      'bun run test:orion-contract; printf PASS',
      'curl -X POST https://example.com/health',
      'curl --output /tmp/result https://example.com/health',
      'python3 /tmp/verify_report.py --write',
      'cat /tmp/state.json > /tmp/copied.json',
    ]) expect(isObjectiveShellEvidenceCommand(command)).toBe(false);
  });

  it('keeps opaque validators and HTTP reads dependent on an exact registered contract', () => {
    for (const command of [
      'cat /tmp/state.json',
      'test -s /tmp/report.json && printf present',
      'grep -q ready /tmp/report.json && echo ready',
      'cmp -s /tmp/report.json /tmp/expected.json && printf identical',
      'bun run test:orion-contract',
    ]) expect(isObjectiveShellObservationCommand(command)).toBe(true);
    for (const command of [
      'python3 /tmp/verify_report.py',
      'curl --fail --silent https://example.com/health',
      'python3 -c "print(1)"',
      'printf PASS',
      'printf -v result PASS',
    ]) expect(isObjectiveShellObservationCommand(command)).toBe(false);
  });
});
