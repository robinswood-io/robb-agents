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
import { getBashRejectionReason, type CompiledBashPattern } from '../src/agent/mode-manager.ts';
import "../src/agent/powershell-validator.ts";
import "../src/agent/powershell-validator.ts";
import "../src/agent/powershell-validator.ts";
import { normalizeWindowsPathsForBashParser } from '../src/agent/mode-manager.ts';

describe('normalizeWindowsPathsForBashParser', () => {
  describe('double-quoted Windows paths', () => {
    it('should preserve non-special backslashes inside double quotes (bash-parser keeps them)', () => {
      // bash-parser only interprets \\ \" \$ \` \! inside double quotes.
      // All other \X are kept as literal \X, so we don't need to convert them.
      const result = normalizeWindowsPathsForBashParser('ls "C:\\Users\\balin\\.craft-agent\\workspaces"');
      expect(result).toBe('ls "C:\\Users\\balin\\.craft-agent\\workspaces"');
    });

    it('should fix trailing backslash before closing quote (the critical bug)', () => {
      // This was the "Unclosed quote" bug: bash-parser sees \" as escaped quote.
      // The fix converts \" → /" so bash-parser sees the closing quote.
      const result = normalizeWindowsPathsForBashParser('ls "C:\\Users\\balin\\sources\\"');
      expect(result).toBe('ls "C:\\Users\\balin\\sources/"');
    });

    it('should convert double-backslash to double-forward-slash', () => {
      const result = normalizeWindowsPathsForBashParser('echo "path\\\\file"');
      expect(result).toBe('echo "path//file"');
    });

    it('should preserve real bash escapes inside double quotes', () => {
      const result = normalizeWindowsPathsForBashParser('echo "hello\\nworld"');
      expect(result).toBe('echo "hello\\nworld"');
    });

    it('should preserve escaped dollar signs', () => {
      const result = normalizeWindowsPathsForBashParser('echo "\\$HOME"');
      expect(result).toBe('echo "\\$HOME"');
    });
  });

  describe('unquoted Windows paths', () => {
    it('should convert drive-letter paths', () => {
      const result = normalizeWindowsPathsForBashParser('ls C:\\Users\\balin\\Desktop');
      expect(result).toBe('ls C:/Users/balin/Desktop');
    });

    it('should handle path at start of command', () => {
      const result = normalizeWindowsPathsForBashParser('C:\\Windows\\System32\\cmd.exe /c dir');
      expect(result).toBe('C:/Windows/System32/cmd.exe /c dir');
    });

    it('should handle multiple unquoted paths', () => {
      const result = normalizeWindowsPathsForBashParser('diff C:\\a\\file.txt C:\\b\\file.txt');
      expect(result).toBe('diff C:/a/file.txt C:/b/file.txt');
    });
  });

  describe('single-quoted strings', () => {
    it('should pass through single-quoted content verbatim', () => {
      const result = normalizeWindowsPathsForBashParser("echo 'C:\\Users\\test'");
      expect(result).toBe("echo 'C:\\Users\\test'");
    });
  });

  describe('mixed content', () => {
    it('should handle commands with no Windows paths', () => {
      const result = normalizeWindowsPathsForBashParser('git status && git log --oneline');
      expect(result).toBe('git status && git log --oneline');
    });

    it('should handle compound commands with quoted Windows paths', () => {
      // Inside double quotes, only \\ and \" are converted
      const result = normalizeWindowsPathsForBashParser('ls "C:\\Users\\test" && pwd');
      expect(result).toBe('ls "C:\\Users\\test" && pwd');
    });

    it('should handle compound commands with unquoted Windows paths', () => {
      const result = normalizeWindowsPathsForBashParser('ls C:\\Users\\test && pwd');
      expect(result).toBe('ls C:/Users/test && pwd');
    });
  });

  describe('integration: fixes for the three reported bugs', () => {
    it('should fix the "Unclosed quote" parse error (trailing backslash-quote)', () => {
      // Bug 1: ls "C:\path\" → bash-parser sees \" as escaped quote, never closes string
      const normalized = normalizeWindowsPathsForBashParser('ls "C:\\Users\\balin\\.craft-agent\\workspaces\\my-workspace\\sources\\"');
      // The trailing \" should become /" so the string closes properly
      expect(normalized).toEndWith('sources/"');
    });

    it('should fix backslash stripping in unquoted Windows paths', () => {
      // Bug 2: ls C:\Users\balin\... → bash-parser strips backslashes → C:Usersbalin...
      const normalized = normalizeWindowsPathsForBashParser('ls C:\\Users\\balin\\.craft-agent');
      expect(normalized).toBe('ls C:/Users/balin/.craft-agent');
      expect(normalized).not.toContain('C:Users');
    });
  });
});

