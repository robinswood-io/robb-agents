/**
 * Tests for mode-manager.ts shell command security
 *
 * These tests verify that dangerous shell commands are blocked in Safe (Explore) mode
 * while legitimate read-only commands are allowed.
 */
import { describe, it, expect } from 'bun:test';
import "path";
import "fs";
import "os";
import "../src/agent/powershell-validator.ts";
import { getBashRejectionReason, formatBashRejectionMessage, extractBashWriteTarget, looksLikePotentialWrite, type CompiledBashPattern } from '../src/agent/mode-manager.ts';
import "../src/agent/powershell-validator.ts";
import "../src/agent/powershell-validator.ts";
import "../src/agent/powershell-validator.ts";
import "../src/agent/mode-manager.ts";

describe('getBashRejectionReason with pattern metadata', () => {
  // Create test config with patterns that have comments
  const testPatterns: CompiledBashPattern[] = [
    { regex: /^ls\b/, source: '^ls\\b', comment: 'List directory contents' },
    { regex: /^git\s+(status|log|diff)\b/, source: '^git\\s+(status|log|diff)\\b', comment: 'Git read-only operations' },
    { regex: /^cat\b/, source: '^cat\\b', comment: 'Display file contents' },
  ];

  const testConfig = {
    blockedTools: new Set(['Write', 'Edit']),
    readOnlyBashPatterns: testPatterns,
    readOnlyMcpPatterns: [],
    allowedApiEndpoints: [],
    allowedWritePaths: [],
    displayName: 'Test Mode',
    shortcutHint: 'SHIFT+TAB',
  };

  describe('no_safe_pattern rejection includes relevant patterns', () => {
    it('should find relevant git pattern when command starts with git', () => {
      const reason = getBashRejectionReason('git -C /path status', testConfig);
      expect(reason).not.toBeNull();
      expect(reason?.type).toBe('no_safe_pattern');

      if (reason?.type === 'no_safe_pattern') {
        expect(reason.command).toBe('git -C /path status');
        expect(reason.relevantPatterns.length).toBeGreaterThan(0);
        expect(reason.relevantPatterns[0]?.source).toContain('git');
        expect(reason.relevantPatterns[0]?.comment).toBe('Git read-only operations');
      }
    });

    it('should find relevant ls pattern when ls command is blocked for other reasons', () => {
      // 'ls' command starts with allowed pattern but has flags not matching the pattern test config
      // Let's test with a command that would find the pattern by keyword matching
      // In our test config, '^ls\b' matches 'ls' commands
      // We need a command that starts with 'ls' but doesn't match because it has
      // dangerous operators (which are checked AFTER pattern matching)
      // Actually, for this test, let's just verify the pattern finding logic directly
      // by using a command that starts with the same word as a pattern

      // Add a pattern that requires specific subcommand like git
      // 'git push' doesn't match '^git\s+(status|log|diff)\b' but should find the git pattern
      const reason = getBashRejectionReason('git push origin main', testConfig);
      expect(reason).not.toBeNull();
      expect(reason?.type).toBe('no_safe_pattern');

      if (reason?.type === 'no_safe_pattern') {
        expect(reason.relevantPatterns.length).toBeGreaterThan(0);
        expect(reason.relevantPatterns.some(p => p.source.includes('git'))).toBe(true);
        expect(reason.relevantPatterns[0]?.comment).toBe('Git read-only operations');
      }
    });

    it('should return empty relevant patterns for unknown commands', () => {
      const reason = getBashRejectionReason('unknowncommand arg1 arg2', testConfig);
      expect(reason).not.toBeNull();
      expect(reason?.type).toBe('no_safe_pattern');

      if (reason?.type === 'no_safe_pattern') {
        expect(reason.relevantPatterns.length).toBe(0);
      }
    });
  });

  describe('formatBashRejectionMessage shows pattern info', () => {
    it('should include mismatch analysis or pattern comment in error message', () => {
      const reason = getBashRejectionReason('git -C /path status', testConfig);
      expect(reason).not.toBeNull();
      if (!reason) return;

      const message = formatBashRejectionMessage(reason, testConfig);
      expect(message).toContain('git -C /path status');
      // With mismatch analysis, we show matched prefix and suggestion instead of raw patterns
      // Either mismatch analysis OR relevant patterns should be shown
      expect(message).toContain('Git read-only operations');
    });

    it('should show mode switch hint', () => {
      const reason = getBashRejectionReason('git push', testConfig);
      expect(reason).not.toBeNull();
      if (!reason) return;

      const message = formatBashRejectionMessage(reason, testConfig);
      expect(message).toContain('SHIFT+TAB');
    });

    it('should handle commands with no relevant patterns gracefully', () => {
      const reason = getBashRejectionReason('somecmd arg', testConfig);
      expect(reason).not.toBeNull();
      if (!reason) return;

      const message = formatBashRejectionMessage(reason, testConfig);
      expect(message).toContain('somecmd arg');
      expect(message).toContain('not in the read-only allowlist');
    });
  });

  describe('parse_error messaging', () => {
    it('should include tokenizer bug hint for known doubleQuoting parser crashes', () => {
      const message = formatBashRejectionMessage(
        {
          type: 'parse_error',
          error: "TypeError: Cannot read properties of undefined (reading 'doubleQuoting')",
        },
        testConfig
      );

      expect(message).toContain('known bash-parser tokenizer bug');
      expect(message).toContain('single quotes for regex/text arguments');
      expect(message).toContain('`rg -n "a|b|$|c" ...`');
      expect(message).toContain('SHIFT+TAB');
    });

    it('should not include tokenizer bug hint for unrelated parse errors', () => {
      const message = formatBashRejectionMessage(
        {
          type: 'parse_error',
          error: 'Unexpected EOF while parsing command',
        },
        testConfig
      );

      expect(message).not.toContain('known bash-parser tokenizer bug');
      expect(message).toContain('could not parse command safely');
    });
  });

  describe('mismatch analysis with incr-regex', () => {
    it('should include mismatch analysis for git command with flags', () => {
      const reason = getBashRejectionReason('git -C /path status', testConfig);
      expect(reason).not.toBeNull();
      expect(reason?.type).toBe('no_safe_pattern');

      if (reason?.type === 'no_safe_pattern') {
        // Mismatch analysis should be present since git pattern exists
        expect(reason.mismatchAnalysis).toBeDefined();
        if (reason.mismatchAnalysis) {
          // Should have matched "git " before failing
          expect(reason.mismatchAnalysis.matchedPrefix.startsWith('git')).toBe(true);
          // Should identify the failed token
          expect(reason.mismatchAnalysis.failedToken).toBe('-C');
          // Should provide a suggestion for flags before subcommand
          expect(reason.mismatchAnalysis.suggestion).toBeDefined();
          expect(reason.mismatchAnalysis.suggestion).toContain('flag');
        }
      }
    });

    it('should detect unknown subcommand and provide suggestion', () => {
      const reason = getBashRejectionReason('git push origin', testConfig);
      expect(reason).not.toBeNull();
      expect(reason?.type).toBe('no_safe_pattern');

      if (reason?.type === 'no_safe_pattern') {
        expect(reason.mismatchAnalysis).toBeDefined();
        if (reason.mismatchAnalysis) {
          // Should have matched "git " before failing at "push"
          expect(reason.mismatchAnalysis.matchedPrefix).toContain('git');
          expect(reason.mismatchAnalysis.failedToken).toBe('push');
        }
      }
    });

    it('should return no mismatch analysis for completely unknown commands', () => {
      const reason = getBashRejectionReason('unknowncmd arg', testConfig);
      expect(reason).not.toBeNull();
      expect(reason?.type).toBe('no_safe_pattern');

      if (reason?.type === 'no_safe_pattern') {
        // No pattern matches even partially, so no mismatch analysis
        expect(reason.mismatchAnalysis).toBeUndefined();
      }
    });

    it('should format mismatch analysis in error message', () => {
      const reason = getBashRejectionReason('git -C /path status', testConfig);
      expect(reason).not.toBeNull();
      if (!reason) return;

      const message = formatBashRejectionMessage(reason, testConfig);

      // Should show matched prefix
      expect(message).toContain('Matched:');

      // Should show where it failed
      expect(message).toContain('Failed at:');

      // Should show suggestion if available
      if (reason.type === 'no_safe_pattern' && reason.mismatchAnalysis?.suggestion) {
        expect(message).toContain(reason.mismatchAnalysis.suggestion);
      }
    });
  });
});

