import { describe, expect, it } from 'bun:test';
import { inspectReadOnlyReviewCommand } from '../../bash-validator.ts';
import {
  classifyBoundedTargetedRemoteOperationalInspection,
  classifyNestedSshReadOnlyRemoteObservationRepair,
  classifyReadOnlyRemoteObservationRepair,
  containsRemoteStaticSourceInspectionCandidate,
  containsLocalSshTransportInvocation,
  isBoundedRemoteStaticSourceInspection,
  isBoundedTargetedRemoteOperationalInspection,
  isObjectiveShellExecutorToolName,
  isObjectiveShellEvidenceCommand,
  isObjectiveShellObservationCommand,
  objectiveShellExitZeroProvesSuccess,
  isProvablyReadOnlyShellCommand,
  isReadOnlyRegisteredShellObservation,
  isRemoteStaticSourceInspectionCandidate,
  isRegisteredShellObservation,
} from '../registered-observation.ts';

it('parses target-bound operational reads and keeps redirects outside the bounded grammar', () => {
  const http = 'curl --fail-with-body --silent http://127.0.0.1:8888/api/v1/edoc-optimized/status/3602';
  expect(classifyBoundedTargetedRemoteOperationalInspection(http)).toEqual({
    kind: 'http',
    method: 'GET',
    url: 'http://127.0.0.1:8888/api/v1/edoc-optimized/status/3602',
    followsRedirects: false,
  });
  expect(isBoundedTargetedRemoteOperationalInspection(http)).toBe(true);

  const redirect = 'curl --fail-with-body -L http://127.0.0.1:8888/api/v1/edoc-optimized/status/3602';
  expect(classifyBoundedTargetedRemoteOperationalInspection(redirect)).toMatchObject({
    kind: 'http', followsRedirects: true,
  });
  expect(isBoundedTargetedRemoteOperationalInspection(redirect)).toBe(false);

  expect(classifyBoundedTargetedRemoteOperationalInspection(
    "docker image inspect registry.robinswood.io/pns-gen:prod pnsgen-app:local --format '{{.Id}}'",
  )).toEqual({
    kind: 'docker-image',
    targets: ['registry.robinswood.io/pns-gen:prod', 'pnsgen-app:local'],
    output: 'image-id',
  });
  for (const unsafeImageInspection of [
    'docker image inspect pnsgen-app:local',
    "docker image inspect pnsgen-app:local --format '{{json .Config.Env}}'",
    "docker image inspect pnsgen-app:local --format '{{.Config.Labels}}'",
  ]) {
    expect(classifyBoundedTargetedRemoteOperationalInspection(
      unsafeImageInspection,
    )).toMatchObject({ kind: 'docker-image', output: 'unsafe' });
    expect(isBoundedTargetedRemoteOperationalInspection(unsafeImageInspection)).toBeFalse();
  }
  expect(classifyBoundedTargetedRemoteOperationalInspection(
    "docker image inspect pnsgen-app:local --format '{{json .RepoDigests}}'",
  )).toMatchObject({ kind: 'docker-image', output: 'repo-digests' });
  expect(isBoundedTargetedRemoteOperationalInspection(
    "docker image inspect pnsgen-app:local --format '{{json .RepoDigests}}'",
  )).toBeTrue();
  expect(classifyBoundedTargetedRemoteOperationalInspection(
    'docker compose -f /srv/pnsgen/compose.yaml config --images',
  )).toEqual({ kind: 'docker-compose', path: '/srv/pnsgen/compose.yaml' });
});

it('classifies the live literal Bash SSH retry with the same remote repair grammar', () => {
  const command = `ssh -i ~/.ssh/id_ecdsa_vps -o BatchMode=yes -o ConnectTimeout=15 ubuntu@164.132.161.150 'cd /srv/workspace/zero && printf "REV=" && git rev-parse HEAD && printf "\\nSTATUS\\n" && git status --short && printf "\\nFILES\\n" && for f in "app/(auth)/login/page.tsx" "tests/dev-login-isolation.test.ts"; do if test -f "$f"; then sha256sum "$f"; else printf "MISSING  %s\\n" "$f"; fi; done; printf "\\nCONTAINER\\n"; docker ps --filter name="^/zero$" --format "{{.Names}}|{{.Image}}|{{.Status}}"'`;
  expect(classifyNestedSshReadOnlyRemoteObservationRepair(command)).toBe('split-composite');
  expect(classifyNestedSshReadOnlyRemoteObservationRepair(
    `ssh -o ProxyCommand=/tmp/evil host 'pwd && ls'`,
  )).toBeUndefined();
});

