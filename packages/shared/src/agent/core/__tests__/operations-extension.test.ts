import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cleanupModeState, initializeModeState } from '../../mode-manager.ts';
import {
  clearRobbOperationsExtension,
  registerRobbOperationsExtension,
  type OperationsToolDecision,
} from '../../../operations/index.ts';
import {
  runPreToolUseChecks,
  type PermissionManagerLike,
} from '../pre-tool-use.ts';

const sessions: string[] = [];
const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => true,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] ?? command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => true,
};

afterEach(async () => {
  for (const sessionId of sessions.splice(0)) cleanupModeState(sessionId);
  await clearRobbOperationsExtension();
});

function check(decision: OperationsToolDecision, permissionApprovalReentry = false) {
  const sessionId = `operations-pretool-${randomUUID()}`;
  sessions.push(sessionId);
  initializeModeState(sessionId, 'allow-all');
  registerRobbOperationsExtension({
    apiVersion: 1,
    id: 'operations-pretool-test',
    edition: 'commercial',
    beforeTurn: () => ({ decision: 'allow' }),
    beforeTool: () => decision,
    onRuntimeEvent: () => undefined,
  });
  return runPreToolUseChecks({
    toolName: 'Bash',
    input: { command: 'echo safe' },
    sessionId,
    permissionMode: 'allow-all',
    workspaceRootPath: '/tmp/robb-operations-test',
    workspaceId: 'operations-test',
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    permissionManager,
    permissionApprovalReentry,
  });
}

describe('commercial operations pre-tool seam', () => {
  it('blocks a tool before execution', () => {
    expect(check({ decision: 'block', reason: 'policy block' }))
      .toEqual({ type: 'block', reason: 'policy block' });
  });

  it('requires explicit confirmation even in execute mode', () => {
    expect(check({
      decision: 'require-approval',
      reason: 'confirm destructive operation',
      classification: 'destructive-mutation',
    })).toMatchObject({
      type: 'prompt',
      promptType: 'bash',
      description: 'confirm destructive operation',
      requiresExplicitConfirmation: true,
    });
  });

  it('accepts the same command after host-confirmed permission reentry', () => {
    expect(check({
      decision: 'require-approval',
      reason: 'confirm destructive operation',
    }, true).type).toBe('allow');
  });
});
