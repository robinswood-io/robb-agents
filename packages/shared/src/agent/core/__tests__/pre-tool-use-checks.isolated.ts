import { describe, it, expect, beforeEach } from 'bun:test';
import { preToolUseMocks, resetPreToolUseFixture, shouldPromptInAskMode, createMockPermissionManager, type PermissionManagerLike } from './pre-tool-use-fixture.ts';

beforeEach(resetPreToolUseFixture);



// ============================================================
// shouldPromptInAskMode
// ============================================================

describe('shouldPromptInAskMode', () => {
  let pm: PermissionManagerLike;

  beforeEach(() => {
    pm = createMockPermissionManager();
    preToolUseMocks.shouldAllowToolInMode.mockReset();
    preToolUseMocks.isApiEndpointAllowed.mockReset();
    preToolUseMocks.isApiEndpointAllowed.mockImplementation(() => false);
    preToolUseMocks.isReadOnlyBashCommandWithConfig.mockReset();
    preToolUseMocks.isReadOnlyBashCommandWithConfig.mockImplementation(() => false);
    preToolUseMocks.detectConfigFileType.mockReset();
    preToolUseMocks.detectConfigFileType.mockImplementation(() => null);
    preToolUseMocks.detectAppConfigFileType.mockReset();
    preToolUseMocks.detectAppConfigFileType.mockImplementation(() => null);
    preToolUseMocks.validateConfigFileContent.mockReset();
    preToolUseMocks.validateConfigFileContent.mockImplementation(() => null);
    preToolUseMocks.readOnlyBashPatterns = [];
    preToolUseMocks.craftAgentsCli = false;
  });

  // --- File writes ---

  describe('file write tools', () => {
    it('prompts for Write tool', () => {
      const result = shouldPromptInAskMode('Write', { file_path: '/test/file.ts', content: 'x' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('file_write');
      expect(result!.description).toContain('/test/file.ts');
    });

    it('prompts for Edit tool', () => {
      const result = shouldPromptInAskMode('Edit', { file_path: '/test/a.ts' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('file_write');
    });

    it('prompts for MultiEdit tool', () => {
      const result = shouldPromptInAskMode('MultiEdit', { file_path: '/test/a.ts' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('file_write');
    });

    it('prompts for NotebookEdit with notebook_path', () => {
      const result = shouldPromptInAskMode('NotebookEdit', { notebook_path: '/test/nb.ipynb' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('file_write');
      expect(result!.description).toContain('/test/nb.ipynb');
    });

    it('auto-allows whitelisted file write tools', () => {
      pm = createMockPermissionManager({
        isCommandWhitelisted: (cmd) => cmd === 'Write',
      });

      const result = shouldPromptInAskMode('Write', { file_path: '/test/a.ts' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });
  });

  // --- Bash ---

  describe('bash commands', () => {
    it('prompts for bash commands', () => {
      const result = shouldPromptInAskMode('Bash', { command: 'npm install express' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('bash');
      expect(result!.command).toBe('npm install express');
    });

    it('auto-allows read-only bash commands (AST-validated)', () => {
      preToolUseMocks.isReadOnlyBashCommandWithConfig.mockImplementation(() => true);

      const result = shouldPromptInAskMode('Bash', { command: 'ls -la' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });

    it('does NOT auto-allow bash commands with redirects (e.g. cat > file)', () => {
      // isReadOnlyBashCommandWithConfig uses AST validation which catches redirects
      preToolUseMocks.isReadOnlyBashCommandWithConfig.mockImplementation(() => false);

      const result = shouldPromptInAskMode('Bash', { command: 'cat /etc/hosts > /tmp/test' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('bash');
      expect(result!.command).toBe('cat /etc/hosts > /tmp/test');
    });

    it('auto-allows whitelisted non-dangerous commands', () => {
      pm = createMockPermissionManager({
        isCommandWhitelisted: (cmd) => cmd === 'npm',
        isDangerousCommand: () => false,
        getBaseCommand: (cmd) => cmd.split(/\s+/)[0] || cmd,
      });

      const result = shouldPromptInAskMode('Bash', { command: 'npm test' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });

    it('still prompts for whitelisted dangerous commands', () => {
      pm = createMockPermissionManager({
        isCommandWhitelisted: (cmd) => cmd === 'rm',
        isDangerousCommand: (cmd) => cmd === 'rm',
        getBaseCommand: (cmd) => cmd.split(/\s+/)[0] || cmd,
      });

      const result = shouldPromptInAskMode('Bash', { command: 'rm -rf /important' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('bash');
    });

    it('auto-allows curl to whitelisted domain', () => {
      pm = createMockPermissionManager({
        getBaseCommand: (cmd) => cmd.split(/\s+/)[0] || cmd,
        extractDomainFromNetworkCommand: () => 'api.example.com',
        isDomainWhitelisted: (domain) => domain === 'api.example.com',
      });

      const result = shouldPromptInAskMode('Bash', { command: 'curl https://api.example.com/data' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });

    it('prompts for curl to non-whitelisted domain', () => {
      pm = createMockPermissionManager({
        getBaseCommand: (cmd) => cmd.split(/\s+/)[0] || cmd,
        extractDomainFromNetworkCommand: () => 'evil.com',
        isDomainWhitelisted: () => false,
      });

      const result = shouldPromptInAskMode('Bash', { command: 'curl https://evil.com/data' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('bash');
    });
  });

  // --- MCP mutations ---

  describe('MCP mutations', () => {
    it('prompts for MCP mutations (blocked in safe mode)', () => {
      preToolUseMocks.shouldAllowToolInMode.mockImplementation(
        (_tool: string, _input: unknown, mode: string) =>
          mode === 'safe' ? { allowed: false, reason: 'mutation' } : { allowed: true, reason: '' }
      );

      const result = shouldPromptInAskMode('mcp__linear__createIssue', { title: 'Bug' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['linear'],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('mcp_mutation');
      expect(result!.description).toContain('linear');
    });

    it('auto-allows MCP read-only tools (not blocked in safe mode)', () => {
      preToolUseMocks.shouldAllowToolInMode.mockImplementation(() => ({ allowed: true, reason: '' }));

      const result = shouldPromptInAskMode('mcp__linear__listIssues', {}, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['linear'],
      });

      expect(result).toBeNull();
    });

    it('auto-allows whitelisted MCP mutations', () => {
      preToolUseMocks.shouldAllowToolInMode.mockImplementation(
        (_tool: string, _input: unknown, mode: string) =>
          mode === 'safe' ? { allowed: false, reason: 'mutation' } : { allowed: true, reason: '' }
      );

      pm = createMockPermissionManager({
        isCommandWhitelisted: (cmd) => cmd === 'mcp__linear__createIssue',
      });

      const result = shouldPromptInAskMode('mcp__linear__createIssue', { title: 'Bug' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['linear'],
      });

      expect(result).toBeNull();
    });
  });

  // --- API mutations ---

  describe('API mutations', () => {
    it('prompts for non-GET API calls', () => {
      const result = shouldPromptInAskMode('api_github', { method: 'POST', path: '/repos' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['github'],
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('api_mutation');
      expect(result!.description).toContain('POST');
    });

    it('auto-allows GET API calls', () => {
      const result = shouldPromptInAskMode('api_github', { method: 'GET', path: '/repos' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['github'],
      });

      expect(result).toBeNull();
    });

    it('auto-allows API mutations whitelisted in permissions.json', () => {
      preToolUseMocks.isApiEndpointAllowed.mockImplementation(() => true);

      const result = shouldPromptInAskMode('api_github', { method: 'POST', path: '/repos' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['github'],
      });

      expect(result).toBeNull();
    });

    it('auto-allows API mutations whitelisted in session', () => {
      pm = createMockPermissionManager({
        isCommandWhitelisted: (cmd) => cmd === 'POST /repos',
      });

      const result = shouldPromptInAskMode('api_github', { method: 'POST', path: '/repos' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['github'],
      });

      expect(result).toBeNull();
    });

    it('defaults to GET for missing method', () => {
      const result = shouldPromptInAskMode('api_github', { path: '/repos' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['github'],
      });

      // GET → no prompt
      expect(result).toBeNull();
    });
  });

  // --- Non-prompting tools ---

  describe('non-prompting tools', () => {
    it('returns null for Read tool', () => {
      const result = shouldPromptInAskMode('Read', { file_path: '/test/file.ts' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });

    it('returns null for Glob tool', () => {
      const result = shouldPromptInAskMode('Glob', { pattern: '**/*.ts' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });

    it('returns null for Grep tool', () => {
      const result = shouldPromptInAskMode('Grep', { pattern: 'TODO' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });

    it('returns null for Task tool', () => {
      const result = shouldPromptInAskMode('Task', {}, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });
  });
});
