import { afterEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { looksLikePowerShell } from '../powershell-validator/command-syntax.ts';
import { resolveParserScriptPath } from '../powershell-validator/parser-process.ts';
import { setPowerShellValidatorRoot } from '../powershell-validator.ts';
import { ClaudeAgent } from '../claude-agent.ts';
import { createClaudeBackendConfig } from '../claude-agent/shared.ts';
import { blockWithReason, cleanupModeState, initializeModeState } from '../mode-manager.ts';
import { admitToolExecution, beginAdmittedToolExecutionBySignature } from '../base-agent/admission.ts';
import {
  clearRobbOperationsExtension,
  registerRobbOperationsExtension,
} from '../../operations/index.ts';
import {
  runPreToolUseChecks,
  type PermissionManagerLike,
} from '../core/pre-tool-use.ts';

const sessions: string[] = [];
const agents: ClaudeAgent[] = [];
const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => true,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/u)[0] ?? command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => true,
};

afterEach(async () => {
  for (const agent of agents.splice(0)) agent.dispose();
  for (const id of sessions.splice(0)) cleanupModeState(id);
  await clearRobbOperationsExtension();
});

describe('morning structural fixes (2026-10-29)', () => {
  it('preserves YOLO, objective authority, OAuth authType, and durability callbacks in createClaudeBackendConfig', () => {
    const getHumanInputAllowed = () => false;
    const getObjectiveMutationAuthority = () => ({
      authorized: undefined,
      sensitiveActionAuthorized: undefined,
      authorizationSegments: ['inspecte dev'],
    });
    const beforeToolExecution = async () => undefined;

    const backendConfig = createClaudeBackendConfig({
      workspace: { id: 'ws-1', slug: 'ws-1', name: 'WS', rootPath: '/tmp/ws-1', createdAt: 1 },
      externalActionPolicy: 'allow-in-execute',
      getHumanInputAllowed,
      getObjectiveMutationAuthority,
      beforeToolExecution,
      authType: 'oauth',
    }, 'claude-opus-5');

    expect(backendConfig.provider).toBe('anthropic');
    expect(backendConfig.model).toBe('claude-opus-5');
    expect(backendConfig.externalActionPolicy).toBe('allow-in-execute');
    expect(backendConfig.getHumanInputAllowed).toBe(getHumanInputAllowed);
    expect(backendConfig.getObjectiveMutationAuthority).toBe(getObjectiveMutationAuthority);
    expect(backendConfig.beforeToolExecution).toBe(beforeToolExecution);
    expect(backendConfig.authType).toBe('oauth');

    const sessionId = `yolo-ssh-${randomUUID()}`;
    sessions.push(sessionId);
    initializeModeState(sessionId, 'allow-all');
    const authority = backendConfig.getObjectiveMutationAuthority?.('inspecte dev');
    const authObj = typeof authority === 'object' && authority !== null ? authority : undefined;

    const check = runPreToolUseChecks({
      toolName: 'mcp__rbw-servers__ssh_execute',
      input: { server: 'dev', command: 'hostname && git status --short' },
      sessionId,
      permissionMode: 'allow-all',
      ...(backendConfig.externalActionPolicy !== undefined
        ? { externalActionPolicy: backendConfig.externalActionPolicy }
        : {}),
      humanInputAllowed: backendConfig.getHumanInputAllowed?.(),
      objectiveMutationAuthorized: authObj?.authorized,
      ...(authObj?.authorizationSegments !== undefined
        ? { objectiveAuthorizationSegments: authObj.authorizationSegments }
        : {}),
      workspaceRootPath: '/tmp/ws-1',
      workspaceId: 'ws-1',
      activeSourceSlugs: ['rbw-servers'],
      allSourceSlugs: ['rbw-servers'],
      hasSourceActivation: true,
      permissionManager,
    });
    expect(check.type).toBe('allow');
  });

  it('omits continue:false on recoverable blockWithReason so Claude SDK streams do not abort mid-turn', () => {
    const blocked = blockWithReason('recoverable tool refusal');
    expect(blocked).toEqual({
      continue: true,
      decision: 'block',
      reason: '[ERROR] recoverable tool refusal',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: '[ERROR] recoverable tool refusal',
      },
    });
    expect(blocked.continue).toBe(true);
  });

  it('bypasses false-positive Robb Operations shell preflight blocks on POSIX reserved keywords while keeping real binary blocks', () => {
    const sessionId = `ops-kw-${randomUUID()}`;
    sessions.push(sessionId);
    initializeModeState(sessionId, 'allow-all');

    let preflightReason = 'Shell preflight: executable "for" was not found on PATH.';
    registerRobbOperationsExtension({
      apiVersion: 1,
      id: 'ops-shell-kw-test',
      edition: 'commercial',
      beforeTurn: () => ({ decision: 'allow' }),
      beforeTool: () => ({ decision: 'block', reason: preflightReason, classification: 'command-not-found' }),
      onRuntimeEvent: () => undefined,
    });

    const keywordRes = runPreToolUseChecks({
      toolName: 'Bash',
      input: { command: 'for f in a b; do echo "$f"; done' },
      sessionId,
      permissionMode: 'allow-all',
      workspaceRootPath: '/tmp/ws-1',
      workspaceId: 'ws-1',
      activeSourceSlugs: [],
      allSourceSlugs: [],
      hasSourceActivation: false,
      permissionManager,
    });
    expect(keywordRes.type).toBe('allow');

    preflightReason = 'Shell preflight: executable "nonexistent_binary_xyz" was not found on PATH.';
    const missingBinRes = runPreToolUseChecks({
      toolName: 'Bash',
      input: { command: 'nonexistent_binary_xyz --flag' },
      sessionId,
      permissionMode: 'allow-all',
      workspaceRootPath: '/tmp/ws-1',
      workspaceId: 'ws-1',
      activeSourceSlugs: [],
      allSourceSlugs: [],
      hasSourceActivation: false,
      permissionManager,
    });
    expect(missingBinRes).toEqual({
      type: 'block',
      reason: 'Shell preflight: executable "nonexistent_binary_xyz" was not found on PATH.',
    });
  });

  it('matches PreToolUse admission signature with Zod-defaulted in-process MCP arguments on request_user_input', () => {
    const agent = new ClaudeAgent({
      workspace: { id: 'ws-1', slug: 'ws-1', name: 'WS', rootPath: '/tmp/ws-1', createdAt: 1 },
      skipConfigWatcher: true,
    });
    agents.push(agent);

    const rawPreToolInput: Record<string, unknown> = {
      _intent: 'Clarify target branch',
      questions: [
        {
          id: 'branch_choice',
          question: 'Which branch should we target?',
          options: [
            { id: 'main', label: 'main' },
            { id: 'release', label: 'release' },
          ],
        },
      ],
    };
    const admitted = admitToolExecution(agent, {
      toolUseId: 'toolu_req_1',
      toolName: 'mcp__session__request_user_input',
      toolInput: rawPreToolInput,
      sessionId: 'sess-1',
      runtimeId: 'rt-1',
      authorizationEpoch: 1,
    });
    expect(admitted).toBe(true);

    const zodParsedCallbackArgs: Record<string, unknown> = {
      questions: [
        {
          id: 'branch_choice',
          question: 'Which branch should we target?',
          options: [
            { id: 'main', label: 'main' },
            { id: 'release', label: 'release' },
          ],
          multiSelect: false,
        },
      ],
    };
    const claimedId = beginAdmittedToolExecutionBySignature(agent, {
      toolName: 'mcp__session__request_user_input',
      toolInput: zodParsedCallbackArgs,
      sessionId: 'sess-1',
      runtimeId: 'rt-1',
      authorizationEpoch: 1,
    });
    expect(claimedId).toBe('toolu_req_1');
  });

  it('avoids false positives and requires an initialized parser root', () => {
    expect(looksLikePowerShell('touch /fixture/new-target')).toBe(false);
    expect(looksLikePowerShell('git push --set-upstream origin main')).toBe(false);
    expect(looksLikePowerShell('cat ./get-status.json')).toBe(false);
    expect(looksLikePowerShell('git remote get-url origin')).toBe(false);
    expect(looksLikePowerShell('rg "get-url" packages/')).toBe(false);
    expect(looksLikePowerShell('Get-Process')).toBe(true);
    expect(looksLikePowerShell('powershell.exe -Command "Set-Content -Path foo"')).toBe(true);

    expect(() => resolveParserScriptPath()).toThrow('PowerShell validator root not set');

    const parserRoot = resolve(import.meta.dir, '..');
    setPowerShellValidatorRoot(parserRoot);
    const parserScript = resolveParserScriptPath();
    expect(parserScript).toBe(resolve(parserRoot, 'powershell-parser.ps1'));
    expect(existsSync(parserScript)).toBe(true);
  });
});