describe('local SSH transport detection', () => {
  it.each([
    'ssh host "pwd"',
    "/usr/bin/ssh host 'pwd'",
    '/bin/ssh host rm -rf /srv/target',
    'command ssh host pwd',
    'command -- /usr/bin/ssh host pwd',
    'command -p ssh host pwd',
    'env ssh host pwd',
    '/usr/bin/env TOKEN=value /bin/ssh host pwd',
    'sudo ssh host pwd',
    'sudo -n -u deploy /usr/bin/ssh host pwd',
    'sudo -- command ssh host pwd',
    'TOKEN=value ssh host pwd > /tmp/output',
    'pwd && ssh host pwd && echo done',
    "bash -lc 'ssh host pwd'",
    'echo "$(ssh host pwd)"',
  ])('detects an executable SSH transport regardless of payload: %s', command => {
    expect(containsLocalSshTransportInvocation(command)).toBe(true);
  });

  it('detects the live composite Zero retry without depending on its remote repair class', () => {
    const command = `ssh -i ~/.ssh/id_ecdsa_vps -o BatchMode=yes -o ConnectTimeout=15 ubuntu@164.132.161.150 'cd /srv/workspace/zero && printf "REV=" && git rev-parse HEAD && printf "\\nSTATUS\\n" && git status --short && printf "\\nFILES\\n" && for f in "app/(auth)/login/page.tsx" "tests/dev-login-isolation.test.ts"; do if test -f "$f"; then sha256sum "$f"; else printf "MISSING  %s\\n" "$f"; fi; done'`;
    expect(containsLocalSshTransportInvocation(command)).toBe(true);
  });

  it.each([
    "echo 'ssh host pwd'",
    "printf '%s\\n' 'ssh host pwd'",
    "grep 'ssh host' commands.txt",
    'command -v ssh',
    'command -V /usr/bin/ssh',
    'env echo ssh host pwd',
    'sudo echo ssh host pwd',
    'sudo --version ssh',
    "cat <<'EOF'\nssh host pwd\nEOF",
    "bash -lc 'echo \\\"ssh host pwd\\\"'",
  ])('does not confuse inert text or command lookup with transport: %s', command => {
    expect(containsLocalSshTransportInvocation(command)).toBe(false);
  });
});

const safeGit = 'git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager';
const legacyGitWithoutSignatureGuards = 'git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-pager';

it('does not suggest splitting a composite containing mutating sort options', () => {
  expect(classifyReadOnlyRemoteObservationRepair(
    'git status --short; sort -o /tmp/pwn input',
  )).toBeUndefined();
  expect(isProvablyReadOnlyShellCommand('diff --output=/tmp/pwn a b')).toBeFalse();
  expect(classifyReadOnlyRemoteObservationRepair(
    'git status --short; diff --output=/tmp/pwn a b',
  )).toBeUndefined();
});

it('suggests splitting simple read-only pipelines without admitting Git helpers', () => {
  for (const command of [
    'ls | sort',
    'grep x file.txt | head -2',
    'find . -type f | sort',
  ]) {
    expect(classifyReadOnlyRemoteObservationRepair(command)).toBe('split-composite');
  }

  expect(isProvablyReadOnlyShellCommand(`${safeGit} grep -n 'bridge_unavailable'`)).toBe(true);
  for (const command of [
    `${safeGit} rev-parse HEAD`,
    `${safeGit} branch --show-current`,
    `${safeGit} merge-base HEAD main`,
    `${safeGit} ls-files --cached`,
    `${safeGit} log --oneline --no-patch -n 1`,
  ]) {
    expect(isProvablyReadOnlyShellCommand(command)).toBe(true);
  }
  for (const command of [
    "git grep -n 'bridge_unavailable'",
    'git ls-files',
    'git rev-parse HEAD',
  ]) {
    expect(isProvablyReadOnlyShellCommand(command)).toBe(false);
    expect(classifyReadOnlyRemoteObservationRepair(command)).toBe('git-hardening');
    expect(classifyReadOnlyRemoteObservationRepair(`${command} | head -2`))
      .toBe('split-composite');
  }
  for (const command of [
    "git grep -O /tmp/evil 'bridge_unavailable'",
    "git grep -O/tmp/evil 'bridge_unavailable'",
    "git grep --open-files-in-pager 'bridge_unavailable'",
    "git grep --open-files-in-pager=/tmp/evil 'bridge_unavailable'",
    "git grep --open-files-in-page=cat 'bridge_unavailable'",
    "git grep --open-files-in-p=cat 'bridge_unavailable'",
    "git grep --op=/usr/bin/true 'bridge_unavailable'",
    "git grep --open=/usr/bin/true 'bridge_unavailable'",
    "git grep --open-files-in=/usr/bin/true 'bridge_unavailable'",
    "git grep --ext-grep 'bridge_unavailable'",
    "git grep --ext-grep=/tmp/evil 'bridge_unavailable'",
    "git grep --ext-gr 'bridge_unavailable'",
    "git grep --ext-g 'bridge_unavailable'",
    "git grep --ext- 'bridge_unavailable'",
    "git grep --textc 'bridge_unavailable'",
    `${safeGit} grep --open-files-in-page=/usr/bin/true bridge_unavailable`,
    `${safeGit} grep --ext-gr bridge_unavailable`,
    `${safeGit} grep --textc bridge_unavailable`,
    `${safeGit} grep -f /tmp/patterns`,
    `${safeGit} grep --file=/tmp/patterns bridge_unavailable`,
    `${safeGit} ls-files --exclude-from=/tmp/excludes`,
    `${safeGit} status --short`,
    `${safeGit} diff --check`,
    `${safeGit} show HEAD`,
    `${safeGit} log -p -n 1`,
    `${safeGit} log --patch -n 1`,
    `${safeGit} log --show-signature --no-patch -n 1`,
    `${safeGit} -c log.showSignature=true log --no-patch -n 1`,
    `${safeGit} -c format.pretty=%G? log --no-patch -n 1`,
    `${legacyGitWithoutSignatureGuards} log --no-patch -n 1`,
    '/tmp/git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager rev-parse HEAD',
    './git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager rev-parse HEAD',
    'Git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-pager rev-parse HEAD',
    'git diff --ext-diff',
    'git diff --ext-dif',
    'git diff',
    'git diff --check',
    'git diff -- --no-textconv',
    'git show HEAD',
    'git log -p -n 1',
    'git log --ext-diff',
    `${safeGit} log --format=%G? -1`,
    `${safeGit} log --pretty=format:%G? -1`,
    "git -C /srv/workspace/orion grep -O/tmp/evil 'bridge_unavailable'",
  ]) {
    expect(isProvablyReadOnlyShellCommand(command)).toBe(false);
    expect(classifyReadOnlyRemoteObservationRepair(`${command} | head -2`)).toBeUndefined();
  }
});

