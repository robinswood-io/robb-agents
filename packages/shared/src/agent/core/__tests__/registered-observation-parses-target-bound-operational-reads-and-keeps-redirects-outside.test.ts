import { expect, it } from "bun:test";
import { classifyBoundedTargetedRemoteOperationalInspection, classifyNestedSshReadOnlyRemoteObservationRepair, classifyReadOnlyRemoteObservationRepair, isBoundedTargetedRemoteOperationalInspection, isProvablyReadOnlyShellCommand } from "../registered-observation.ts";
import { legacyGitWithoutSignatureGuards, safeGit } from "./testing/registered-observation-fixture.ts";

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
