import { describe, it, expect, beforeEach } from 'bun:test';
import { preToolUseMocks, resetPreToolUseFixture, runPreToolUseChecks, createInput, createMockPrerequisiteManager } from './pre-tool-use-fixture.ts';

describe('runPreToolUseChecks', () => {
  beforeEach(resetPreToolUseFixture);



  // ============================================================
  // Pipeline ordering
  // ============================================================

  describe('pipeline ordering', () => {
    it('permission check runs before source blocking', () => {
      // If tool is blocked by mode, source blocking should not run
      preToolUseMocks.shouldAllowToolInMode.mockImplementation(() => ({
        allowed: false,
        reason: 'Not allowed',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: {},
        activeSourceSlugs: [],
        allSourceSlugs: ['linear'],
        permissionMode: 'safe',
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('Not allowed');
        expect(result.reason).toContain('Effective mode: Explore');
      }
    });

    it('source blocking runs before prerequisite check', () => {
      // Inactive source → source_activation_needed (not prerequisite block)
      const prereqManager = createMockPrerequisiteManager({
        checkPrerequisites: () => ({
          allowed: false,
          blockReason: 'Read guide.md first',
        }),
      });

      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: {},
        activeSourceSlugs: [],
        allSourceSlugs: ['linear'],
        prerequisiteManager: prereqManager,
      }));

      expect(result.type).toBe('source_activation_needed');
    });

    it('prerequisite check runs before call_llm interception', () => {
      // This scenario is contrived (call_llm is from session server which is exempt
      // from prerequisites), but validates pipeline order for other session tools
      const prereqManager = createMockPrerequisiteManager({
        checkPrerequisites: (toolName: string) => {
          if (toolName === 'mcp__custom__some_tool') {
            return { allowed: false, blockReason: 'blocked' };
          }
          return { allowed: true };
        },
      });

      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__custom__some_tool',
        input: {},
        activeSourceSlugs: ['custom'],
        allSourceSlugs: ['custom'],
        prerequisiteManager: prereqManager,
      }));

      expect(result.type).toBe('block');
    });

    it('call_llm interception runs before transforms', () => {
      // call_llm should be intercepted even if input has metadata
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__session__call_llm',
        input: { model: 'haiku', _intent: 'summarize' },
      }));

      expect(result.type).toBe('call_llm_intercept');
      if (result.type === 'call_llm_intercept') {
        // Input should be passed through unmodified (no stripping)
        expect(result.input["_intent"]).toBe('summarize');
      }
    });
  });



  // ============================================================
  // Debug callback
  // ============================================================

  describe('bounded rbw-agents-oss catalog reads', () => {
    const trustedRead = {
      readOnly: true,
      idempotent: true,
      trusted: true,
    } as const;

    it.each([
      ['/srv/rbw-agents-oss/config/command-manifest.json', 'oss_list_automations'],
      ['/srv//rbw-agents-oss/config/automation-mapping.json', 'oss_list_automations'],
      ['/srv/rbw-agents-oss/config/./command-manifest.json', 'oss_list_automations'],
      ['/srv/rbw-agents-oss/archive/../config/command-manifest.json', 'oss_list_automations'],
      ['/srv/rbw-agents-oss/config/temporal/schedules.json', 'oss_schedule_status'],
    ])('blocks the known whole catalog %s and names the bounded tool', (path, replacement) => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__rbw-agents-oss__oss_read_file',
        input: { path },
        activeSourceSlugs: ['rbw-agents-oss'],
        allSourceSlugs: ['rbw-agents-oss'],
        declaredToolCapabilities: trustedRead,
      }));

      expect(result).toMatchObject({ type: 'block' });
      if (result.type === 'block') {
        expect(result.reason).toContain('known oversized catalog');
        expect(result.reason).toContain(replacement);
        expect(result.reason).toContain('no enforced offset or byte limit');
      }
    });

    it.each([
      ['/srv/rbw-agents-oss/config/traid-paper-policy.json', 'mcp__rbw-agents-oss__oss_read_file'],
      ['/srv/rbw-agents-oss/archive/command-manifest.json', 'mcp__rbw-agents-oss__oss_read_file'],
      ['/srv/rbw-agents-oss/config/command-manifest.json', 'mcp__other__oss_read_file'],
    ])('does not broaden the catalog block to %s via %s', (path, toolName) => {
      expect(runPreToolUseChecks(createInput({
        toolName,
        input: { path },
        activeSourceSlugs: ['rbw-agents-oss', 'other'],
        allSourceSlugs: ['rbw-agents-oss', 'other'],
        declaredToolCapabilities: trustedRead,
      }))).toMatchObject({ type: 'allow' });
    });
  });



  describe('debug callback', () => {
    it('calls onDebug when tool is blocked by mode', () => {
      const debugMessages: string[] = [];
      preToolUseMocks.shouldAllowToolInMode.mockImplementation(() => ({
        allowed: false,
        reason: 'Not allowed in safe mode',
      }));

      runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        permissionMode: 'safe',
        onDebug: (msg) => debugMessages.push(msg),
      }));

      expect(debugMessages.length).toBeGreaterThan(0);
      expect(debugMessages[0]).toContain('safe');
      expect(debugMessages[0]).toContain('Bash');
    });

    it('calls onDebug for source activation', () => {
      const debugMessages: string[] = [];

      runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: {},
        activeSourceSlugs: [],
        allSourceSlugs: ['linear'],
        onDebug: (msg) => debugMessages.push(msg),
      }));

      expect(debugMessages.some(m => m.includes('linear'))).toBe(true);
    });
  });
});