describe('objective shell executor tool names', () => {
  it.each([
    'Bash', 'bash', 'functions.bash', 'shell', 'functions.shell',
    'exec_command', 'functions.exec_command', 'mcp__ops__exec_command',
    'ssh_execute', 'mcp__ops__ssh_execute', 'vendor:remote:ssh_execute',
  ])('recognizes a native or namespaced executor suffix: %s', toolName => {
    expect(isObjectiveShellExecutorToolName(toolName)).toBe(true);
  });

  it.each([
    '', 'notbash', 'mcp__ops__bash_status', 'mcp__ops__ssh_execute_status',
    'mcp__ops__run_command', 'mcp__ops__shellcheck', 'browser_tool',
  ])('does not infer shell execution from a partial token: %s', toolName => {
    expect(isObjectiveShellExecutorToolName(toolName)).toBe(false);
  });
});

describe('synthetic shell success projection', () => {
  it('requires curl HTTP failure semantics while retaining non-HTTP validators', () => {
    expect(objectiveShellExitZeroProvesSuccess('curl --silent https://example.com/health')).toBe(false);
    expect(objectiveShellExitZeroProvesSuccess('curl -sSf https://example.com/health')).toBe(true);
    expect(objectiveShellExitZeroProvesSuccess('cd /srv/app && curl --fail --silent https://example.com/health')).toBe(true);
    expect(objectiveShellExitZeroProvesSuccess('python3 /tmp/verify_release.py')).toBe(true);
  });
});

