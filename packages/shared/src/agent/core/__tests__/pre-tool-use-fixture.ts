import { mock } from 'bun:test';
type ModeModule = typeof import('../../mode-manager.ts');
type ValidatorModule = typeof import('../../../config/validators.ts');

export const preToolUseMocks = {
  shouldAllowToolInMode: mock<ModeModule['shouldAllowToolInMode']>(() => ({ allowed: true, reason: '' })),
  isApiEndpointAllowed: mock<ModeModule['isApiEndpointAllowed']>(() => false),
  isReadOnlyBashCommandWithConfig: mock<ModeModule['isReadOnlyBashCommandWithConfig']>(() => false),
  permissionMode: 'safe' as 'safe' | 'ask' | 'allow-all',
  readOnlyBashPatterns: [] as Array<{ regex: RegExp }>,
  detectConfigFileType: mock<ValidatorModule['detectConfigFileType']>(() => null),
  detectAppConfigFileType: mock<ValidatorModule['detectAppConfigFileType']>(() => null),
  validateConfigFileContent: mock<ValidatorModule['validateConfigFileContent']>(() => null),
  craftAgentsCli: false,
};

mock.module('../../mode-manager.ts', () => ({
  shouldAllowToolInMode: (...args: Parameters<ModeModule['shouldAllowToolInMode']>) => preToolUseMocks.shouldAllowToolInMode(...args),
  isApiEndpointAllowed: (...args: Parameters<ModeModule['isApiEndpointAllowed']>) => preToolUseMocks.isApiEndpointAllowed(...args),
  isReadOnlyBashCommandWithConfig: (...args: Parameters<ModeModule['isReadOnlyBashCommandWithConfig']>) => preToolUseMocks.isReadOnlyBashCommandWithConfig(...args),
  getPermissionModeDiagnostics: () => ({
    permissionMode: preToolUseMocks.permissionMode,
    modeVersion: 7,
    lastChangedAt: '2026-02-28T18:00:00.000Z',
    lastChangedBy: 'user',
  }),
}));

mock.module('../../permissions-config.ts', () => ({
  permissionsConfigCache: {
    getMergedConfig: () => ({
      readOnlyBashPatterns: preToolUseMocks.readOnlyBashPatterns,
      readOnlyMcpPatterns: [],
    }),
  },
}));

mock.module('../../../utils/paths.ts', () => ({
  expandPath: (p: string) => p.replace(/^~/, '/Users/test'),
}));

mock.module('node:fs', () => ({
  existsSync: (_path: string) => false,
  readFileSync: (_path: string) => '',
}));

mock.module('../../../config/validators.ts', () => ({
  detectConfigFileType: (...args: Parameters<ValidatorModule['detectConfigFileType']>) => preToolUseMocks.detectConfigFileType(...args),
  detectAppConfigFileType: (...args: Parameters<ValidatorModule['detectAppConfigFileType']>) => preToolUseMocks.detectAppConfigFileType(...args),
  validateConfigFileContent: (...args: Parameters<ValidatorModule['validateConfigFileContent']>) => preToolUseMocks.validateConfigFileContent(...args),
  formatValidationResult: () => '',
}));

mock.module('../../../skills/types.ts', () => ({
  AGENTS_PLUGIN_NAME: '.agents',
}));

mock.module('../../../skills/storage.ts', () => ({
  GLOBAL_AGENT_SKILLS_DIR: '/Users/test/.agents/skills',
  PROJECT_AGENT_SKILLS_DIR: '.agents/skills',
}));

mock.module('../../../feature-flags.ts', () => ({
  FEATURE_FLAGS: {
    get craftAgentsCli() {
      return preToolUseMocks.craftAgentsCli;
    },
    get developerFeedback() {
      return false;
    },
    fastMode: false,
  },
}));

import { runPreToolUseChecks, resolveBrowserChannelDirective, shouldPromptInAskMode, type PreToolUseInput, type PermissionManagerLike, type PrerequisiteManagerLike } from '../pre-tool-use.ts';

export function createMockPermissionManager(overrides?: Partial<PermissionManagerLike>): PermissionManagerLike {
  return {
    isCommandWhitelisted: () => false,
    isDangerousCommand: () => false,
    getBaseCommand: (cmd: string) => cmd.split(/\s+/)[0] || cmd,
    extractDomainFromNetworkCommand: () => null,
    isDomainWhitelisted: () => false,
    ...overrides,
  };
}

export function createMockPrerequisiteManager(overrides?: Partial<PrerequisiteManagerLike>): PrerequisiteManagerLike {
  return {
    checkPrerequisites: () => ({ allowed: true }),
    trackBashSkillRead: () => false,
    ...overrides,
  };
}

export function createInput(overrides?: Partial<PreToolUseInput>): PreToolUseInput {
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

export function resetPreToolUseFixture(): void {
    preToolUseMocks.permissionMode = 'safe';
    preToolUseMocks.shouldAllowToolInMode.mockReset();
    preToolUseMocks.shouldAllowToolInMode.mockImplementation(() => ({ allowed: true, reason: '' }));
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
  }

export { runPreToolUseChecks, resolveBrowserChannelDirective, shouldPromptInAskMode };
export type { PreToolUseInput, PermissionManagerLike, PrerequisiteManagerLike };
