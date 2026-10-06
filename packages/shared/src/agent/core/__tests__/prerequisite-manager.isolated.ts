/**
 * Tests for PrerequisiteManager
 *
 * Tests the prerequisite reading system that blocks tool calls
 * until required files (like guide.md) have been read.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { CONFIG_DIR } from '../../../config/paths.ts';
import { resolve, join } from 'node:path';
import { PrerequisiteManager } from '../prerequisite-manager.ts';

// Mock existsSync to control guide.md existence
const originalExistsSync = existsSync;
const originalReadFileSync = readFileSync;
let mockExistsPaths: Set<string> = new Set();

mock.module('node:fs', () => ({
  existsSync: (path: string) => mockExistsPaths.has(path),
  // Re-export anything else the module needs
  readFileSync: originalReadFileSync,
}));

// Prerequisite tests must not read or seed real user configuration.
mock.module('../../../config/storage.ts', () => ({ getBrowserToolEnabled: () => true }));

const WORKSPACE_ROOT = '/test/workspace';

function guidePath(slug: string): string {
  return resolve(WORKSPACE_ROOT, 'sources', slug, 'guide.md');
}

function browserDocPath(): string {
  return resolve(join(CONFIG_DIR, 'docs', 'browser-tools.md'));
}

describe('PrerequisiteManager', () => {
  let manager: PrerequisiteManager;
  let debugMessages: string[];

  beforeEach(() => {
    debugMessages = [];
    mockExistsPaths = new Set();
    manager = new PrerequisiteManager({
      workspaceRootPath: WORKSPACE_ROOT,
      onDebug: (msg) => debugMessages.push(msg),
    });
  });

  // ============================================================
  // Rule Matching
  // ============================================================

  describe('rule matching', () => {
    it('matches MCP source tools (mcp__{slug}__{tool})', () => {
      mockExistsPaths.add(guidePath('linear'));
      const result = manager.checkPrerequisites('mcp__linear__createIssue');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain('guide.md');
    });

    it('matches API source tools (api_{slug})', () => {
      mockExistsPaths.add(guidePath('github'));
      const result = manager.checkPrerequisites('api_github');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain('guide.md');
    });

    it('does not match built-in tools', () => {
      const result = manager.checkPrerequisites('Read');
      expect(result.allowed).toBe(true);
    });

    it('does not match Bash tool', () => {
      const result = manager.checkPrerequisites('Bash');
      expect(result.allowed).toBe(true);
    });

    it('does not match Write tool', () => {
      const result = manager.checkPrerequisites('Write');
      expect(result.allowed).toBe(true);
    });

    it('exempts session MCP tools', () => {
      mockExistsPaths.add(guidePath('session'));
      const result = manager.checkPrerequisites('mcp__session__SubmitPlan');
      expect(result.allowed).toBe(true);
    });

    it('exempts craft-agents-docs MCP tools', () => {
      mockExistsPaths.add(guidePath('craft-agents-docs'));
      const result = manager.checkPrerequisites('mcp__craft-agents-docs__search');
      expect(result.allowed).toBe(true);
    });

    it('handles malformed MCP tool names (fewer than 3 parts)', () => {
      const result = manager.checkPrerequisites('mcp__linear');
      expect(result.allowed).toBe(true);
    });

    it('matches native browser tools and blocks until browser docs are read', () => {
      const docsPath = browserDocPath();
      mockExistsPaths.add(docsPath);

      const result = manager.checkPrerequisites('browser_tool');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain(docsPath);
    });

    it('matches session browser tools and blocks until browser docs are read', () => {
      const docsPath = browserDocPath();
      mockExistsPaths.add(docsPath);

      const result = manager.checkPrerequisites('mcp__session__browser_tool');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain(docsPath);
    });
  });

  // ============================================================
  // Path Resolution
  // ============================================================

  describe('path resolution', () => {
    it('resolves guide.md path from MCP tool name', () => {
      const expected = guidePath('linear');
      mockExistsPaths.add(expected);
      const result = manager.checkPrerequisites('mcp__linear__createIssue');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain(expected);
    });

    it('resolves guide.md path from API tool name', () => {
      const expected = guidePath('slack');
      mockExistsPaths.add(expected);
      const result = manager.checkPrerequisites('api_slack');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain(expected);
    });
  });

  // ============================================================
  // Read Tracking
  // ============================================================

  describe('read tracking', () => {
    it('allows tool after guide.md has been read', () => {
      const guideFile = guidePath('linear');
      mockExistsPaths.add(guideFile);

      // Before reading - blocked
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(false);

      // Track the read
      manager.trackReadTool({ file_path: guideFile });

      // After reading - allowed
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(true);
    });

    it('tracks reads using path parameter', () => {
      const guideFile = guidePath('github');
      mockExistsPaths.add(guideFile);

      manager.trackReadTool({ path: guideFile });
      expect(manager.checkPrerequisites('api_github').allowed).toBe(true);
    });

    it('ignores trackReadTool with no path', () => {
      manager.trackReadTool({});
      expect(manager.hasRead('/any/path')).toBe(false);
    });

    it('tracks multiple reads independently', () => {
      const linearGuide = guidePath('linear');
      const slackGuide = guidePath('slack');
      mockExistsPaths.add(linearGuide);
      mockExistsPaths.add(slackGuide);

      manager.trackReadTool({ file_path: linearGuide });

      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(true);
      expect(manager.checkPrerequisites('mcp__slack__sendMessage').allowed).toBe(false);
    });

    it('allows the first source tool call when its guide was preloaded into context', () => {
      const guideFile = guidePath('linear');
      mockExistsPaths.add(guideFile);

      manager.markSourceGuidesLoadedInContext([guideFile]);

      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(true);
      expect(debugMessages.some(message => message.includes('already loaded in context'))).toBe(true);
    });

    it('accepts workspace-relative paths for preloaded source guides', () => {
      const guideFile = guidePath('linear');
      mockExistsPaths.add(guideFile);

      manager.markSourceGuidesLoadedInContext(['sources/linear/guide.md']);

      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(true);
    });

    it('does not let source-guide preloading bypass browser or skill prerequisites', () => {
      const docsPath = browserDocPath();
      const skillPath = '/test/workspace/skills/my-skill/SKILL.md';
      mockExistsPaths.add(docsPath);
      mockExistsPaths.add(skillPath);

      manager.registerSkillPrerequisites([skillPath]);
      manager.markSourceGuidesLoadedInContext([docsPath, skillPath]);

      expect(manager.checkPrerequisites('WebSearch').allowed).toBe(false);

      // Use a fresh manager so the skill gate does not mask the strict browser gate.
      const browserManager = new PrerequisiteManager({ workspaceRootPath: WORKSPACE_ROOT });
      browserManager.markSourceGuidesLoadedInContext([docsPath]);
      expect(browserManager.checkPrerequisites('browser_tool').allowed).toBe(false);
    });
  });

  // ============================================================
  // Reset
  // ============================================================

  describe('reset', () => {
    it('clears all read state', () => {
      const guideFile = guidePath('linear');
      mockExistsPaths.add(guideFile);

      manager.trackReadTool({ file_path: guideFile });
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(true);

      manager.resetReadState();
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(false);
    });

    it('clears preloaded source-guide state after compaction', () => {
      const guideFile = guidePath('linear');
      mockExistsPaths.add(guideFile);

      manager.markSourceGuidesLoadedInContext([guideFile]);
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(true);

      manager.resetReadState();
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(false);
    });

    it('preserves a browser guide supplied by the stable system context', () => {
      const docsPath = browserDocPath();
      mockExistsPaths.add(docsPath);
      const browserManager = new PrerequisiteManager({
        workspaceRootPath: WORKSPACE_ROOT,
        browserGuideLoadedInContext: true,
      });

      expect(browserManager.checkPrerequisites('browser_tool').allowed).toBe(true);
      browserManager.resetReadState();
      expect(browserManager.checkPrerequisites('browser_tool').allowed).toBe(true);
    });

    it('logs debug message on reset', () => {
      manager.trackReadTool({ file_path: '/some/file' });
      manager.resetReadState();
      expect(debugMessages.some((m) => m.includes('reset read state'))).toBe(true);
    });
  });

  // ============================================================
  // Guide Nonexistence
  // ============================================================

  describe('guide nonexistence', () => {
    it('allows tool when guide.md does not exist', () => {
      // Don't add to mockExistsPaths — guide.md doesn't exist
      const result = manager.checkPrerequisites('mcp__linear__createIssue');
      expect(result.allowed).toBe(true);
    });

    it('allows API tool when guide.md does not exist', () => {
      const result = manager.checkPrerequisites('api_github');
      expect(result.allowed).toBe(true);
    });
  });

  // ============================================================
  // Path Normalization
  // ============================================================

  describe('path normalization', () => {
    it('normalizes tilde paths in trackReadTool', () => {
      const guideFile = guidePath('linear');
      mockExistsPaths.add(guideFile);

      // Track with tilde path that expands to the same absolute path
      const homeDir = process.env.HOME || process.env.USERPROFILE || '/home/user';
      const tildeRelative = `~/some-file.md`;
      manager.trackReadTool({ file_path: tildeRelative });

      // The expanded path should be tracked
      expect(manager.hasRead(tildeRelative)).toBe(true);
    });
  });

  // ============================================================
  // Prerequisites require successful acquisition, including after retries/compaction.
  // ============================================================

  describe('effective prerequisite acquisition', () => {
    const skillPath = '/test/workspace/skills/my-skill/SKILL.md';

    it('keeps source guides and skills pending through repeated rejected calls', () => {
      mockExistsPaths.add(guidePath('linear'));
      for (let i = 0; i < 6; i++) expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(false);
      manager.registerSkillPrerequisites([skillPath]);
      for (let i = 0; i < 6; i++) expect(manager.checkPrerequisites('WebSearch').allowed).toBe(false);
    });

    it('does not credit a start, failure, or a nonexecuted checkpoint', () => {
      manager.registerSkillPrerequisites([skillPath]);
      manager.trackToolStart('read-1', 'Read', { file_path: skillPath });
      expect(manager.checkPrerequisites('WebSearch').allowed).toBe(false);
      manager.trackToolCompletion('read-1', 'ENOENT', true);
      expect(manager.checkPrerequisites('WebSearch').allowed).toBe(false);
      manager.trackToolStart('read-2', 'Read', { file_path: skillPath });
      manager.trackToolCompletion('read-2', 'Cost guard checkpoint', false, false);
      expect(manager.checkPrerequisites('WebSearch').allowed).toBe(false);
      manager.trackToolStart('read-3', 'Read', { file_path: skillPath });
      manager.trackToolCompletion('read-3', 'The actual skill contents', false);
      expect(manager.checkPrerequisites('WebSearch').allowed).toBe(true);
    });

    it('requires another successful read after compaction and ignores stale results', () => {
      manager.registerSkillPrerequisites([skillPath]);
      manager.trackToolStart('old-read', 'Read', { file_path: skillPath });
      manager.resetReadState();
      manager.trackToolCompletion('old-read', 'Contents from the old context', false);
      expect(manager.checkPrerequisites('WebSearch').allowed).toBe(false);
      manager.trackToolStart('new-read', 'Read', { file_path: skillPath });
      manager.trackToolCompletion('new-read', 'Current skill contents', false);
      expect(manager.checkPrerequisites('WebSearch').allowed).toBe(true);
      manager.resetReadState();
      expect(manager.checkPrerequisites('WebSearch').allowed).toBe(false);
    });

    it('permits cat acquisition without crediting it before success', () => {
      manager.registerSkillPrerequisites([skillPath]);
      const input = { command: `cat -- '${skillPath}'` };
      expect(manager.trackBashSkillRead(input)).toBe(true);
      expect(manager.checkPrerequisites('WebSearch').allowed).toBe(false);
      manager.trackToolStart('cat-1', 'Bash', input);
      manager.trackToolCompletion('cat-1', 'cat: permission denied', true);
      expect(manager.checkPrerequisites('WebSearch').allowed).toBe(false);
      manager.trackToolStart('cat-2', 'Bash', input);
      manager.trackToolCompletion('cat-2', 'Actual instructions', false);
      expect(manager.checkPrerequisites('WebSearch').allowed).toBe(true);
    });

    it('never treats a mention, substitution, or compound command as a full file read', () => {
      manager.registerSkillPrerequisites([skillPath]);
      for (const command of [
        `echo '${skillPath}'`, `true ${skillPath}`, `cat ${skillPath} && touch /tmp/side-effect`,
        `cat ${skillPath} > /tmp/hidden`, `cat ${skillPath} | head -n 1`, `cat $(echo ${skillPath})`,
        `cat '${skillPath}'garbage`, `cat ${skillPath}\necho done`,
      ]) {
        expect(manager.trackBashSkillRead({ command })).toBe(false);
        manager.trackToolResult('Bash', { command }, 'irrelevant output', false);
        expect(manager.checkPrerequisites('WebSearch').allowed).toBe(false);
      }
    });

    it('supports multiple full files and paths containing spaces in one cat command', () => {
      const second = '/test/workspace/skills/second skill/SKILL.md';
      manager.registerSkillPrerequisites([skillPath, second]);
      const input = { command: `cat -- '${skillPath}' "${second}" ` };
      expect(manager.trackBashSkillRead(input)).toBe(true);
      manager.trackToolResult('Bash', input, 'Both complete skill documents', false);
      expect(manager.checkPrerequisites('WebSearch').allowed).toBe(true);
    });

    it('does not credit partial reads or absent result contents', () => {
      manager.registerSkillPrerequisites([skillPath]);
      for (const input of [{ file_path: skillPath, offset: 20 }, { file_path: skillPath, limit: 1 }]) {
        manager.trackToolResult('Read', input, 'one line', false);
        expect(manager.checkPrerequisites('WebSearch').allowed).toBe(false);
      }
      manager.trackToolResult('Read', { file_path: skillPath }, undefined, false);
      manager.trackToolResult('Read', { file_path: skillPath }, { isError: true, content: 'failed' }, false);
      expect(manager.checkPrerequisites('WebSearch').allowed).toBe(false);
    });
  });

  // ============================================================
  // Debug Logging
  // ============================================================

  describe('debug logging', () => {
    it('logs when a tool is blocked', () => {
      mockExistsPaths.add(guidePath('linear'));
      manager.checkPrerequisites('mcp__linear__createIssue');
      expect(debugMessages.some((m) => m.includes('Prerequisite blocked'))).toBe(true);
    });

    it('logs when a read is tracked', () => {
      manager.trackReadTool({ file_path: '/some/file.md' });
      expect(debugMessages.some((m) => m.includes('tracked read'))).toBe(true);
    });
  });
});
