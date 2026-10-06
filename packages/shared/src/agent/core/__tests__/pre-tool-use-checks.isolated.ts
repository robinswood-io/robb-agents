/**
 * Tests for the centralized PreToolUse pipeline.
 *
 * Tests `runPreToolUseChecks()` (6-step pipeline) and `shouldPromptInAskMode()`
 * which are shared by both agent backends (ClaudeAgent, PiAgent).
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ============================================================
// Module mocks (must be before imports of the module under test)
// ============================================================

let mockShouldAllowToolInMode = mock(
  (_toolName: string, _input: Record<string, unknown>, _mode: string, _opts?: any) =>
    ({ allowed: true, reason: '' })
);

let mockIsApiEndpointAllowed = mock(
  (_method: string, _path: string | undefined, _ctx: any) => false
);

let mockIsReadOnlyBashCommandWithConfig = mock(
  (_command: string, _config: any) => false
);

let mockEffectivePermissionMode: 'safe' | 'ask' | 'allow-all' = 'safe';

// Paths resolve from THIS file's location (core/__tests__/)
mock.module('../../mode-manager.ts', () => ({
  shouldAllowToolInMode: (a: any, b: any, c: any, d?: any) => mockShouldAllowToolInMode(a, b, c, d),
  isApiEndpointAllowed: (a: any, b: any, c?: any) => mockIsApiEndpointAllowed(a, b, c),
  isReadOnlyBashCommandWithConfig: (a: any, b: any) => mockIsReadOnlyBashCommandWithConfig(a, b),
  getPermissionModeDiagnostics: () => ({
    permissionMode: mockEffectivePermissionMode,
    modeVersion: 7,
    lastChangedAt: '2026-02-28T18:00:00.000Z',
    lastChangedBy: 'user',
  }),
}));

// Mock permissionsConfigCache for read-only bash pattern checks
let mockReadOnlyBashPatterns: Array<{ regex: RegExp }> = [];

mock.module('../../permissions-config.ts', () => ({
  permissionsConfigCache: {
    getMergedConfig: () => ({
      readOnlyBashPatterns: mockReadOnlyBashPatterns,
      readOnlyMcpPatterns: [],
    }),
  },
}));

// Mock expandPath to avoid real home directory resolution
mock.module('../../../utils/paths.ts', () => ({
  expandPath: (p: string) => p.replace(/^~/, '/Users/test'),
}));

// Mock filesystem for config validation and skill qualification
mock.module('node:fs', () => ({
  existsSync: (_path: string) => false,
  readFileSync: (_path: string) => '',
}));

// Mock config validators (used by validateConfigWrite + CLI redirect)
let mockDetectConfigFileType = mock((_path: string, _workspaceRootPath?: string) => null as any);
let mockDetectAppConfigFileType = mock((_path: string) => null as any);
let mockValidateConfigFileContent = mock((_type: any, _content: string) => null as any);

mock.module('../../../config/validators.ts', () => ({
  detectConfigFileType: (a: any, b: any) => mockDetectConfigFileType(a, b),
  detectAppConfigFileType: (a: any) => mockDetectAppConfigFileType(a),
  validateConfigFileContent: (a: any, b: any) => mockValidateConfigFileContent(a, b),
  formatValidationResult: () => '',
}));

// Mock skill constants
mock.module('../../../skills/types.ts', () => ({
  AGENTS_PLUGIN_NAME: '.agents',
}));

mock.module('../../../skills/storage.ts', () => ({
  GLOBAL_AGENT_SKILLS_DIR: '/Users/test/.agents/skills',
  PROJECT_AGENT_SKILLS_DIR: '.agents/skills',
}));

let mockCraftAgentsCliFlag = false;
mock.module('../../../feature-flags.ts', () => ({
  FEATURE_FLAGS: {
    get craftAgentsCli() {
      return mockCraftAgentsCliFlag;
    },
    get developerFeedback() {
      return false;
    },
    fastMode: false,
  },
}));

// ============================================================
// Import module under test (after mocks)
// ============================================================

import {
  runPreToolUseChecks,
  resolveBrowserChannelDirective,
  shouldPromptInAskMode,
  type PreToolUseInput,
  type PermissionManagerLike,
  type PrerequisiteManagerLike,
} from '../pre-tool-use.ts';

// ============================================================
// Test helpers
// ============================================================

function createMockPermissionManager(overrides?: Partial<PermissionManagerLike>): PermissionManagerLike {
  return {
    isCommandWhitelisted: () => false,
    isDangerousCommand: () => false,
    getBaseCommand: (cmd: string) => cmd.split(/\s+/)[0] || cmd,
    extractDomainFromNetworkCommand: () => null,
    isDomainWhitelisted: () => false,
    ...overrides,
  };
}

function createMockPrerequisiteManager(overrides?: Partial<PrerequisiteManagerLike>): PrerequisiteManagerLike {
  return {
    checkPrerequisites: () => ({ allowed: true }),
    trackBashSkillRead: () => false,
    ...overrides,
  };
}

function createInput(overrides?: Partial<PreToolUseInput>): PreToolUseInput {
  return {
    toolName: 'Read',
    input: { file_path: '/test/file.ts' },
    sessionId: 'test-session',
    permissionMode: 'allow-all',
    workspaceRootPath: '/test/workspace',
    workspaceId: 'test-ws',
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: true,
    permissionManager: createMockPermissionManager(),
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

describe('runPreToolUseChecks', () => {
  beforeEach(() => {
    mockEffectivePermissionMode = 'safe';
    mockShouldAllowToolInMode.mockReset();
    mockShouldAllowToolInMode.mockImplementation(() => ({ allowed: true, reason: '' }));
    mockIsApiEndpointAllowed.mockReset();
    mockIsApiEndpointAllowed.mockImplementation(() => false);
    mockIsReadOnlyBashCommandWithConfig.mockReset();
    mockIsReadOnlyBashCommandWithConfig.mockImplementation(() => false);
    mockDetectConfigFileType.mockReset();
    mockDetectConfigFileType.mockImplementation(() => null);
    mockDetectAppConfigFileType.mockReset();
    mockDetectAppConfigFileType.mockImplementation(() => null);
    mockValidateConfigFileContent.mockReset();
    mockValidateConfigFileContent.mockImplementation(() => null);
    mockReadOnlyBashPatterns = [];
    mockCraftAgentsCliFlag = false;
  });

  describe('host browser channel constraint', () => {
    it('blocks canonical browser fallback for an explicit browser ban or non-browser channel binding', () => {
      for (const currentUserRequest of [
        "N'utilise pas le navigateur.",
        'Do not use the browser.',
        "Utilise l'API et non l'interface.",
        'Concentre toi sur la partie API via le serveur.',
        "N'utilise pas le navigateur; passe par l'API.",
        "N'utilise jamais le navigateur; utilise l'API.",
        "N'utilise plus le navigateur; passe par SSH.",
        "Ne pas utiliser l'interface; utilise le connecteur.",
        "Ne jamais ouvrir l'interface; passe via le serveur.",
        "Ne plus ouvrir le navigateur; utilise l'API.",
      ]) {
        const result = runPreToolUseChecks(createInput({
          toolName: 'mcp__session__browser_tool',
          input: { command: 'snapshot' },
          currentUserRequest,
          objectiveAuthorizationSegments: [currentUserRequest],
        }));

        expect(result.type).toBe('block');
        if (result.type === 'block') {
          expect(result.reason).toContain('latest applicable human instruction');
          expect(result.reason).toContain('browser_tool is disabled');
          expect(result.reason).toContain('requested non-browser channel');
        }
      }
    });

    it('recognizes structured non-browser paths and unavailable browser fallbacks', () => {
      for (const currentUserRequest of [
        'Use the API because the browser is unavailable.',
        'Use the API; the browser is broken.',
        'The browser is unavailable. Use the API.',
        'Call the API directly.',
        'Execute this on the server.',
        'Use the API interface directly.',
      ]) {
        const result = runPreToolUseChecks(createInput({
          toolName: 'browser_tool',
          input: { command: 'open' },
          currentUserRequest,
          objectiveAuthorizationSegments: [currentUserRequest],
        }));
        expect(result.type).toBe('block');
      }
    });

    it('uses only the latest persisted objective segment when no current request is available', () => {
      const blocked = runPreToolUseChecks(createInput({
        toolName: 'browser_tool',
        input: { command: 'open' },
        objectiveAuthorizationSegments: [
          'Open the browser and inspect the public page.',
          'Use the connector only; do not use the browser interface.',
        ],
      }));
      expect(blocked.type).toBe('block');

      const superseded = runPreToolUseChecks(createInput({
        toolName: 'browser_tool',
        input: { command: 'open --foreground' },
        objectiveAuthorizationSegments: [
          'Use the connector only; do not use the browser interface.',
          'Reopen the browser so I can sign in for the authentication handoff.',
        ],
      }));
      expect(superseded.type).toBe('allow');
    });

    it('keeps the last explicit API constraint through a generic continue instruction', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'browser_tool',
        input: { command: 'snapshot' },
        currentUserRequest: 'Continue.',
        objectiveAuthorizationSegments: [
          'Use the API only; do not use the browser.',
          'Continue.',
        ],
      }));

      expect(result.type).toBe('block');
    });

    it('does not let a model-authored delegated child prompt override the authenticated root constraint', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'browser_tool',
        input: { command: 'open --foreground' },
        // A child receives this as its current turn, but it is not an
        // authenticated human objective segment and cannot grant itself a new
        // channel that the persisted root objective explicitly forbids.
        currentUserRequest: 'Open the browser and use the interface to finish the delegated task.',
        objectiveAuthorizationSegments: [
          'Use the API only; do not use the browser interface.',
        ],
      }));

      expect(result.type).toBe('block');
    });

    it('lets a later authenticated human instruction stop the API path and explicitly switch to the browser', () => {
      for (const currentUserRequest of [
        "N'utilise plus l'API, ouvre le navigateur.",
        "N'utilise pas l'API; utilise le navigateur.",
        "N'utilise jamais l'API; ouvre l'interface.",
        'Do not use the API; use the browser.',
        'Avoid the API; open the browser.',
        "Évite l'API; ouvre le navigateur.",
      ]) {
        const result = runPreToolUseChecks(createInput({
          toolName: 'browser_tool',
          input: { command: 'open --foreground' },
          currentUserRequest,
          objectiveAuthorizationSegments: [
            'Use the API only; do not use the browser.',
            currentUserRequest,
          ],
        }));

        expect(result.type).toBe('allow');
      }
    });

    it('uses the last explicit directive inside a correcting human segment', () => {
      const correction = 'Correction: ignore the earlier phrase do not use the browser; use the browser now.';
      const result = runPreToolUseChecks(createInput({
        toolName: 'browser_tool',
        input: { command: 'open --foreground' },
        currentUserRequest: correction,
        objectiveAuthorizationSegments: [
          'Use the API only; do not use the browser.',
          correction,
        ],
      }));

      expect(result.type).toBe('allow');
    });

    it('keeps browser lifecycle cleanup and help available under the channel constraint', () => {
      for (const command of ['help', '--help', '-h', 'release all', 'close window-1', 'hide']) {
        const result = runPreToolUseChecks(createInput({
          toolName: 'browser_tool',
          input: { command },
          currentUserRequest: 'Passe uniquement par SSH via le serveur, sans navigateur.',
        }));
        expect(result.type).toBe('allow');
      }

      const batched = runPreToolUseChecks(createInput({
        toolName: 'browser_tool',
        input: { command: 'release all; open' },
        currentUserRequest: 'Passe uniquement par SSH via le serveur, sans navigateur.',
      }));
      expect(batched.type).toBe('block');
    });

    it('honors an explicit browser authentication or visual-validation handoff in the latest request', () => {
      for (const currentUserRequest of [
        "Utilise l'API pour le travail, puis réouvre le navigateur afin que je puisse m'authentifier.",
        "Passe par le connecteur, puis ouvre l'interface pour une validation visuelle.",
        'Do not use the browser for work; then open it for visual validation.',
      ]) {
        const result = runPreToolUseChecks(createInput({
          toolName: 'browser_tool',
          input: { command: 'open --foreground' },
          currentUserRequest,
          objectiveAuthorizationSegments: [
            'Use the API only; do not use the browser.',
            currentUserRequest,
          ],
        }));
        expect(result.type).toBe('allow');
        expect(resolveBrowserChannelDirective(undefined, [currentUserRequest]))
          .toBe('browser-handoff');

        const mutation = runPreToolUseChecks(createInput({
          toolName: 'browser_tool',
          input: { command: 'click @e1' },
          currentUserRequest,
          objectiveAuthorizationSegments: [currentUserRequest],
          objectiveMutationAuthorized: true,
          externalActionPolicy: 'allow-in-execute',
        }));
        expect(mutation).toMatchObject({
          type: 'block',
          reason: expect.stringContaining('not for operational work'),
        });
      }
    });

    it('does not let a final visual-validation allowance become an operational browser fallback', () => {
      const instruction = "Utilise uniquement l'API pour les opérations. Ouvre le navigateur seulement pour la validation visuelle finale.";
      expect(resolveBrowserChannelDirective(undefined, [instruction])).toBe('browser-handoff');

      expect(runPreToolUseChecks(createInput({
        toolName: 'browser_tool',
        input: { command: 'snapshot' },
        objectiveAuthorizationSegments: [instruction],
      }))).toMatchObject({ type: 'allow' });

      for (const [toolName, input] of [
        ['browser_tool', { command: 'fill @e1 bypass-api' }],
        ['browser_click', {}],
      ] as const) {
        expect(runPreToolUseChecks(createInput({
          toolName,
          input,
          objectiveAuthorizationSegments: [instruction],
          objectiveMutationAuthorized: true,
          externalActionPolicy: 'allow-in-execute',
        }))).toMatchObject({
          type: 'block',
          reason: expect.stringContaining('do not use the browser as an API or connector fallback'),
        });
      }
    });

    it('does not block ordinary browser work or a browser used to consult API documentation', () => {
      for (const currentUserRequest of [
        'Ouvre le navigateur et vérifie la page publique.',
        "Utilise le navigateur pour consulter la documentation de l'API.",
        'Use the browser to test the API documentation examples.',
        'Use the API and browser together for this validation.',
        "Contrôle l'API via le navigateur.",
      ]) {
        const result = runPreToolUseChecks(createInput({
          toolName: 'browser_tool',
          input: { command: 'snapshot' },
          currentUserRequest,
        }));
        expect(result.type).toBe('allow');
      }
    });
  });

  // ============================================================
  // Step 1: Permission mode check
  // ============================================================

  describe('step 1: permission mode check', () => {
    it('blocks when shouldAllowToolInMode returns not allowed', () => {
      mockShouldAllowToolInMode.mockImplementation(() => ({
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

      expect(mockShouldAllowToolInMode).toHaveBeenCalledWith(
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
      expect(mockShouldAllowToolInMode).toHaveBeenCalledWith(
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

  // ============================================================
  // Step 5: Input transforms
  // ============================================================

  describe('step 5: input transforms', () => {
    beforeEach(() => {
      mockCraftAgentsCliFlag = true;
    });

    it('expands tilde paths and returns modify', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '~/Documents/file.ts' },
      }));

      expect(result.type).toBe('modify');
      if (result.type === 'modify') {
        expect(result.input.file_path).toBe('/Users/test/Documents/file.ts');
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
        expect(result.input.title).toBe('Bug fix');
        expect(result.input._intent).toBeUndefined();
        expect(result.input._displayName).toBeUndefined();
      }
    });

    it('combines path expansion and metadata stripping', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '~/test.ts', _intent: 'reading a file' },
      }));

      expect(result.type).toBe('modify');
      if (result.type === 'modify') {
        expect(result.input.file_path).toBe('/Users/test/test.ts');
        expect(result.input._intent).toBeUndefined();
      }
    });

    it('blocks direct label folder reads and suggests craft-agent label help when feature is enabled', () => {
      mockCraftAgentsCliFlag = true;

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
      mockCraftAgentsCliFlag = true;
      mockDetectConfigFileType.mockImplementation(() => ({ type: 'labels', displayFile: 'labels/config.json' }));

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
      mockCraftAgentsCliFlag = false;
      mockDetectConfigFileType.mockImplementation(() => ({ type: 'labels', displayFile: 'labels/config.json' }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Write',
        input: { file_path: '/test/workspace/labels/config.json', content: '{}' },
      }));

      expect(result.type).toBe('allow');
    });

    it('does not block label config writes when feature is disabled', () => {
      mockCraftAgentsCliFlag = false;
      mockDetectConfigFileType.mockImplementation(() => ({ type: 'labels', displayFile: 'labels/config.json' }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Write',
        input: { file_path: '/test/workspace/labels/config.json', content: '{}' },
      }));

      expect(result.type).toBe('allow');
    });

    it('does not block bash commands touching automations files when feature is disabled', () => {
      mockCraftAgentsCliFlag = false;

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'python3 scripts/update.py automations.json' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('allow');
    });

    it('blocks direct automations config edits and suggests craft-agent automation commands when feature is enabled', () => {
      mockCraftAgentsCliFlag = true;
      mockDetectConfigFileType.mockImplementation(() => ({ type: 'automations', displayFile: 'automations.json' }));

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
      mockCraftAgentsCliFlag = true;
      mockDetectConfigFileType.mockImplementation(() => ({
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
      mockCraftAgentsCliFlag = true;
      mockDetectConfigFileType.mockImplementation(() => ({
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
      mockCraftAgentsCliFlag = true;

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
      mockCraftAgentsCliFlag = true;

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
      mockCraftAgentsCliFlag = false;

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

  // ============================================================
  // Step 6: Ask-mode prompt decision
  // ============================================================

  describe('step 6: ask-mode prompt decision', () => {
    beforeEach(() => {
      mockEffectivePermissionMode = 'ask';
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
      mockEffectivePermissionMode = 'allow-all';

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('allow');
    });

    it('does not prompt in safe mode (blocked at step 1 instead)', () => {
      mockShouldAllowToolInMode.mockImplementation(() => ({
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
        expect(result.modifiedInput!.file_path).toBe('/Users/test/test.ts');
        expect(result.modifiedInput!._intent).toBeUndefined();
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

  // ============================================================
  // Pipeline ordering
  // ============================================================

  describe('pipeline ordering', () => {
    it('permission check runs before source blocking', () => {
      // If tool is blocked by mode, source blocking should not run
      mockShouldAllowToolInMode.mockImplementation(() => ({
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
        expect(result.input._intent).toBe('summarize');
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
      mockShouldAllowToolInMode.mockImplementation(() => ({
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

  describe('signed synthetic resume target authority regressions', () => {
    const runReplay = (
      objective: string | readonly string[],
      toolName: string,
      input: Record<string, unknown>,
      sources = ['rbw-servers'],
      sessionId?: string,
    ) => {
      const objectiveSegments = typeof objective === 'string' ? [objective] : [...objective];
      const markerSessionId = /^\[robb-resume:([a-z0-9]+(?:-[a-z0-9]+)*):/mu
        .exec(objectiveSegments.find(segment => /^\[robb-resume:/mu.test(segment)) ?? '')?.[1];
      mockEffectivePermissionMode = 'allow-all';
      return runPreToolUseChecks(createInput({
        toolName,
        input,
        sessionId: sessionId ?? markerSessionId ?? 'test-session',
        currentUserRequest: objectiveSegments.at(-1),
        objectiveAuthorizationSegments: objectiveSegments,
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        externalActionPolicy: 'allow-in-execute',
        activeSourceSlugs: sources,
        allSourceSlugs: sources,
      }));
    };

    const trueBay = `[robb-resume:260918-true-bay:38940c8bc27546ee414d6e2374737b2c7a6273b5:v1]
Le staging corrigé est actif. Reprends l’objectif initial complet : réactiver sur zero.example.test le dev login à la place du formulaire.
Périmètre autorisé exact : serveur \`dev\`, dépôt \`/srv/workspace/zero\`, services Zero uniquement. Utilise exclusivement la source \`rbw-servers\` et ses outils SSH structurés ; aucun navigateur opérationnel, SSH natif ou Bash local.
Tu es explicitement autorisé à modifier la configuration ou le code Zero, reconstruire/redéployer uniquement Zero et redémarrer uniquement ses services si le diagnostic le rend nécessaire. Ne touche ni Traefik global ni aucun autre projet. Vérifie après changement la révision déployée, la santé, le HTML ou les endpoints d’authentification, et un parcours dev-login fonctionnel sans formulaire de production.`;

    it('allows the exact True Bay relative source read and rejects server/root/path retargeting', () => {
      const exact = {
        server: 'dev', cwd: '/srv/workspace/zero',
        command: "sed -n '1,260p' 'app/(auth)/login/page.tsx'",
      };
      expect(runReplay(trueBay, 'mcp__rbw-servers__ssh_execute', exact)).toMatchObject({ type: 'allow' });
      for (const input of [
        { ...exact, server: 'pns' },
        { ...exact, cwd: '/srv/workspace/orion' },
        { ...exact, command: "sed -n '1,260p' '../orion/page.tsx'" },
        { ...exact, command: 'rm -f app/page.tsx' },
      ]) expect(runReplay(trueBay, 'mcp__rbw-servers__ssh_execute', input).type).not.toBe('allow');
      expect(runReplay(
        `${trueBay}\nN’utilise finalement pas le serveur dev et ne lis rien dans ce dépôt.`,
        'mcp__rbw-servers__ssh_execute',
        exact,
      ).type).not.toBe('allow');
      for (const amendment of [
        'Arrête tout maintenant.',
        'Ne poursuis plus cette mission.',
        'La cible devient Orion.',
        'Utilise désormais le serveur pns.',
        'Travaille plutôt dans /srv/workspace/orion.',
      ]) {
        expect(runReplay(
          [trueBay, amendment],
          'mcp__rbw-servers__ssh_execute',
          exact,
        ).type).not.toBe('allow');
      }
      for (const continuation of [
        'Continue.',
        'Poursuis l’analyse et l’optimisation.',
        'Reprends et va réellement jusqu’au bout de la mission.',
        'Continue sans t’arrêter.',
        'Reprend.',
      ]) {
        expect(runReplay(
          [trueBay, continuation],
          'mcp__rbw-servers__ssh_execute',
          exact,
        )).toMatchObject({ type: 'allow' });
      }
      for (const retargetedContinuation of [
        'Continue sur pns.',
        'Reprends mais sans SSH.',
        'Poursuis sur /srv/workspace/orion.',
      ]) {
        expect(runReplay(
          [trueBay, retargetedContinuation],
          'mcp__rbw-servers__ssh_execute',
          exact,
        ).type).not.toBe('allow');
      }
    });

    const wild = `[robb-resume:260915-wild-plateau:38940c8bc27546ee414d6e2374737b2c7a6273b5:v1]
Périmètre autorisé exact : serveur \`dev\`, dépôt \`/srv/workspace/orion\` et service \`orion-agent-bridge\` uniquement. Utilise exclusivement la source \`rbw-servers\` et ses outils SSH structurés.
URL autorisée : \`https://orion.example.test\`. Réconcilie l’état, lis les règles du dépôt, reproduis le défaut puis corrige le code Orion avec sauvegarde et retour arrière. Redémarre uniquement \`orion-agent-bridge\` si nécessaire ; ne reconstruis ou redéploie Orion que si le diagnostic le rend indispensable.
Vérifie que \`GET /assistant-api/accounts\` répond 200, que \`/parametres\` fonctionne et que \`bun run test:orion-production\` réussit dans \`/srv/workspace/orion\`.`;

    it('allows only the target-bound Wild curl, test, sed and compose reads', () => {
      const inputs = [
        { server: 'dev', cwd: '/srv/workspace/orion', command: 'curl --fail-with-body --silent --show-error --max-time 15 https://orion.example.test/assistant-api/accounts' },
        { server: 'dev', cwd: '/srv/workspace/orion', command: 'curl --fail-with-body --silent --show-error --max-time 15 https://orion.example.test/parametres' },
        { server: 'dev', cwd: '/srv/workspace/orion', command: 'bun run test:orion-production' },
        { server: 'dev', cwd: '/srv/workspace/orion', command: "sed -n '1,220p' apps/agent-bridge/server.mjs" },
        { server: 'dev', cwd: '/srv/workspace/orion', command: 'readlink -f apps/agent-bridge/server.mjs' },
        { server: 'dev', cwd: '/srv/workspace/orion', command: 'docker compose -f docker-compose.orion.yml ps' },
        { server: 'dev', cwd: '/srv/workspace/orion', command: "docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' orion-web | sed 's/=.*//' | sort" },
        { server: 'dev', cwd: '/srv/workspace/orion', command: "git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager log -1 --format='%H %cI %s'" },
      ];
      for (const input of inputs) {
        const result = runReplay(wild, 'mcp__rbw-servers__ssh_execute', input);
        if (result.type !== 'allow') throw new Error(`${input.command}: ${JSON.stringify(result)}`);
      }
      for (const input of [
        { ...inputs[0], command: 'curl --fail-with-body --silent --show-error --max-time 15 https://attacker.example/assistant-api/accounts' },
        { ...inputs[0], command: 'curl --fail-with-body --silent --show-error --max-time 15 https://orion.example.test.attacker.example/assistant-api/accounts' },
        { ...inputs[0], command: 'curl --fail-with-body --silent --show-error --max-time 15 https://orion.example.test/admin' },
        { ...inputs[2], command: 'bun run test:orion-destructive' },
        { ...inputs[3], cwd: '/srv/workspace/zero' },
        { ...inputs[6], command: "docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' zero-web | sed 's/=.*//' | sort" },
      ]) expect(runReplay(wild, 'mcp__rbw-servers__ssh_execute', input).type).not.toBe('allow');
      const negatedChecks = `${wild}\nN’exécute pas \`bun run test:orion-production\` et ne lance pas \`GET /assistant-api/accounts\`; vérifie autrement.`;
      expect(runReplay(negatedChecks, 'mcp__rbw-servers__ssh_execute', inputs[0]!).type).not.toBe('allow');
      expect(runReplay(negatedChecks, 'mcp__rbw-servers__ssh_execute', inputs[2]!).type).not.toBe('allow');
    });

    const silver = `[robb-resume:260916-silver-orchid:38940c8bc27546ee414d6e2374737b2c7a6273b5:v1]
Nouvel objectif opérationnel : reprends et termine réellement la résolution e-doc PNS du contrat \`3602\`, job \`16\`, corrélation \`85236791-757d-463a-bd53-c1f72197feb0\`.
Utilise exclusivement les API et la source \`rbw-servers\` avec ses outils SSH structurés. La cible PNS réellement observée est la révision \`fc5eb77c8b2063d825dd3779061cb8a949e77632\`, image \`registry.robinswood.io/pns-gen:prod-latest\`.
Pour toute lecture SQL minimale, cible seulement la clé primaire exacte (\`SELECT c.id FROM contracts c WHERE c.id=3602 LIMIT 1\`) puis préfère API, journaux et vérificateurs nommés pour l’état enrichi.`;

    it('does not infer database or container execution authority from a historical resume marker', () => {
      const sql = 'docker exec pnsgen-db psql -U postgres -d pnsgen -tAc "SELECT c.id FROM contracts c WHERE c.id=3602 LIMIT 1"';
      expect(runReplay(silver, 'mcp__rbw-servers__ssh_execute', { server: 'pns', command: sql, timeout: 30_000 }))
        .toMatchObject({ type: 'block' });
      expect(runReplay(silver, 'mcp__rbw-servers__ssh_execute', { server: 'pns', command: 'docker exec pnsgen-app ls -la /app', timeout: 30_000 }))
        .toMatchObject({ type: 'block' });
      for (const input of [
        { server: 'dev', command: sql },
        { server: 'pns', command: sql.replace('c.id=3602', 'c.id=3603') },
        { server: 'pns', command: sql.replace('-d pnsgen', '-d postgres') },
        { server: 'pns', command: 'docker exec pnsgen-app rm -rf /app/cache' },
      ]) expect(runReplay(silver, 'mcp__rbw-servers__ssh_execute', input).type).not.toBe('allow');
      for (const amendment of [
        'Arrête tout maintenant.',
        'Ne lis plus la base PNS.',
        'N’utilise plus rbw-servers ni SSH.',
        'La cible devient le contrat 3603.',
      ]) expect(runReplay(
        [silver, amendment],
        'mcp__rbw-servers__ssh_execute',
        { server: 'pns', command: sql, timeout: 30_000 },
      ).type).not.toBe('allow');
      const negatedSql = `${silver}\nN’exécute pas la lecture SQL \`SELECT c.id FROM contracts c WHERE c.id=3602 LIMIT 1\`; vérifie autrement.`;
      expect(runReplay(
        negatedSql,
        'mcp__rbw-servers__ssh_execute',
        { server: 'pns', command: sql, timeout: 30_000 },
      ).type).not.toBe('allow');
      for (const continuation of [
        'Continue.',
        'Reprend.',
        'Poursuis l’analyse et l’optimisation.',
        'Reprends et va réellement jusqu’au bout de la mission.',
        'Continue sans t’arrêter.',
      ]) expect(runReplay(
        [silver, continuation],
        'mcp__rbw-servers__ssh_execute',
        { server: 'pns', command: sql, timeout: 30_000 },
      )).toMatchObject({ type: 'block' });
    });

    const gentle = `[robb-resume:260918-gentle-fountain:38940c8bc27546ee414d6e2374737b2c7a6273b5:v1]
Utilise exclusivement Gmail en lecture et la source \`plc-microsoft-365\` via Microsoft Graph / API. Aucun navigateur ni interface. La cible exacte est le site RH privé \`exampleorg.sharepoint.com,06efb18b-29c2-409a-8ef4-d634918a7caa,a833b57e-9482-471b-9aa9-4dad3e78e46d\` (\`Example Org — Onboarding collaborateurs RH\`).
Matérialise le formulaire API-first comme formulaire natif d’une Microsoft List/SharePoint list privée dédiée \`Example RH - Entretiens annuels\`, avec les colonnes et rubriques utiles. Crée par API le rangement documentaire RH nécessaire dans la bibliothèque privée existante, avec une structure sûre et sans élargir les permissions.
Drive documentaire exact : \`b!syntheticDriveIdentifierForPublicFixture0000000000000000000000000\`
Dossier documentaire exact : \`Entretiens annuels\``;
    const site = 'exampleorg.sharepoint.com,06efb18b-29c2-409a-8ef4-d634918a7caa,a833b57e-9482-471b-9aa9-4dad3e78e46d';
    const listBody = {
      displayName: 'Example RH - Entretiens annuels',
      description: 'Liste privée Example Org pour préparer, co-remplir, valider et archiver les entretiens annuels des profils Comptable, Juridique et Gestionnaire de paie / Social.',
      columns: [{
        name: 'ProfilMetier', displayName: 'Profil métier',
        description: 'Sélectionner la trame applicable.', required: true,
        choice: {
          allowTextEntry: false,
          choices: ['Comptable', 'Juridique', 'Gestionnaire de paie / Social'],
          displayAs: 'dropDownMenu',
        },
      }, {
        name: 'Collaborateur', displayName: 'Collaborateur', required: true,
        personOrGroup: {
          allowMultipleSelection: false,
          chooseFromType: 'peopleOnly',
          displayAs: 'nameWithPresence',
        },
      }, {
        name: 'BilanCollab', displayName: 'Bilan collaborateur',
        text: {
          allowMultipleLines: true,
          appendChangesToExistingText: false,
          linesForEditing: 8,
          textType: 'plain',
        },
      }, {
        name: 'DateEntretien', displayName: 'Date de l’entretien',
        dateTime: { displayAs: 'default', format: 'dateOnly' },
      }, {
        name: 'NoteGlobale', displayName: 'Note globale /10',
        number: { decimalPlaces: 'none', displayAs: 'number', minimum: 1, maximum: 10 },
      }, {
        name: 'InformationDonnees', displayName: 'Information confirmée',
        boolean: {},
      }],
      list: { template: 'genericList' },
    };

    it('allows the exact Gentle list and drive-bound folder POSTs and blocks retargeting', () => {
      const list = { method: 'POST', endpoint: `sites/${site}/lists`, body: listBody };
      const folder = {
        method: 'POST', endpoint: 'drives/b!syntheticDriveIdentifierForPublicFixture0000000000000000000000000/root/children',
        body: { name: 'Entretiens annuels', folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
      };
      expect(runReplay(gentle, 'mcp__plc-microsoft-365__graph_request', list, ['plc-microsoft-365']))
        .toMatchObject({ type: 'allow' });
      expect(runReplay(gentle, 'mcp__plc-microsoft-365__graph_request', folder, ['plc-microsoft-365']))
        .toMatchObject({ type: 'allow' });
      const malformedColumns = [
        [...listBody.columns, { name: 'Lookup', displayName: 'Lookup', lookup: {} }],
        listBody.columns.map((column, index) => index === 0
          ? { ...column, text: { allowMultipleLines: false } }
          : column),
        listBody.columns.map((column, index) => index === 4
          ? { ...column, number: { decimalPlaces: 'none', minimum: Number.NaN, maximum: 10 } }
          : column),
        listBody.columns.map((column, index) => index === 4
          ? { ...column, number: { decimalPlaces: 'none', minimum: 11, maximum: 10 } }
          : column),
        listBody.columns.map((column, index) => index === 4
          ? { ...column, number: { decimalPlaces: 'none', minimum: 1, maximum: 10, unit: 'EUR' } }
          : column),
        listBody.columns.map((column, index) => index === 4
          ? { ...column, number: { decimalPlaces: ['none'], minimum: 1, maximum: 10 } }
          : column),
        listBody.columns.map((column, index) => index === 2
          ? { ...column, text: { allowMultipleLines: true, textType: ['plain'] } }
          : column),
        listBody.columns.map((column, index) => index === 5
          ? { ...column, boolean: { default: true } }
          : column),
      ];
      for (const columns of malformedColumns) {
        expect(runReplay(
          gentle,
          'mcp__plc-microsoft-365__graph_request',
          { ...list, body: { ...listBody, columns } },
          ['plc-microsoft-365'],
        ).type).not.toBe('allow');
      }
      expect(runReplay(
        gentle,
        'mcp__plc-microsoft-365__graph_request',
        { ...list, body: { displayName: listBody.displayName, description: listBody.description, list: listBody.list } },
        ['plc-microsoft-365'],
      )).toMatchObject({
        type: 'block',
        reason: expect.stringContaining('empty/partial list'),
      });
      for (const input of [
        { ...list, endpoint: 'sites/attacker.example,06efb18b-29c2-409a-8ef4-d634918a7caa,a833b57e-9482-471b-9aa9-4dad3e78e46d/lists' },
        { ...list, endpoint: `sites/${site}.attacker.example/lists` },
        { ...list, body: { ...listBody, displayName: 'Example RH - Salaires' } },
        { ...folder, endpoint: 'drives/other/root/children' },
        { ...folder, body: { ...folder.body, name: 'Autre dossier' } },
        { ...folder, body: { ...folder.body, '@microsoft.graph.conflictBehavior': 'replace' } },
        { ...folder, body: { ...folder.body, extra: true } },
        { ...list, method: 'DELETE' },
      ]) expect(runReplay(gentle, 'mcp__plc-microsoft-365__graph_request', input, ['plc-microsoft-365']).type).not.toBe('allow');
      expect(runReplay(
        [gentle, 'Ne crée finalement pas la liste ni le dossier.'],
        'mcp__plc-microsoft-365__graph_request',
        list,
        ['plc-microsoft-365'],
      ).type).not.toBe('allow');
      for (const continuation of [
        'Continue.',
        'Reprend.',
        'Poursuis l’analyse et l’optimisation.',
        'Reprends et va réellement jusqu’au bout de la mission.',
        'Continue sans t’arrêter.',
      ]) expect(runReplay(
        [gentle, continuation],
        'mcp__plc-microsoft-365__graph_request',
        list,
        ['plc-microsoft-365'],
      )).toMatchObject({ type: 'allow' });
    });

    const boundedPath = '/srv/rbw-agents-oss/scripts/fixture_paper_metrics_v1.py';
    const boundedWrite = `[robb-resume:test-bounded-write:2222222222222222222222222222222222222222:v2]
Poursuis l’amélioration de la stratégie exclusivement dans l’environnement paper/sandbox via la source structurée \`rbw-agents-oss\`.
Source OSS exacte autorisée : \`rbw-agents-oss\`.
Fichier OSS exact autorisé en écriture atomique : \`${boundedPath}\`.
Lis d’abord son hash, écris uniquement ce fichier et exécute les tests hors réseau. Aucun autre fichier, source, ordre, broker, capital live ou déploiement n’est autorisé.`;

    it('allows only the literal OSS path bound by the latest signed atomic-write contract', () => {
      const toolName = 'mcp__rbw-agents-oss__oss_write_file';
      const exact = {
        path: boundedPath,
        content: '#!/usr/bin/env python3\nprint("bounded")\n',
        _displayName: 'Ajouter métriques nettes',
        _intent: 'Créer le module paper borné et le vérifier hors réseau.',
      };
      expect(runReplay(boundedWrite, toolName, exact, ['rbw-agents-oss']))
        .toMatchObject({
          type: 'modify',
          input: { path: boundedPath, content: exact.content },
        });
      expect(runReplay(
        [boundedWrite, 'Continue sans t’arrêter.'],
        toolName,
        exact,
        ['rbw-agents-oss'],
      )).toMatchObject({
        type: 'modify',
          input: { path: boundedPath, content: exact.content },
      });
      expect(runReplay(
        boundedWrite,
        toolName,
        exact,
        ['rbw-agents-oss'],
        'test-copied-session',
      )).toMatchObject({
        type: 'block',
        reason: expect.stringContaining('belongs to another durable session'),
      });

      for (const [candidateTool, input] of [
        [toolName, { ...exact, path: '/srv/rbw-agents-oss/scripts/fixture_paper_metrics_v2.py' }],
        [toolName, { ...exact, path: '/srv/rbw-agents-oss/scripts/tmp/../fixture_paper_metrics_v1.py' }],
        [toolName, { ...exact, path: '${OSS_ROOT}/scripts/fixture_paper_metrics_v1.py' }],
        [toolName, { ...exact, path: '/srv/rbw-agents-oss/scripts/*.py' }],
        [toolName, { ...exact, sibling: '/srv/rbw-agents-oss/scripts/fixture_paper_metrics_v2.py' }],
        ['mcp__other-source__oss_write_file', exact],
      ] as const) expect(runReplay(
        boundedWrite,
        candidateTool,
        input,
        ['rbw-agents-oss', 'other-source'],
      ).type).not.toBe('allow');

      for (const forbiddenPath of [
        '/etc/sudoers',
        '/root/.ssh/authorized_keys',
        '/srv/rbw-agents-oss/.env',
        '/srv/rbw-agents-oss/scripts/.env',
        '/srv/rbw-agents-oss/scripts/private-key.pem',
      ]) {
        const forbiddenObjective = boundedWrite.replace(boundedPath, forbiddenPath);
        expect(runReplay(
          forbiddenObjective,
          toolName,
          { ...exact, path: forbiddenPath },
          ['rbw-agents-oss'],
        )).toMatchObject({ type: 'block' });
      }

      for (const invalidObjective of [
        `[robb-resume:test-other-mission:2222222222222222222222222222222222222222:v2]\nPoursuis une autre mission dans son propre périmètre.`,
        boundedWrite.replace(boundedPath, '/srv/rbw-agents-oss/scripts/fixture_paper_metrics_v2.py'),
        boundedWrite.replace(boundedPath, '${OSS_ROOT}/scripts/fixture_paper_metrics_v1.py'),
        `${boundedWrite}\nN’écris finalement pas ce fichier.`,
        `${boundedWrite}\nSource OSS exacte autorisée : \`other-source\`.`,
        `${boundedWrite}\nUtilise désormais une autre source.`,
        `${boundedWrite}\nTravaille plutôt sur \`/srv/rbw-agents-oss/scripts/fixture_paper_metrics_v2.py\`.`,
      ]) expect(runReplay(
        invalidObjective,
        toolName,
        exact,
        ['rbw-agents-oss'],
      ).type).not.toBe('allow');

      for (const amendment of [
        'Arrête tout maintenant.',
        'N’écris plus ce fichier.',
        'Travaille plutôt sur un autre projet.',
        'Utilise désormais une autre source.',
      ]) expect(runReplay(
        [boundedWrite, amendment],
        toolName,
        exact,
        ['rbw-agents-oss'],
      ).type).not.toBe('allow');

      const secondPath = '/srv/rbw-agents-oss/scripts/audits/paper_snapshot_v2.py';
      const secondContract = `[robb-resume:test-second-write:3333333333333333333333333333333333333333:v3]
Source OSS exacte autorisée : \`rbw-agents-oss\`.
Fichier OSS exact autorisé en écriture atomique : \`${secondPath}\`.
Écris uniquement cet artefact OSS, puis vérifie-le sans réseau.`;
      const secondInput = { path: secondPath, content: 'print("second contract")\n' };
      expect(runReplay(secondContract, toolName, secondInput, ['rbw-agents-oss']))
        .toMatchObject({ type: 'allow' });
      expect(runReplay(secondContract, toolName, exact, ['rbw-agents-oss']).type)
        .not.toBe('allow');
      expect(runReplay(boundedWrite, toolName, secondInput, ['rbw-agents-oss']).type)
        .not.toBe('allow');
    });
  });
});

