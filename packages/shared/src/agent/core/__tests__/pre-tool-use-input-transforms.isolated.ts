import { describe, it, expect, beforeEach } from 'bun:test';
import { preToolUseMocks, resetPreToolUseFixture, runPreToolUseChecks, createInput } from './pre-tool-use-fixture.ts';

describe('runPreToolUseChecks', () => {
  beforeEach(resetPreToolUseFixture);



  // ============================================================
  // Step 5: Input transforms
  // ============================================================

  describe('step 5: input transforms', () => {
    beforeEach(() => {
      preToolUseMocks.craftAgentsCli = true;
    });

    it('expands tilde paths and returns modify', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '~/Documents/file.ts' },
      }));

      expect(result.type).toBe('modify');
      if (result.type === 'modify') {
        expect(result.input["file_path"]).toBe('/Users/test/Documents/file.ts');
      }
    });

    it('does not modify non-tilde paths', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '/absolute/path/file.ts' },
      }));

      expect(result.type).toBe('allow');
    });

    it('strips _intent and _displayName metadata', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__getIssue',
        input: { title: 'Bug fix', _intent: 'create issue', _displayName: 'Create Issue' },
        activeSourceSlugs: ['linear'],
        allSourceSlugs: ['linear'],
      }));

      expect(result.type).toBe('modify');
      if (result.type === 'modify') {
        expect(result.input["title"]).toBe('Bug fix');
        expect(result.input["_intent"]).toBeUndefined();
        expect(result.input["_displayName"]).toBeUndefined();
      }
    });

    it('combines path expansion and metadata stripping', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '~/test.ts', _intent: 'reading a file' },
      }));

      expect(result.type).toBe('modify');
      if (result.type === 'modify') {
        expect(result.input["file_path"]).toBe('/Users/test/test.ts');
        expect(result.input["_intent"]).toBeUndefined();
      }
    });

    it('blocks direct label folder reads and suggests craft-agent label help when feature is enabled', () => {
      preToolUseMocks.craftAgentsCli = true;

      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '/test/workspace/labels/config.json' },
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('craft-agent label');
        expect(result.reason).toContain('craft-agent label --help');
        expect(result.reason).toContain('labels/');
      }
    });

    it('blocks direct label config writes and suggests craft-agent label help when feature is enabled', () => {
      preToolUseMocks.craftAgentsCli = true;
      preToolUseMocks.detectConfigFileType.mockImplementation(() => ({ type: 'labels', displayFile: 'labels/config.json' }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Write',
        input: { file_path: '/test/workspace/labels/config.json', content: '{}' },
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('craft-agent label');
        expect(result.reason).toContain('craft-agent label --help');
      }
    });

    it('does not apply config-file CLI redirect when feature is disabled', () => {
      preToolUseMocks.craftAgentsCli = false;
      preToolUseMocks.detectConfigFileType.mockImplementation(() => ({ type: 'labels', displayFile: 'labels/config.json' }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Write',
        input: { file_path: '/test/workspace/labels/config.json', content: '{}' },
      }));

      expect(result.type).toBe('allow');
    });

    it('does not block label config writes when feature is disabled', () => {
      preToolUseMocks.craftAgentsCli = false;
      preToolUseMocks.detectConfigFileType.mockImplementation(() => ({ type: 'labels', displayFile: 'labels/config.json' }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Write',
        input: { file_path: '/test/workspace/labels/config.json', content: '{}' },
      }));

      expect(result.type).toBe('allow');
    });

    it('does not block bash commands touching automations files when feature is disabled', () => {
      preToolUseMocks.craftAgentsCli = false;

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'python3 scripts/update.py automations.json' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('allow');
    });

    it('blocks direct automations config edits and suggests craft-agent automation commands when feature is enabled', () => {
      preToolUseMocks.craftAgentsCli = true;
      preToolUseMocks.detectConfigFileType.mockImplementation(() => ({ type: 'automations', displayFile: 'automations.json' }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Edit',
        input: {
          file_path: '/test/workspace/automations.json',
          old_string: 'A',
          new_string: 'B',
        },
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('craft-agent automation');
        expect(result.reason).toContain('automations.json');
      }
    });

    it('blocks direct source config edits and suggests craft-agent source commands when feature is enabled', () => {
      preToolUseMocks.craftAgentsCli = true;
      preToolUseMocks.detectConfigFileType.mockImplementation(() => ({
        type: 'source',
        slug: 'linear',
        displayFile: 'sources/linear/config.json',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Edit',
        input: {
          file_path: '/test/workspace/sources/linear/config.json',
          old_string: 'A',
          new_string: 'B',
        },
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('craft-agent source');
        expect(result.reason).toContain('sources/linear/config.json');
      }
    });

    it('blocks direct skill file edits and suggests craft-agent skill commands when feature is enabled', () => {
      preToolUseMocks.craftAgentsCli = true;
      preToolUseMocks.detectConfigFileType.mockImplementation(() => ({
        type: 'skill',
        slug: 'commit-helper',
        displayFile: 'skills/commit-helper/SKILL.md',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Edit',
        input: {
          file_path: '/test/workspace/skills/commit-helper/SKILL.md',
          old_string: 'A',
          new_string: 'B',
        },
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('craft-agent skill');
        expect(result.reason).toContain('skills/commit-helper/SKILL.md');
      }
    });

    it('blocks bash commands touching labels paths and points to craft-agent label --help when feature is enabled', () => {
      preToolUseMocks.craftAgentsCli = true;

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'python3 scripts/update.py labels/config.json' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('craft-agent label --help');
        expect(result.reason).toContain('craft-agent label');
      }
    });

    it('allows bash craft-agent label commands through labels guard', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'craft-agent label list' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('allow');
    });

    it('blocks bash commands touching automations files and points to craft-agent automation --help when feature is enabled', () => {
      preToolUseMocks.craftAgentsCli = true;

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'python3 scripts/update.py automations.json' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('craft-agent automation --help');
        expect(result.reason).toContain('craft-agent automation');
      }
    });

    it('allows bash craft-agent automation commands through config-domain bash guard', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'craft-agent automation list' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('allow');
    });

    it('does not apply config-domain bash guard when feature is disabled', () => {
      preToolUseMocks.craftAgentsCli = false;

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'python3 scripts/update.py automations.json' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('allow');
    });

    it('does not block unrelated non-workspace labels paths in bash commands', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'python3 script.py /tmp/labels/config.json' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('allow');
    });
  });
});