describe('bounded reviewer file integrity checks', () => {
  const target = '/srv/workspace/orion';

  it('shares the exact hardened Git grammar with objective observations', () => {
    expect(inspectReadOnlyReviewCommand(
      `${safeGit} -C ${target} rev-parse HEAD`, target,
    )).toEqual({ safe: true, observesTarget: true, revisionProbe: true });
    expect(inspectReadOnlyReviewCommand(
      `${safeGit} branch --show-current`, target, target,
    )).toEqual({ safe: true, observesTarget: true, revisionProbe: false });
    expect(inspectReadOnlyReviewCommand(
      `${safeGit} grep -n bridge_unavailable -- packages`, target, target,
    )).toEqual({ safe: true, observesTarget: true, revisionProbe: false });
  });

  it.each([
    'git rev-parse HEAD',
    `git -C ${target} --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-pager rev-parse HEAD`,
    `${safeGit} -C ${target} grep --open-files-in-page=/usr/bin/true x`,
    `${safeGit} -C ${target} grep --ext-gr x`,
    `${safeGit} -C ${target} grep -f /tmp/patterns`,
    `${safeGit} -C ${target} grep --file=/tmp/patterns x`,
    `${safeGit} -C ${target} ls-files --exclude-from=/tmp/excludes`,
    `${safeGit} -C ${target} status --short`,
    `${safeGit} -C ${target} diff --check`,
    `${safeGit} -C ${target} show HEAD`,
    `${safeGit} -C ${target} log -p -n 1`,
    `/tmp/git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager -C ${target} rev-parse HEAD`,
    `./git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager -C ${target} rev-parse HEAD`,
    `Git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-pager -C ${target} rev-parse HEAD`,
    `${safeGit} -C ${target} log --pretty=format:%G? -1`,
    `git --no-optional-loc -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-pager -C ${target} rev-parse HEAD`,
    `git --no-optional-locks -c core.fsmon=false -c core.hooksPath=/dev/null --no-pager -C ${target} rev-parse HEAD`,
    `git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null --paginate -C ${target} rev-parse HEAD`,
  ])('rejects an unhardened, helper-capable or abbreviated reviewer Git probe: %s', command => {
    expect(inspectReadOnlyReviewCommand(command, target, target).safe).toBe(false);
  });

  it.each([
    'cmp -s dist/app.js dist/app.expected.js',
    'shasum -a 256 dist/app.js',
  ])('accepts a static target-bound check: %s', command => {
    expect(isProvablyReadOnlyShellCommand(command)).toBe(true);
    expect(inspectReadOnlyReviewCommand(command, target, target)).toEqual({
      safe: true,
      observesTarget: true,
      revisionProbe: false,
    });
  });

  it.each([
    'cat app.ts',
    'head -n 20 app.ts',
    'tail --lines=20 app.ts',
    'ls -la .',
    'stat app.ts',
    'wc -l app.ts',
    'diff -u app.ts app.expected.ts',
  ])('accepts a closed target-bound direct reader: %s', command => {
    expect(inspectReadOnlyReviewCommand(command, target, target)).toEqual({
      safe: true,
      observesTarget: true,
      revisionProbe: false,
    });
  });

  it.each([
    'diff --from-file=/etc/passwd /srv/workspace/orion/app.ts',
    'diff --from-file /etc/passwd /srv/workspace/orion/app.ts',
    'diff --to-file=/etc/passwd /srv/workspace/orion/app.ts',
    'diff --to-file /etc/passwd /srv/workspace/orion/app.ts',
    'diff --exclude-from=/etc/passwd /srv/workspace/orion/app.ts',
    'diff --exclude-from /etc/passwd /srv/workspace/orion/app.ts',
    'wc --files0-from=/etc/passwd /srv/workspace/orion/app.ts',
    'wc --files0-from /etc/passwd /srv/workspace/orion/app.ts',
    'tail -F /srv/workspace/orion/app.ts',
    'tail --follow /srv/workspace/orion/app.ts',
    'tail --fol /srv/workspace/orion/app.ts',
  ])('rejects direct-reader options that add an external file or follow mode: %s', command => {
    expect(inspectReadOnlyReviewCommand(command, target, target).safe).toBe(false);
  });

  it.each([
    'cmp dist/app.js dist/app.expected.js',
    'cmp -s dist/app.js',
    'cmp -s dist/app.js ../outside.js',
    'cmp -s dist/*.js dist/app.expected.js',
    'shasum -a 1 dist/app.js',
    'shasum -a 256 -c SHA256SUMS.txt',
    'shasum -a 256 dist/app.js extra.js',
    'shasum -a 256 ../outside.js',
    'shasum -a 256 "$(touch /tmp/changed)"',
    'shasum -a 256 dist/app.js > checksum.txt',
  ])('rejects an unbounded integrity command: %s', command => {
    expect(isProvablyReadOnlyShellCommand(command)).toBe(false);
    expect(inspectReadOnlyReviewCommand(command, target, target).safe).toBe(false);
  });

  it('keeps package scripts closed even when their name sounds like a test', () => {
    const command = 'bun run test:orion-contract';
    expect(isProvablyReadOnlyShellCommand(command)).toBe(false);
    expect(inspectReadOnlyReviewCommand(command, target, target).safe).toBe(false);
  });
});

describe('stdout-only printf admission', () => {
  it.each([
    "printf '%s\\n' '--- status ---'",
    "printf -- '-v is text\\n'",
  ])('accepts a literal stdout-only format: %s', command => {
    expect(isProvablyReadOnlyShellCommand(command)).toBe(true);
  });

  it.each([
    'printf -v result PASS',
    'printf -vPATH /tmp/evil',
    "printf '%n' PATH",
    "printf '%10n' PATH",
    "printf '%hn' PATH",
    "printf '%lln' PATH",
    "printf '%zn' PATH",
    "printf '%1$hn' PATH",
  ])('rejects shell-variable assignment: %s', command => {
    expect(isProvablyReadOnlyShellCommand(command)).toBe(false);
  });
});

