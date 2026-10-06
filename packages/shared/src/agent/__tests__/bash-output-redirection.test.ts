import { describe, expect, it } from 'bun:test';
import { hasShellOutputRedirection } from '../bash-validator.ts';

describe('shell output redirection as objective evidence', () => {
  it('ignores only a literal null destination, including shell quotes and append', () => {
    for (const command of [
      'python3 validate.py >/dev/null', "python3 validate.py >'/dev/null'", 'python3 validate.py >"/dev/null"',
      'python3 validate.py >> /dev/null', 'python3 validate.py >/dev/null 2>&1',
      'python3 validate.py 2>/dev/null', 'printf "value > other"',
    ]) expect(hasShellOutputRedirection(command)).toBe(false);
  });

  it('retains writes to real paths and unresolved expansion targets', () => {
    for (const command of [
      'echo ok >output.json', 'echo ok >/dev/null.txt', 'echo ok >./dev/null',
      'echo ok >$DEST', 'echo ok >"/dev/null${SUFFIX}"', 'echo ok >/dev/$(echo null)',
      'echo ok >/dev/null && echo saved >output.json', 'echo "$(echo saved >output.json)" >/dev/null',
    ]) expect(hasShellOutputRedirection(command)).toBe(true);
  });
});
