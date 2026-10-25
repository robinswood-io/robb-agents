import { describe, it, expect, beforeEach } from 'bun:test';
import { preToolUseMocks, resetPreToolUseFixture, runPreToolUseChecks, createInput, createMockPrerequisiteManager } from './pre-tool-use-fixture.ts';

describe('runPreToolUseChecks', () => {
  beforeEach(resetPreToolUseFixture);



  // ============================================================
  // Step 1: Permission mode check
  // ============================================================

  describe('step 1: permission mode check', () => {
    it('blocks when shouldAllowToolInMode returns not allowed', () => {
      preToolUseMocks.shouldAllowToolInMode.mockImplementation(() => ({
        allowed: false,
        reason: 'Bash is not allowed in Explore mode',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        permissionMode: 'safe',
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('Bash is not allowed in Explore mode');
        expect(result.reason).toContain('Effective mode: Explore');
        expect(result.reason).toContain('Last mode change: user at 2026-02-28T18:00:00.000Z (modeVersion=7)');
      }
    });

    it('passes through when shouldAllowToolInMode allows', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '/test/file.ts' },
      }));

      expect(result.type).toBe('allow');
    });

    it('passes correct args to shouldAllowToolInMode', () => {
      runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'ls' },
        permissionMode: 'safe',
        plansFolderPath: '/test/plans',
        dataFolderPath: '/test/data',
        workspaceRootPath: '/test/workspace',
        activeSourceSlugs: ['linear'],
      }));

      expect(preToolUseMocks.shouldAllowToolInMode).toHaveBeenCalledWith(
        'Bash',
        { command: 'ls' },
        'safe',
        {
          plansFolderPath: '/test/plans',
          dataFolderPath: '/test/data',
          permissionsContext: {
            workspaceRootPath: '/test/workspace',
            activeSourceSlugs: ['linear'],
          },
        }
      );
    });

    it('uses effective mode from mode-manager diagnostics when incoming mode is stale', () => {
      runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'ls' },
        permissionMode: 'allow-all', // stale incoming value
      }));

      // Mocked diagnostics returns permissionMode='safe', which must be authoritative.
      expect(preToolUseMocks.shouldAllowToolInMode).toHaveBeenCalledWith(
        'Bash',
        { command: 'ls' },
        'safe',
        expect.any(Object)
      );
    });
  });



  // ============================================================
  // Step 2: Source blocking
  // ============================================================

  describe('step 2: source blocking', () => {
    it('returns source_activation_needed for inactive MCP source (exists)', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: {},
        activeSourceSlugs: [],
        allSourceSlugs: ['linear'],
      }));

      expect(result.type).toBe('source_activation_needed');
      if (result.type === 'source_activation_needed') {
        expect(result.sourceSlug).toBe('linear');
        expect(result.sourceExists).toBe(true);
      }
    });

    it('returns source_activation_needed for inactive MCP source (not exists)', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__notion__search',
        input: {},
        activeSourceSlugs: [],
        allSourceSlugs: [],
      }));

      expect(result.type).toBe('source_activation_needed');
      if (result.type === 'source_activation_needed') {
        expect(result.sourceSlug).toBe('notion');
        expect(result.sourceExists).toBe(false);
      }
    });

    it('allows active MCP source tools', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__getIssue',
        input: {},
        activeSourceSlugs: ['linear'],
        allSourceSlugs: ['linear'],
      }));

      expect(result.type).toBe('allow');
    });

    it('skips source check for built-in MCP servers (session)', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__session__call_llm',
        input: {},
        activeSourceSlugs: [],
      }));

      // Should reach step 4 (call_llm intercept), not blocked at step 2
      expect(result.type).toBe('call_llm_intercept');
    });

    it('skips source check for built-in MCP servers (craft-agents-docs)', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__craft-agents-docs__search',
        input: {},
        activeSourceSlugs: [],
      }));

      // Should pass through (not source_activation_needed)
      expect(result.type).toBe('allow');
    });

    it('skips source check for non-MCP tools', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'ls' },
      }));

      expect(result.type).toBe('allow');
    });
  });



  // ============================================================
  // Step 3: Prerequisite check
  // ============================================================

  describe('step 3: prerequisite check', () => {
    it('blocks when prerequisites are not met', () => {
      const prereqManager = createMockPrerequisiteManager({
        checkPrerequisites: () => ({
          allowed: false,
          blockReason: 'Please read the guide.md for linear before using its tools.',
        }),
      });

      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__getIssue',
        input: {},
        activeSourceSlugs: ['linear'],
        allSourceSlugs: ['linear'],
        prerequisiteManager: prereqManager,
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('guide.md');
      }
    });

    it('passes when prerequisites are met', () => {
      const prereqManager = createMockPrerequisiteManager({
        checkPrerequisites: () => ({ allowed: true }),
      });

      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__getIssue',
        input: {},
        activeSourceSlugs: ['linear'],
        allSourceSlugs: ['linear'],
        prerequisiteManager: prereqManager,
      }));

      expect(result.type).toBe('allow');
    });

    it('registers preloaded source guides before checking the first tool call', () => {
      let guideLoaded = false;
      const guidePath = '/test/workspace/sources/linear/guide.md';
      const prereqManager = createMockPrerequisiteManager({
        markSourceGuidesLoadedInContext: (paths) => {
          guideLoaded = paths.includes(guidePath);
        },
        checkPrerequisites: () => ({
          allowed: guideLoaded,
          blockReason: guideLoaded ? undefined : 'Read guide.md first',
        }),
      });

      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__getIssue',
        input: {},
        activeSourceSlugs: ['linear'],
        allSourceSlugs: ['linear'],
        prerequisiteManager: prereqManager,
        preloadedSourceGuidePaths: [guidePath],
      }));

      expect(result.type).toBe('allow');
      expect(guideLoaded).toBe(true);
    });

    it('skips when no prerequisiteManager provided', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__getIssue',
        input: {},
        activeSourceSlugs: ['linear'],
        allSourceSlugs: ['linear'],
        // No prerequisiteManager
      }));

      expect(result.type).toBe('allow');
    });
  });



  // ============================================================
  // Step 4: call_llm interception
  // ============================================================

  describe('step 4: call_llm interception', () => {
    it('intercepts mcp__session__call_llm', () => {
      const input = { model: 'haiku', prompt: 'summarize' };
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__session__call_llm',
        input,
      }));

      expect(result.type).toBe('call_llm_intercept');
      if (result.type === 'call_llm_intercept') {
        expect(result.input).toEqual(input);
      }
    });

    it('does not intercept other session tools', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__session__SubmitPlan',
        input: {},
      }));

      expect(result.type).toBe('allow');
    });
  });
});
