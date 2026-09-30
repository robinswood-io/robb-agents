import { afterEach, describe, expect, it } from 'bun:test';
import { cleanupModeState, initializeModeState } from './mode-manager.ts';
import { isYoloMode, yoloHumanHandoffBlock } from './yolo-policy.ts';
import { runPreToolUseChecks } from './core/pre-tool-use.ts';
import { PromptBuilder } from './core/prompt-builder.ts';

const ids: string[] = [];
afterEach(() => ids.splice(0).forEach(cleanupModeState));
const interactiveTools = [
  'request_user_input', 'SubmitPlan', 'source_credential_prompt',
  'source_oauth_trigger', 'source_google_oauth_trigger',
  'source_slack_oauth_trigger', 'source_microsoft_oauth_trigger',
];

describe('YOLO no-human execution policy', () => {
  it('requires both existing explicit controls and keeps Ask and Explore interactive', () => {
    for (const mode of ['safe', 'ask', 'allow-all'] as const) {
      for (const policy of [undefined, 'confirm', 'allow-in-execute'] as const) {
        expect(isYoloMode(mode, policy)).toBe(mode === 'allow-all' && policy === 'allow-in-execute');
      }
    }
  });

  for (const tool of interactiveTools) {
    for (const prefix of ['', 'session__', 'mcp__session__']) {
      it(`rejects ${prefix}${tool} before an interactive handler can execute`, () => {
        const sessionId = `yolo-${ids.length}`; ids.push(sessionId);
        initializeModeState(sessionId, 'allow-all');
        const result = runPreToolUseChecks({
          toolName: prefix + tool, input: {}, sessionId,
          // Deliberately stale backend metadata: the authoritative mode wins.
          permissionMode: 'ask', externalActionPolicy: 'allow-in-execute',
          workspaceRootPath: '/tmp/yolo-fixture', workspaceId: 'fixture', plansFolderPath: '/tmp/plans',
          activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false,
          permissionManager: {} as never, prerequisiteManager: undefined,
        });
        expect(result).toMatchObject({ type: 'block', reason: expect.stringContaining('YOLO_HUMAN_HANDOFF_DISABLED') });
      });
    }
  }

  it('does not turn unrelated connector names or autonomous planning into human handoffs', () => {
    for (const tool of ['mcp__crm__request_user_input', 'mcp__crm__SubmitPlan', 'update_plan', 'Read', 'Bash']) {
      expect(yoloHumanHandoffBlock(tool, 'allow-all', 'allow-in-execute')).toBeUndefined();
    }
    for (const tool of interactiveTools) {
      expect(yoloHumanHandoffBlock(tool, 'ask', 'allow-in-execute')).toBeUndefined();
      expect(yoloHumanHandoffBlock(tool, 'safe', 'allow-in-execute')).toBeUndefined();
      expect(yoloHumanHandoffBlock(tool, 'allow-all', 'confirm')).toBeUndefined();
    }
  });

  it('refuses an unavailable permission in an inherited Ask session without opening a human prompt', () => {
    const sessionId = 'yolo-inherited-ask'; ids.push(sessionId); initializeModeState(sessionId, 'ask');
    const result = runPreToolUseChecks({ toolName: 'Bash', input: { command: 'touch /tmp/yolo-fixture-output' },
      sessionId, permissionMode: 'ask', externalActionPolicy: 'allow-in-execute', humanInputAllowed: false,
      workspaceRootPath: '/tmp/yolo-fixture', workspaceId: 'fixture', activeSourceSlugs: [], allSourceSlugs: [],
      hasSourceActivation: false, permissionManager: { isCommandWhitelisted: () => false,
        isDangerousCommand: () => false, getBaseCommand: () => 'touch', extractDomainFromNetworkCommand: () => null,
        isDomainWhitelisted: () => false } as never, prerequisiteManager: undefined });
    expect(result).toMatchObject({ type: 'block', reason: expect.stringContaining('No tool was executed') });
    expect(yoloHumanHandoffBlock('request_user_input', 'safe', 'confirm', false)).toContain('YOLO_HUMAN_HANDOFF_DISABLED');
  });

  it('turns an exact deferred external approval into a diagnostic without executing or prompting', () => {
    const sessionId = 'yolo-external-approval'; ids.push(sessionId); initializeModeState(sessionId, 'allow-all');
    const objective = 'Vérifie Sent/Brouillons pour éviter un doublon, puis arrête-toi immédiatement avant l’envoi vers contact@example.test pour la confirmation d’action externe. Après confirmation, envoie une seule fois et vérifie le messageId.';
    const result = runPreToolUseChecks({ toolName: 'mcp__google-contacts__gmail_send',
      input: { to: 'contact@example.test', subject: 'Fixture', body: 'Complete test content' },
      sessionId, permissionMode: 'allow-all', externalActionPolicy: 'allow-in-execute', humanInputAllowed: false,
      currentUserRequest: objective, objectiveAuthorizationSegments: [objective],
      objectiveMutationAuthorized: true, objectiveSensitiveActionAuthorized: true,
      workspaceRootPath: '/tmp/yolo-fixture', workspaceId: 'fixture',
      activeSourceSlugs: ['google-contacts'], allSourceSlugs: ['google-contacts'],
      hasSourceActivation: false, permissionManager: {} as never, prerequisiteManager: undefined });
    expect(result).toMatchObject({ type: 'block', reason: expect.stringContaining('No permission request was opened') });
  });

  it('updates volatile policy immediately without consuming mode state twice or rebuilding the stable prefix', () => {
    const id = 'yolo-prompt'; ids.push(id); initializeModeState(id, 'ask');
    const builder = new PromptBuilder({ workspace: { id: 'fixture', rootPath: '/tmp/yolo-fixture' },
      session: { id }, externalActionPolicy: 'allow-in-execute' } as never);
    const stable = builder.buildStableContextParts();
    expect(builder.buildVolatileContextParts({}).join('\n')).not.toContain('<yolo_execution_policy>');
    initializeModeState(id, 'allow-all');
    expect(builder.buildVolatileContextParts({}).join('\n')).toContain('<yolo_execution_policy>');
    expect(builder.buildStableContextParts()).toEqual(stable);
    builder.setExternalActionPolicy('confirm');
    expect(builder.buildVolatileContextParts({}).join('\n')).not.toContain('<yolo_execution_policy>');
  });
});