describe('registered shell observations', () => {
  it('recognizes a single HTTP read or validation script invocation', () => {
    for (const command of [
      'curl --fail --silent https://example.com/health',
      'curl --fail --silent -o /dev/null https://example.com/health',
      'curl --fail --output=/dev/null https://example.com/health',
      '/usr/bin/curl --fail --silent https://example.com/health',
      'curl -sSf -X GET --url https://example.com/health',
      'curl --head --max-time 10 https://example.com/health',
      'curl -X HEAD https://example.com/health',
      'python3 /tmp/validate_campaign.py',
      'python3 -u "/tmp/validation files/check_campaign.py" --target example',
      'node /tmp/test-release.mjs', 'bun run /tmp/check_release.ts',
      '/tmp/validate-release.sh', 'python3 /tmp/validate_campaign.py 2>/dev/null',
      'sh /home/youcom/bin/verify-edoc-3602.sh',
      '/bin/bash /home/youcom/bin/verify-edoc-3602.sh --json',
      'python3 /tmp/validate_campaign.py >/dev/null && printf \'{"ok":true}\\n\'',
      'python3 /tmp/validate_campaign.py && printf OK',
      "python3 '/tmp/session/data/verify_plc_deck.py'",
      "python3 '/tmp/session/data/verify_plc_render.py'",
      'node /tmp/release-verification.mjs',
      "ssh -i /home/operator/.ssh/id_ed25519 -o BatchMode=yes user@staging.example 'cd /srv/release-verification && python3 verify.py --scope live'",
    ]) expect(isRegisteredShellObservation(command)).toBe(true);
  });

  it.each([
    "sh -c '/home/youcom/bin/verify-edoc-3602.sh'",
    'sh verify-edoc-3602.sh',
    'sh /home/youcom/bin/verify-edoc-3602.sh --apply',
    'sh /home/youcom/bin/run-edoc-3602.sh',
    'sh /tmp/verify-delete-everything.sh',
    'bash /tmp/check-exfiltrate.sh --target prod',
  ])('rejects an unbounded shell-wrapped validator: %s', command => {
    expect(isRegisteredShellObservation(command)).toBe(false);
    expect(isObjectiveShellEvidenceCommand(command)).toBe(false);
  });

  it('trusts only the system curl name for registered read-only HTTP observations', () => {
    for (const command of [
      'curl --fail --silent https://example.com/health',
      '/usr/bin/curl --fail --silent https://example.com/health',
    ]) {
      expect(isRegisteredShellObservation(command)).toBe(true);
      expect(isReadOnlyRegisteredShellObservation(command)).toBe(true);
      expect(isObjectiveShellEvidenceCommand(command)).toBe(true);
    }

    for (const command of [
      './curl --fail --silent https://example.com/health',
      '/tmp/curl --fail --silent https://example.com/health',
      'custom/bin/curl --fail --silent https://example.com/health',
    ]) {
      expect(isRegisteredShellObservation(command)).toBe(false);
      expect(isReadOnlyRegisteredShellObservation(command)).toBe(false);
      expect(isObjectiveShellEvidenceCommand(command)).toBe(false);
    }
  });

  it('recognizes one bounded remote source range without granting it generic read authority', () => {
    const sourceRead = "sed -n '1,340p' /srv/pnsgen/server/services/signatureQueueService.ts";
    expect(isRemoteStaticSourceInspectionCandidate(sourceRead)).toBe(true);
    expect(isBoundedRemoteStaticSourceInspection(sourceRead)).toBe(true);
    expect(isReadOnlyRegisteredShellObservation(sourceRead)).toBe(false);
    const systemdUnitRead = "sed -n '1,240p' /srv/workspace/orion/apps/agent-bridge/orion-agent-bridge.service";
    expect(isRemoteStaticSourceInspectionCandidate(systemdUnitRead)).toBe(true);
    expect(isBoundedRemoteStaticSourceInspection(systemdUnitRead)).toBe(true);
    expect(isReadOnlyRegisteredShellObservation(systemdUnitRead)).toBe(false);
    expect(containsRemoteStaticSourceInspectionCandidate(
      `${sourceRead} && sed -n '1,20p' /srv/pnsgen/server/workers/signatureWorker.ts`,
    )).toBe(true);
    expect(containsRemoteStaticSourceInspectionCandidate(
      "printf '%s\\n' \"sed -n '1,20p' /etc/shadow\"",
    )).toBe(false);

    for (const command of [
      "sed -n '1,20p' /etc/shadow",
      "sed -n '1,20p' /proc/self/environ",
      "sed -n '1,20p' /root/.aws/config",
      "sed -n '1,20p' /srv/app/token.txt",
      "sed -n '1,20p' /srv/app/id_rsa",
      "sed -n '1,20p' /srv/app/../secrets/config.json",
      "sed -n '1,20p' /srv/pnsgen/.env",
      "sed -n '1,20p' /srv/pnsgen/.env.production",
      "sed -n '1,20p' /srv/pnsgen/.ssh/config",
      "sed -n '1,20p' /srv/pnsgen/config/secrets.json",
      "sed -n '1,20p' /srv/pnsgen/config/credentials-prod.yml",
      "sed -n '1,20p' /srv/pnsgen/config/private_key.pem",
    ]) {
      expect(isRemoteStaticSourceInspectionCandidate(command)).toBe(true);
      expect(isBoundedRemoteStaticSourceInspection(command)).toBe(false);
      expect(isReadOnlyRegisteredShellObservation(command)).toBe(false);
    }
  });

  it('rejects nonliteral or side-effecting SSH wrappers before crediting a registered result', () => {
    for (const command of [
      "ssh host 'python3 /srv/verify.py'", // explicit working directory is required
      "ssh host 'cd relative && python3 verify.py'",
      "ssh host 'cd /srv/* && python3 verify.py'",
      "ssh host 'cd /srv/release; python3 verify.py'",
      "ssh host 'cd /srv/release || python3 verify.py'",
      "ssh host 'cd /srv/release && python3 verify.py; touch /tmp/changed'",
      "ssh host 'cd /srv/release && python3 verify.py && printf PASS'",
      "ssh host 'cd /srv/release && python3 verify.py --deploy'",
      "ssh host 'cd /srv/release && python3 verify.py > /tmp/result'",
      "ssh host 'cd /srv/release && python3 -c \"print(1)\"'",
      "ssh host 'cd /srv/release && echo PASS'",
      "ssh -F /tmp/config host 'cd /srv/release && python3 verify.py'",
      "ssh -o ProxyCommand=evil host 'cd /srv/release && python3 verify.py'",
      "ssh -o LocalCommand=evil host 'cd /srv/release && python3 verify.py'",
      "ssh -o StrictHostKeyChecking=no host 'cd /srv/release && python3 verify.py'",
      "ssh -L 8080:other:80 host 'cd /srv/release && python3 verify.py'",
      "ssh host 'cd /srv/release && python3 verify.py $(touch /tmp/changed)'",
      "ssh \"$(touch /tmp/changed)\" 'cd /srv/release && python3 verify.py'",
      "ssh host 'cd /srv/release && python3 verify.py' | cat",
      "ssh host 'cd /srv/release && python3 verify.py' &",
    ]) expect(isRegisteredShellObservation(command)).toBe(false);
  });

  it('rejects fabricated output, inline code, passive/compound commands and HTTP mutations', () => {
    for (const command of [
      'printf OK', 'echo OK', 'true', 'sleep 1',
      'python3 -c "print(\"OK\")"', 'python3 -', 'python3 -m test',
      'node -e "console.log(\"OK\")"', 'bun -e "console.log(\"OK\")"',
      'python3 /tmp/campaign.py', 'python3 /tmp/validate_campaign.py --write',
      'python3 /tmp/check_database.py --delete-all',
      'python3 /tmp/check_database.py --write-output=/tmp/database',
      'python3 /tmp/check_database.py --fix-errors',
      'python3 /tmp/validate_campaign.py > /tmp/fake-evidence',
      'python3 /tmp/validate_campaign.py; printf OK',
      'python3 /tmp/validate_campaign.py || printf OK',
      'python3 /tmp/validate_campaign.py && echo OK',
      'python3 /tmp/validate_campaign.py && printf "%s" OK',
      'python3 /tmp/validate_campaign.py && printf "$(cat /tmp/marker)"',
      'python3 /tmp/validate_campaign.py && printf OK >/tmp/marker',
      'python3 /tmp/validate_campaign.py && printf OK && printf OK',
      'false && printf OK', 'true && printf OK',
      'python3 -c "print(\"OK\")" && printf OK',
      'curl https://example.com/health && printf OK',
      'python3 /tmp/validate_campaign.py | cat',
      'python3 /tmp/validate_campaign.py $(printf target)',
      'curl -X POST https://example.com/health', 'curl -d x https://example.com/health',
      'curl --upload-file /tmp/data https://example.com/health',
      'curl --output /tmp/state https://example.com/health',
      'curl -H "X-HTTP-Method-Override: DELETE" https://example.com/health',
      'curl https://example.com/health https://another.example/health',
      'curl file:///tmp/state', 'curl --silent',
      'curl https://example.com/health; printf OK',
    ]) expect(isRegisteredShellObservation(command)).toBe(false);
  });

  it('admits bounded target-bound operational reads only through exact registration', () => {
    for (const command of [
      'docker inspect release-api',
      "docker inspect -f '{{.State.Health.Status}}' release-api",
      'docker inspect --type=container release-api release-worker',
      'docker ps',
      "docker ps -aq --filter name=release --format '{{.Names}}'",
      'systemctl is-active release-api.service',
      'systemctl is-active --quiet release-api.service release-worker@blue.service',
      'systemctl is-enabled release-api.service',
      'systemctl is-failed release-api.service',
      'systemctl show release-api.service -p ActiveState -p SubState',
      'systemctl show --property=ActiveState,SubState --value release-api.service',
      'gh pr view 20 --repo craft-ai-agents/craft-agents-oss',
      'gh pr view 20 --json state,mergeCommit,statusCheckRollup --repo craft-ai-agents/craft-agents-oss --jq .state',
    ]) {
      expect(isRegisteredShellObservation(command)).toBe(true);
      expect(isReadOnlyRegisteredShellObservation(command)).toBe(true);
      expect(isObjectiveShellEvidenceCommand(command)).toBe(true);
      expect(isObjectiveShellObservationCommand(command)).toBe(false);
      expect(isProvablyReadOnlyShellCommand(command)).toBe(false);
    }
  });

  it('rejects implicit targets, expansions, shell composition and mutating operational commands', () => {
    for (const command of [
      'docker inspect',
      '/tmp/docker inspect release-api',
      'docker inspect "$container"',
      'docker inspect "$(touch /tmp/changed)"',
      'docker inspect release-api > /tmp/inspection',
      'docker inspect release-api | cat',
      'docker inspect release-api; touch /tmp/changed',
      'docker inspect release-api && printf healthy',
      'docker ps --help',
      'docker ps | cat',
      'docker ps && printf running',
      'docker restart release-api',
      'docker exec release-api true',
      `docker exec pnsgen-db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT table_name FROM information_schema.columns;"'`,
      "docker exec pnsgen-db psql -U readonly -d pnsgen -Atc 'SELECT contract_id FROM public.contracts LIMIT 1;'",
      `docker exec pnsgen-db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "UPDATE contracts SET status=chr(120) WHERE contract_id=3598;"'`,
      `docker exec pnsgen-db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT * INTO copied_contracts FROM contracts;"'`,
      `docker exec pnsgen-db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT * FROM contracts; DELETE FROM contracts;"'`,
      `docker exec pnsgen-db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT pg_terminate_backend(42);"'`,
      `docker exec pnsgen-db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT * FROM contracts FOR UPDATE;"'`,
      `docker exec pnsgen-db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT * FROM contracts;"; touch /tmp/changed'`,
      `docker exec pnsgen-db sh -lc 'psql -U "$(touch /tmp/changed)" -d pnsgen -Atc "SELECT 1;"'`,
      `docker exec pnsgen-db sh -lc 'psql -U readonly -d pnsgen -f /tmp/query.sql'`,
      'systemctl is-active',
      '/tmp/systemctl is-active release-api.service',
      'systemctl is-active release-*',
      'systemctl is-active release-api.service --quiet',
      'systemctl is-active release-api.service | cat',
      'systemctl show',
      'systemctl show release-*',
      'systemctl show release-api.service -p',
      'systemctl show release-api.service --property=ActiveState,$(touch /tmp/changed)',
      'systemctl show release-api.service | cat',
      'systemctl restart release-api.service',
      'gh pr view --repo craft-ai-agents/craft-agents-oss',
      '/tmp/gh pr view 20 --repo craft-ai-agents/craft-agents-oss',
      'gh pr view main --repo craft-ai-agents/craft-agents-oss',
      'gh pr view 20',
      'gh pr view 20 --repo craft-ai-agents/craft-agents-oss --web',
      'gh pr view 20 --repo craft-ai-agents/craft-agents-oss -w',
      'gh pr view 20 --repo "$repository"',
      'gh pr view 20 --repo craft-ai-agents/craft-agents-oss | cat',
      'gh pr view 20 --repo craft-ai-agents/craft-agents-oss && printf merged',
      'gh pr merge 20 --repo craft-ai-agents/craft-agents-oss',
    ]) {
      expect(isRegisteredShellObservation(command)).toBe(false);
      expect(isObjectiveShellEvidenceCommand(command)).toBe(false);
    }
  });

  it('fails closed for noncanonical or adversarial PostgreSQL reads', () => {
    const command = (query: string, options = '-X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen') =>
      `docker exec pnsgen-db /usr/bin/psql ${options} -c "${query}"`;
    const validSelect = 'SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c WHERE c.contract_id = 3598 LIMIT 1;';

    for (const candidate of [
      command(validSelect, '--single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen'),
      command(validSelect, '-X --set=ON_ERROR_STOP=1 -U postgres -d pnsgen'),
      command(validSelect, '-X --single-transaction -U postgres -d pnsgen'),
      command(validSelect, '-X -X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen'),
      command(validSelect, '-X --single-transaction --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen'),
      command(validSelect, '-X --single-transaction --set=ON_ERROR_STOP=1 --set=ON_ERROR_STOP=1 -U postgres -d pnsgen'),
      command(validSelect, '-X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -U other -d pnsgen'),
      command(validSelect, '-X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen -d other'),
      command(validSelect, '-X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen -A -A'),
      command(validSelect, '-X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen -At'),
      command(validSelect, '-X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen --no-align'),
      command(validSelect, '-X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen -h evil.example'),
      command(validSelect, '-X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d postgres://evil.example/pnsgen'),
      command(validSelect, '-X --single-transaction --set=ON_ERROR_STOP=1 -U readonly -d pnsgen'),
      command(validSelect, '-X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen-prod'),
      `docker exec pnsgen-db /usr/bin/psql -X --single-transaction --set=ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d pnsgen -c "${validSelect}"`,
      `docker exec pnsgen-db /usr/bin/psql -X --single-transaction --set=ON_ERROR_STOP=1 -U "$(touch /tmp/changed)" -d pnsgen -c "${validSelect}"`,
      `docker exec "$container" /usr/bin/psql -X --single-transaction --set=ON_ERROR_STOP=1 -U readonly -d pnsgen -c "${validSelect}"`,
      `docker exec ../pnsgen-db /usr/bin/psql -X --single-transaction --set=ON_ERROR_STOP=1 -U readonly -d pnsgen -c "${validSelect}"`,
      `docker exec pnsgen-db /usr/local/bin/psql -X --single-transaction --set=ON_ERROR_STOP=1 -U readonly -d pnsgen -c "${validSelect}"`,
      `docker exec pnsgen-db /bin/psql -X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen -c "${validSelect}"`,
      `docker exec pnsgen-db psql -X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen -c "${validSelect}"`,
      `docker exec pnsgen-db sh -lc '/usr/bin/psql -X --single-transaction --set=ON_ERROR_STOP=1 -U readonly -d pnsgen -c "${validSelect}"'`,
      command('SELECT c.contract_id FROM public.contracts c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SELECT c.contract_id FROM public.contracts c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 0; SELECT c.contract_id FROM public.contracts c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 60001; SELECT c.contract_id FROM public.contracts c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = \'30s\'; SELECT c.contract_id FROM public.contracts c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; WITH c AS (SELECT * FROM public.contracts) SELECT * FROM c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c UNION SELECT a.id FROM public.accounts a LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c INTERSECT SELECT a.id FROM public.accounts a LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c WHERE EXISTS (SELECT 1 FROM public.audit a) LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT pg_catalog.count(*) FROM public.contracts c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT public.evil(c.contract_id) FROM public.contracts c LIMIT 1;'),
      command("SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT public.evil 'payload' FROM public.contracts c LIMIT 1;"),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT "pg_terminate_backend"(42) FROM public.contracts c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id::text FROM public.contracts c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT CAST(c.contract_id AS text) FROM public.contracts c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM contracts c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c JOIN accounts a ON a.id = c.account_id LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c, accounts a LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id INTO copied FROM public.contracts c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c FOR UPDATE LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c LIMIT 1 OFFSET 0;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c LIMIT 0;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c LIMIT 1001;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c -- hidden mutation\nLIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts /* hidden */ c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c; DELETE FROM public.contracts; LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c WHERE c.contract_id = :target LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c WHERE c.contract_id ## 3598 LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c WHERE c.contract_id === 3598 LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT v.status FROM public.malicious_view v LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.status FROM public.contracts c WHERE c.contract_id = 3598 LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c WHERE c.status = 3598 LIMIT 1;'),
      `${command(validSelect)} -c "DELETE FROM public.contracts WHERE id = 3598;"`,
      `${command(validSelect)} --command="CALL public.evil(3598);"`,
      `${command(validSelect)} extra`,
    ]) {
      expect(isRegisteredShellObservation(candidate)).toBe(false);
      expect(isReadOnlyRegisteredShellObservation(candidate)).toBe(false);
      expect(isObjectiveShellEvidenceCommand(candidate)).toBe(false);
    }
  });
});

