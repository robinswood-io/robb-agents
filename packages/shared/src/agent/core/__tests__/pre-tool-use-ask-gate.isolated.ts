import { describe, it, expect, beforeEach } from 'bun:test';
import { preToolUseMocks, resetPreToolUseFixture, runPreToolUseChecks, createInput } from './pre-tool-use-fixture.ts';

describe('runPreToolUseChecks', () => {
  beforeEach(resetPreToolUseFixture);



  // ============================================================
  // Step 6: Ask-mode prompt decision
  // ============================================================

  describe('step 6: ask-mode prompt decision', () => {
    beforeEach(() => {
      preToolUseMocks.permissionMode = 'ask';
    });

    it('prompts for bash commands in ask mode', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'npm install express' },
        permissionMode: 'ask',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.promptType).toBe('bash');
        expect(result.command).toBe('npm install express');
      }
    });

    it('prompts for file write tools in ask mode', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Write',
        input: { file_path: '/test/file.ts', content: 'hello' },
        permissionMode: 'ask',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.promptType).toBe('file_write');
        expect(result.description).toContain('/test/file.ts');
      }
    });

    it('prompts for Edit in ask mode', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Edit',
        input: { file_path: '/test/file.ts', old_string: 'a', new_string: 'b' },
        permissionMode: 'ask',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.promptType).toBe('file_write');
      }
    });

    it('does not prompt in allow-all mode', () => {
      preToolUseMocks.permissionMode = 'allow-all';

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('allow');
    });

    it('does not prompt in safe mode (blocked at step 1 instead)', () => {
      preToolUseMocks.shouldAllowToolInMode.mockImplementation(() => ({
        allowed: false,
        reason: 'Blocked in safe mode',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        permissionMode: 'safe',
      }));

      expect(result.type).toBe('block');
    });

    it('includes modifiedInput in prompt when transforms changed the input', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Write',
        input: { file_path: '~/test.ts', content: 'hello', _intent: 'write file' },
        permissionMode: 'ask',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.modifiedInput).toBeDefined();
        expect(result.modifiedInput!["file_path"]).toBe('/Users/test/test.ts');
        expect(result.modifiedInput!["_intent"]).toBeUndefined();
      }
    });

    it('omits modifiedInput in prompt when no transforms applied', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'npm test' },
        permissionMode: 'ask',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.modifiedInput).toBeUndefined();
      }
    });
  });
});