// ============================================================
// End-to-End Integration Tests: Windows paths through getBashRejectionReason
// ============================================================
// These tests call getBashRejectionReason directly with real Windows paths
// to verify the full normalization → bash-parser → pattern-matching pipeline.
// Since we're on Windows (process.platform === 'win32'), the normalization
// path is exercised automatically.

describe('Windows path handling through getBashRejectionReason', () => {
  // Config with common read-only patterns for integration testing
  const integrationConfig = {
    blockedTools: new Set(['Write', 'Edit']),
    readOnlyBashPatterns: [
      { regex: /^ls\b/, source: '^ls\\b', comment: 'List directory contents' },
      { regex: /^cat\b/, source: '^cat\\b', comment: 'Display file contents' },
      { regex: /^head\b/, source: '^head\\b', comment: 'Output first part of files' },
      { regex: /^tail\b/, source: '^tail\\b', comment: 'Output last part of files' },
      { regex: /^find\b/, source: '^find\\b', comment: 'Search for files' },
      { regex: /^grep\b/, source: '^grep\\b', comment: 'Search file contents' },
      { regex: /^diff\b/, source: '^diff\\b', comment: 'Compare files' },
      { regex: /^git\s+(status|log|diff|show|branch)\b/, source: '^git\\s+(status|log|diff|show|branch)\\b', comment: 'Git read-only operations' },
      { regex: /^echo\b/, source: '^echo\\b', comment: 'Print text' },
      { regex: /^pwd\b/, source: '^pwd\\b', comment: 'Print working directory' },
      { regex: /^wc\b/, source: '^wc\\b', comment: 'Count lines, words, bytes' },
    ] as CompiledBashPattern[],
    readOnlyMcpPatterns: [],
    allowedApiEndpoints: [],
    allowedWritePaths: [],
    displayName: 'Test',
    shortcutHint: 'SHIFT+TAB',
  };

  const isWindows = process.platform === 'win32';

  describe('commands with Windows paths that should PASS validation', () => {
    it('should allow quoted path with non-special backslashes', () => {
      if (!isWindows) return;
      const reason = getBashRejectionReason('ls "C:\\Users\\balin\\.craft-agent\\workspaces"', integrationConfig);
      expect(reason).toBeNull();
    });

    it('should allow trailing backslash-quote (the critical "Unclosed quote" bug)', () => {
      if (!isWindows) return;
      const reason = getBashRejectionReason('ls "C:\\Users\\balin\\sources\\"', integrationConfig);
      expect(reason).toBeNull();
    });

    it('should allow unquoted drive-letter path', () => {
      if (!isWindows) return;
      const reason = getBashRejectionReason('ls C:\\Users\\balin\\Desktop', integrationConfig);
      expect(reason).toBeNull();
    });

    it('should allow simple quoted path with cat', () => {
      if (!isWindows) return;
      const reason = getBashRejectionReason('cat "C:\\Users\\test\\file.txt"', integrationConfig);
      expect(reason).toBeNull();
    });

    it('should allow unquoted path as non-first argument', () => {
      if (!isWindows) return;
      const reason = getBashRejectionReason('head -n 50 C:\\temp\\log.txt', integrationConfig);
      expect(reason).toBeNull();
    });

    it('should allow compound command with Windows path', () => {
      if (!isWindows) return;
      const reason = getBashRejectionReason('git status && ls "C:\\Users\\test"', integrationConfig);
      expect(reason).toBeNull();
    });

    it('should allow find with unquoted path and flags', () => {
      if (!isWindows) return;
      const reason = getBashRejectionReason('find C:\\Users\\balin -name "*.ts"', integrationConfig);
      expect(reason).toBeNull();
    });

    it('should allow grep with unquoted path at end', () => {
      if (!isWindows) return;
      const reason = getBashRejectionReason('grep -r "TODO" C:\\Users\\balin\\src', integrationConfig);
      expect(reason).toBeNull();
    });

    it('should allow diff with multiple unquoted paths', () => {
      if (!isWindows) return;
      const reason = getBashRejectionReason('diff C:\\a\\file.txt C:\\b\\file.txt', integrationConfig);
      expect(reason).toBeNull();
    });

    it('should allow single-quoted Windows path (bash literal)', () => {
      if (!isWindows) return;
      const reason = getBashRejectionReason("cat 'C:\\Users\\test\\file.txt'", integrationConfig);
      expect(reason).toBeNull();
    });
  });

  describe('commands with Windows paths that should FAIL validation', () => {
    it('should still block dangerous commands with Windows paths', () => {
      if (!isWindows) return;
      const reason = getBashRejectionReason('rm "C:\\Users\\test\\file.txt"', integrationConfig);
      expect(reason).not.toBeNull();
      expect(reason?.type).toBe('no_safe_pattern');
    });

    it('should still detect redirects after normalization', () => {
      if (!isWindows) return;
      const reason = getBashRejectionReason('echo "hello" > C:\\Users\\test\\out.txt', integrationConfig);
      expect(reason).not.toBeNull();
      expect(reason?.type).toBe('dangerous_operator');
    });

    it('should block mixed safe/unsafe compound with Windows path', () => {
      if (!isWindows) return;
      const reason = getBashRejectionReason('ls "C:\\Users\\test" && rm -rf /', integrationConfig);
      expect(reason).not.toBeNull();
    });

    it('should detect CMD "if not exist" syntax', () => {
      if (!isWindows) return;
      const reason = getBashRejectionReason('if not exist "C:\\temp" mkdir "C:\\temp"', integrationConfig);
      expect(reason).not.toBeNull();
      expect(reason?.type).toBe('parse_error');
    });

    it('should detect CMD "set" syntax', () => {
      if (!isWindows) return;
      const reason = getBashRejectionReason('set PATH=C:\\evil', integrationConfig);
      expect(reason).not.toBeNull();
      expect(reason?.type).toBe('parse_error');
    });

    it('should detect CMD "for /f" syntax', () => {
      if (!isWindows) return;
      const reason = getBashRejectionReason('for /f %i in (file) do echo %i', integrationConfig);
      expect(reason).not.toBeNull();
      expect(reason?.type).toBe('parse_error');
    });
  });

  describe('edge cases', () => {
    it('should handle double-backslash before closing quote', () => {
      if (!isWindows) return;
      // \\\\" → // before " — the quote closes properly
      const reason = getBashRejectionReason('ls "C:\\\\"', integrationConfig);
      expect(reason).toBeNull();
    });

    it('should handle trailing double-backslash in quoted non-drive path', () => {
      if (!isWindows) return;
      const reason = getBashRejectionReason('ls "path with spaces\\\\"', integrationConfig);
      expect(reason).toBeNull();
    });

    it('should handle non-C drive letter', () => {
      if (!isWindows) return;
      const reason = getBashRejectionReason('ls D:\\Games\\save.dat', integrationConfig);
      expect(reason).toBeNull();
    });

    it('should handle UNC path (double-backslashes)', () => {
      if (!isWindows) return;
      // UNC: "\\\\server\\share\\file.txt" → all \\\\ become //
      const reason = getBashRejectionReason('cat "\\\\\\\\server\\\\share\\\\file.txt"', integrationConfig);
      expect(reason).toBeNull();
    });

    it('should preserve \\n inside double quotes (not a path)', () => {
      if (!isWindows) return;
      const reason = getBashRejectionReason('echo "hello\\nworld"', integrationConfig);
      expect(reason).toBeNull();
    });

    it('should handle command with no path at all (baseline)', () => {
      if (!isWindows) return;
      const reason = getBashRejectionReason('ls', integrationConfig);
      expect(reason).toBeNull();
    });
  });
});
