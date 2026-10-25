import { describe, expect, it } from "bun:test";
import { containsLocalSshTransportInvocation } from "../registered-observation.ts";

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
