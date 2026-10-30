/**
 * Tests for mode-manager.ts shell command security
 *
 * These tests verify that dangerous shell commands are blocked in Safe (Explore) mode
 * while legitimate read-only commands are allowed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { setPowerShellValidatorRoot } from "../src/agent/powershell-validator.ts";
import { shouldAllowToolInMode } from '../src/agent/mode-manager.ts';

// ============================================================
// shouldAllowToolInMode - Bash Plans Folder Exception Tests
// ============================================================

describe('shouldAllowToolInMode - Bash plans folder exception', () => {
  // Use real temp directories so isPathWithinDirectory() can resolve paths.
  // The function does filesystem validation (symlink-escape protection) which
  // requires the paths to actually exist on disk.
  const testRoot = join(tmpdir(), `mode-manager-plans-test-${process.pid}`);
  const plansFolderPath = join(testRoot, 'plans');

  beforeAll(() => {
    setPowerShellValidatorRoot(join(import.meta.dir, '../src/agent'));
    mkdirSync(plansFolderPath, { recursive: true });
  });

  afterAll(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  const isWindows = process.platform === 'win32';

  describe('should allow bash writes to plans folder in safe mode', () => {
    it('should allow Codex-style zsh write to plans folder', () => {
      const command = `/bin/zsh -lc "cat <<'EOF' > ${plansFolderPath}/my-plan.md\n# Plan\n## Steps\n1. Do thing\nEOF"`;
      const result = shouldAllowToolInMode(
        'Bash',
        { command },
        'safe',
        { plansFolderPath }
      );
      expect(result.allowed).toBe(true);
    });

    it('should allow direct redirect to plans folder', () => {
      const command = `cat > ${plansFolderPath}/plan.md`;
      const result = shouldAllowToolInMode(
        'Bash',
        { command },
        'safe',
        { plansFolderPath }
      );
      expect(result.allowed).toBe(true);
    });

    it.skipIf(!isWindows)('should allow PowerShell Out-File to plans folder', () => {
      const windowsPlansFolderPath = 'C:\\Users\\test\\.craft-agent\\workspaces\\ws\\sessions\\s1\\plans';
      const command = `@('# Plan', '', '## Steps', '1. Do thing') | Out-File -FilePath '${windowsPlansFolderPath}\\plan.md' -Encoding utf8`;
      const result = shouldAllowToolInMode(
        'Bash',
        { command },
        'safe',
        { plansFolderPath: windowsPlansFolderPath }
      );
      expect(result.allowed).toBe(true);
    });

    it.skipIf(!isWindows)('should allow PowerShell Set-Content to plans folder', () => {
      const windowsPlansFolderPath = 'C:\\Users\\test\\.craft-agent\\workspaces\\ws\\sessions\\s1\\plans';
      const command = `'# Plan content' | Set-Content -Path '${windowsPlansFolderPath}\\plan.md'`;
      const result = shouldAllowToolInMode(
        'Bash',
        { command },
        'safe',
        { plansFolderPath: windowsPlansFolderPath }
      );
      expect(result.allowed).toBe(true);
    });

    it.skipIf(!isWindows)('should allow Bash write with different case in path (Windows compatibility)', () => {
      // On Windows, paths are case-insensitive. The system might report "C:\Users\Balin\..."
      // but the command might use "C:\Users\balin\..." - both should work.
      const plansFolderPath = 'C:\\Users\\Balin\\.craft-agent\\workspaces\\ws\\sessions\\s1\\plans';
      const command = `@('# Plan') | Out-File -FilePath 'C:\\Users\\balin\\.craft-agent\\workspaces\\ws\\sessions\\s1\\plans\\plan.md' -Encoding utf8`;
      const result = shouldAllowToolInMode(
        'Bash',
        { command },
        'safe',
        { plansFolderPath }
      );
      expect(result.allowed).toBe(true);
    });

    it.skipIf(!isWindows)('should allow Unix redirect with different case in path (Windows compatibility)', () => {
      const plansFolderPath = 'C:\\Users\\Balin\\.craft-agent\\plans';
      const command = `printf '# Plan' > "C:\\Users\\balin\\.craft-agent\\plans\\plan.md"`;
      const result = shouldAllowToolInMode(
        'Bash',
        { command },
        'safe',
        { plansFolderPath }
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe('should allow Write/Edit to plans folder with case-insensitive paths', () => {
    it.skipIf(!isWindows)('should allow Write with different case in path (Windows compatibility)', () => {
      // Simulating Windows where system reports "C:\Users\Balin\..." but tool uses "C:\Users\balin\..."
      const plansFolderPath = 'C:\\Users\\Balin\\.craft-agent\\workspaces\\ws\\sessions\\s1\\plans';
      const result = shouldAllowToolInMode(
        'Write',
        { file_path: 'C:\\Users\\balin\\.craft-agent\\workspaces\\ws\\sessions\\s1\\plans\\plan.md', content: '# Plan' },
        'safe',
        { plansFolderPath }
      );
      expect(result.allowed).toBe(true);
    });

    it.skipIf(!isWindows)('should allow Edit with different case in path (Windows compatibility)', () => {
      const plansFolderPath = 'C:\\Users\\Balin\\.craft-agent\\plans';
      const result = shouldAllowToolInMode(
        'Edit',
        { file_path: 'C:\\Users\\balin\\.craft-agent\\plans\\plan.md', old_string: 'old', new_string: 'new' },
        'safe',
        { plansFolderPath }
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe('should block bash writes to other paths in safe mode', () => {
    it('should block Codex-style zsh write to non-plans path', () => {
      const command = `/bin/zsh -lc "cat <<'EOF' > /tmp/evil.sh\nrm -rf /\nEOF"`;
      const result = shouldAllowToolInMode(
        'Bash',
        { command },
        'safe',
        { plansFolderPath }
      );
      expect(result.allowed).toBe(false);
    });

    it('should block direct redirect to non-plans path', () => {
      const command = 'echo bad > /etc/hosts';
      const result = shouldAllowToolInMode(
        'Bash',
        { command },
        'safe',
        { plansFolderPath }
      );
      expect(result.allowed).toBe(false);
    });
  });

  // Note: Read-only command tests (ls, git status) are not included here because
  // shouldAllowToolInMode uses SAFE_MODE_CONFIG which has empty patterns at test time
  // (patterns are loaded from default.json at runtime). Read-only bash command validation
  // is thoroughly tested via isReadOnlyBashCommandWithConfig + TEST_MODE_CONFIG above.

  describe('should not produce false write errors for /dev/null redirects', () => {
    it('should not claim 2>/dev/null is a write attempt', () => {
      const command = 'ls -la /some/path 2>/dev/null || echo "not found"';
      const result = shouldAllowToolInMode(
        'Bash',
        { command },
        'safe',
        { plansFolderPath }
      );
      // May be blocked for other reasons (e.g. no matching safe pattern),
      // but should NOT say "appears to write files"
      if (!result.allowed) {
        expect(result.reason).not.toContain('appears to write files');
      }
    });

    it('should not claim >/dev/null is a write attempt', () => {
      const command = 'some-command >/dev/null 2>&1';
      const result = shouldAllowToolInMode(
        'Bash',
        { command },
        'safe',
        { plansFolderPath }
      );
      if (!result.allowed) {
        expect(result.reason).not.toContain('appears to write files');
      }
    });
  });
});