// ============================================================
// shouldPromptInAskMode
// ============================================================

describe('shouldPromptInAskMode', () => {
  let pm: PermissionManagerLike;

  beforeEach(() => {
    pm = createMockPermissionManager();
    mockShouldAllowToolInMode.mockReset();
    mockIsApiEndpointAllowed.mockReset();
    mockIsApiEndpointAllowed.mockImplementation(() => false);
    mockIsReadOnlyBashCommandWithConfig.mockReset();
    mockIsReadOnlyBashCommandWithConfig.mockImplementation(() => false);
    mockDetectConfigFileType.mockReset();
    mockDetectConfigFileType.mockImplementation(() => null);
    mockDetectAppConfigFileType.mockReset();
    mockDetectAppConfigFileType.mockImplementation(() => null);
    mockValidateConfigFileContent.mockReset();
    mockValidateConfigFileContent.mockImplementation(() => null);
    mockReadOnlyBashPatterns = [];
    mockCraftAgentsCliFlag = false;
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
      mockIsReadOnlyBashCommandWithConfig.mockImplementation(() => true);

      const result = shouldPromptInAskMode('Bash', { command: 'ls -la' }, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: [],
      });

      expect(result).toBeNull();
    });

    it('does NOT auto-allow bash commands with redirects (e.g. cat > file)', () => {
      // isReadOnlyBashCommandWithConfig uses AST validation which catches redirects
      mockIsReadOnlyBashCommandWithConfig.mockImplementation(() => false);

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
      mockShouldAllowToolInMode.mockImplementation(
        (_tool: string, _input: Record<string, unknown>, mode: string) =>
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
      mockShouldAllowToolInMode.mockImplementation(() => ({ allowed: true, reason: '' }));

      const result = shouldPromptInAskMode('mcp__linear__listIssues', {}, pm, {
        workspaceRootPath: '/test',
        activeSourceSlugs: ['linear'],
      });

      expect(result).toBeNull();
    });

    it('auto-allows whitelisted MCP mutations', () => {
      mockShouldAllowToolInMode.mockImplementation(
        (_tool: string, _input: Record<string, unknown>, mode: string) =>
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
      mockIsApiEndpointAllowed.mockImplementation(() => true);

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