// ============================================================
// extractBashWriteTarget Tests
// ============================================================

describe('extractBashWriteTarget', () => {
  describe('Codex subshell pattern (zsh/bash -lc)', () => {
    it('should extract path from /bin/zsh -lc "cat <<\'EOF\' > /path/to/plans/file.md..."', () => {
      const cmd = `/bin/zsh -lc "cat <<'EOF' > /Users/test/.craft-agent/workspaces/ws/sessions/s1/plans/plan.md\n# Plan\nEOF"`;
      expect(extractBashWriteTarget(cmd)).toBe('/Users/test/.craft-agent/workspaces/ws/sessions/s1/plans/plan.md');
    });

    it('should extract path from bash -c "echo > /path/file"', () => {
      const cmd = 'bash -c "echo content > /tmp/plans/output.md"';
      expect(extractBashWriteTarget(cmd)).toBe('/tmp/plans/output.md');
    });

    it('should extract path from sh -c "cat > /path/file"', () => {
      const cmd = 'sh -c "cat > /some/plans/file.md"';
      expect(extractBashWriteTarget(cmd)).toBe('/some/plans/file.md');
    });

    it('should extract path from zsh -lc (without /bin/ prefix)', () => {
      const cmd = `zsh -lc "cat <<'EOF' > /Users/test/plans/file.md\ncontent\nEOF"`;
      expect(extractBashWriteTarget(cmd)).toBe('/Users/test/plans/file.md');
    });
  });

  describe('direct redirect pattern', () => {
    it('should extract path from cat > /path/file', () => {
      expect(extractBashWriteTarget('cat > /tmp/plans/file.md')).toBe('/tmp/plans/file.md');
    });

    it('should extract path from echo >> /path/file', () => {
      expect(extractBashWriteTarget('echo content >> /tmp/plans/file.md')).toBe('/tmp/plans/file.md');
    });
  });

  describe('should return null for non-write commands', () => {
    it('should return null for read-only commands', () => {
      expect(extractBashWriteTarget('ls -la')).toBeNull();
      expect(extractBashWriteTarget('git status')).toBeNull();
      expect(extractBashWriteTarget('cat file.txt')).toBeNull();
    });

    it('should return null for /dev/null redirects', () => {
      expect(extractBashWriteTarget('ls > /dev/null')).toBeNull();
    });
  });

  describe('PowerShell Out-File pattern', () => {
    it('should extract path from Out-File -FilePath with single quotes', () => {
      const cmd = `@('# Plan') | Out-File -FilePath 'C:\\Users\\test\\.craft-agent\\plans\\plan.md' -Encoding utf8`;
      expect(extractBashWriteTarget(cmd)).toBe('C:\\Users\\test\\.craft-agent\\plans\\plan.md');
    });

    it('should extract path from Out-File -FilePath with double quotes', () => {
      const cmd = `@("# Plan") | Out-File -FilePath "C:\\plans\\plan.md" -Encoding utf8`;
      expect(extractBashWriteTarget(cmd)).toBe('C:\\plans\\plan.md');
    });

    it('should extract path from Out-File -Path', () => {
      const cmd = `@('# Plan') | Out-File -Path 'C:\\plans\\plan.md'`;
      expect(extractBashWriteTarget(cmd)).toBe('C:\\plans\\plan.md');
    });

    it('should be case insensitive for Out-File', () => {
      const cmd = `@('# Plan') | out-file -filepath 'C:\\plans\\plan.md'`;
      expect(extractBashWriteTarget(cmd)).toBe('C:\\plans\\plan.md');
    });

    it('should extract path from full powershell.exe -Command wrapper', () => {
      // This is the exact format Codex uses on Windows
      const cmd = `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "@('# Sample Plan', '', '## Goal', 'Submit a sample plan for tool testing.', '', '## Steps', '1. Confirm requirements.', '2. Prepare plan file in the session plans folder.', '3. Submit the plan for approval.') | Out-File -FilePath 'C:\\Users\\balin\\.craft-agent\\workspaces\\my-workspace\\sessions\\260208-wild-sky\\plans\\sample-plan.md' -Encoding utf8"`;
      expect(extractBashWriteTarget(cmd)).toBe('C:\\Users\\balin\\.craft-agent\\workspaces\\my-workspace\\sessions\\260208-wild-sky\\plans\\sample-plan.md');
    });
  });

  describe('PowerShell Set-Content/Add-Content pattern', () => {
    it('should extract path from Set-Content -Path', () => {
      const cmd = `'content' | Set-Content -Path 'C:\\plans\\plan.md'`;
      expect(extractBashWriteTarget(cmd)).toBe('C:\\plans\\plan.md');
    });

    it('should extract path from Add-Content -Path', () => {
      const cmd = `'more content' | Add-Content -Path 'C:\\plans\\plan.md'`;
      expect(extractBashWriteTarget(cmd)).toBe('C:\\plans\\plan.md');
    });
  });

  describe('PowerShell with escaped quotes (powershell.exe -Command wrapper, regex fallback)', () => {
    // These patterns are a REQUIRED fallback for when PowerShell AST parsing
    // is unavailable (e.g. in the Codex agent context where isPowerShellAvailable() = false).
    it('should extract path from Set-Content -Path with escaped quotes', () => {
      const cmd = `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Set-Content -Path \\"C:\\Users\\test\\plans\\plan.md\\" -Value @('# Plan')"`;
      expect(extractBashWriteTarget(cmd)).toBe('C:\\Users\\test\\plans\\plan.md');
    });

    it('should extract path from Add-Content -Path with escaped quotes', () => {
      const cmd = `powershell.exe -Command "Add-Content -Path \\"C:\\Users\\test\\plans\\plan.md\\" -Value 'more content'"`;
      expect(extractBashWriteTarget(cmd)).toBe('C:\\Users\\test\\plans\\plan.md');
    });

    it('should extract path from Out-File with escaped quotes', () => {
      const cmd = `powershell.exe -Command "@('# Plan') | Out-File -FilePath \\"C:\\Users\\test\\plans\\plan.md\\" -Encoding utf8"`;
      expect(extractBashWriteTarget(cmd)).toBe('C:\\Users\\test\\plans\\plan.md');
    });

    it('should extract path from the exact Codex-generated Set-Content pattern', () => {
      const cmd = `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Set-Content -Path \\"C:\\Users\\balin\\.craft-agent\\workspaces\\my-workspace\\sessions\\260208-aware-bamboo\\plans\\slack-api-source-plan.md\\" -Value @('# Plan: Add Slack API source (OAuth, read/write)','', '## Goal','Set up a Slack API source.')"`;
      expect(extractBashWriteTarget(cmd)).toBe('C:\\Users\\balin\\.craft-agent\\workspaces\\my-workspace\\sessions\\260208-aware-bamboo\\plans\\slack-api-source-plan.md');
    });
  });

});