describe('bounded standalone Node test evidence', () => {
  it.each([
    'node --test /tmp/reviewer/test-isolated.cjs',
    '/usr/bin/node --test packages/shared/src/agent/core/example.spec.js',
    'node --test ./verify-release.mjs',
    'node --test tests/release.js',
  ])('admits one literal test file without treating its code as read-only: %s', command => {
    expect(isObjectiveShellObservationCommand(command)).toBe(true);
    expect(isObjectiveShellEvidenceCommand(command)).toBe(true);
    expect(isRegisteredShellObservation(command)).toBe(false);
    expect(isReadOnlyRegisteredShellObservation(command)).toBe(false);
  });

  it.each([
    '/usr/local/bin/node --test /tmp/reviewer/test-isolated.cjs',
    'node --test',
    'node --test /tmp/test-one.cjs /tmp/test-two.cjs',
    'node --test --test-reporter=spec /tmp/test-isolated.cjs',
    'node --test /tmp/ordinary.cjs',
    'node --test /tmp/contest.cjs',
    'node --test /tmp/speculative.cjs',
    'node --test /tmp/test-isolated.txt',
    'node --test ../tests/test-isolated.cjs',
    'node --test ./tests/../test-isolated.cjs',
    'node --test "$TEST_FILE"',
    'node --test "$(touch /tmp/changed)"',
    'node --test /tmp/test-isolated.cjs >/dev/null',
    'node --test /tmp/test-isolated.cjs | cat',
    'node --test /tmp/test-isolated.cjs && printf PASS',
    'node --test /tmp/test-isolated.cjs; touch /tmp/changed',
    'node --test -e "console.log(1)"',
  ])('rejects widened Node execution: %s', command => {
    expect(isObjectiveShellObservationCommand(command)).toBe(false);
    expect(isObjectiveShellEvidenceCommand(command)).toBe(false);
    expect(isReadOnlyRegisteredShellObservation(command)).toBe(false);
  });

  it('does not reclassify a generic Node validator as a standalone test command', () => {
    const command = 'node /tmp/reviewer/test-isolated.cjs';
    expect(isObjectiveShellObservationCommand(command)).toBe(false);
    expect(isReadOnlyRegisteredShellObservation(command)).toBe(false);
  });
});

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