// ============================================================
// looksLikePotentialWrite Tests
// ============================================================

describe('looksLikePotentialWrite', () => {
  it('should detect PowerShell Out-File', () => {
    expect(looksLikePotentialWrite(`@('# Plan') | Out-File 'path'`)).toBe(true);
  });

  it('should detect PowerShell Set-Content', () => {
    expect(looksLikePotentialWrite(`'content' | Set-Content 'path'`)).toBe(true);
  });

  it('should detect PowerShell Add-Content', () => {
    expect(looksLikePotentialWrite(`'content' | Add-Content 'path'`)).toBe(true);
  });

  it('should detect bash redirect', () => {
    expect(looksLikePotentialWrite(`echo "content" > file.txt`)).toBe(true);
  });

  it('should detect bash append redirect', () => {
    expect(looksLikePotentialWrite(`echo "content" >> file.txt`)).toBe(true);
  });

  it('should not detect read-only commands', () => {
    expect(looksLikePotentialWrite(`ls -la`)).toBe(false);
    expect(looksLikePotentialWrite(`git status`)).toBe(false);
    expect(looksLikePotentialWrite(`cat file.txt`)).toBe(false);
  });

  it('should be case insensitive', () => {
    expect(looksLikePotentialWrite(`out-file`)).toBe(true);
    expect(looksLikePotentialWrite(`OUT-FILE`)).toBe(true);
  });
});
