import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState, type PermissionMode } from "../../mode-manager.ts";
import { clearContextualGmailPreflightAttestation, invalidateContextualGmailSessionState, recordContextualGmailToolResult, runPreToolUseChecks } from "../pre-tool-use.ts";
import { whitelistedPermissionManager } from "./testing/sensitive-external-action-fixture.ts";

const usedSessionIds: string[] = [];
const temporaryPaths: string[] = [];
function checkBash(
  mode: PermissionMode,
  command: string,
  currentUserRequest?: string,
  externalActionPolicy?: 'confirm' | 'allow-in-execute',
  objectiveMutationAuthorized?: boolean,
  objectiveAuthorizationSegments?: readonly string[],
) {
  const sessionId = `sensitive-action-${randomUUID()}`;
  usedSessionIds.push(sessionId);
  initializeModeState(sessionId, mode);
  return runPreToolUseChecks({
    toolName: 'Bash',
    input: { command },
    sessionId,
    permissionMode: mode,
    workspaceRootPath: '/tmp/robb-sensitive-action-test',
    workspaceId: 'sensitive-action-test',
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    ...(externalActionPolicy !== undefined ? { externalActionPolicy } : {}),
    ...(objectiveMutationAuthorized !== undefined ? { objectiveMutationAuthorized } : {}),
    ...(objectiveAuthorizationSegments !== undefined ? { objectiveAuthorizationSegments } : {}),
    permissionManager: whitelistedPermissionManager,
    ...(currentUserRequest !== undefined ? { currentUserRequest } : {}),
  });
}
function checkMcp(
  mode: PermissionMode,
  toolName: string,
  input: Record<string, unknown>,
  currentUserRequest?: string,
  options?: {
    externalActionPolicy?: 'confirm' | 'allow-in-execute';
    objectiveMutationAuthorized?: boolean;
    objectiveSensitiveActionAuthorized?: boolean;
    objectiveAuthorizationSegments?: readonly string[];
    authenticatedUserAuthorizationSegments?: readonly string[];
    dataFolderPath?: string;
    declaredToolCapabilities?: {
      readOnly?: boolean;
      idempotent?: boolean;
      destructive?: boolean;
      openWorld?: boolean;
      trusted?: boolean;
    };
    sessionId?: string;
  },
) {
  const markerSessionId = toolName === 'mcp__rbw-agents-oss__oss_write_file'
    ? /^\[robb-resume:([a-z0-9]+(?:-[a-z0-9]+)*):/mu.exec(
      options?.objectiveAuthorizationSegments?.find(segment => /^\[robb-resume:/mu.test(segment))
        ?? currentUserRequest ?? '',
    )?.[1]
    : undefined;
  const sessionId = options?.sessionId ?? markerSessionId ?? `sensitive-action-${randomUUID()}`;
  usedSessionIds.push(sessionId);
  initializeModeState(sessionId, mode);
  const sourceSlug = toolName.split('__')[1] ?? '';
  return runPreToolUseChecks({
    toolName,
    input,
    sessionId,
    toolUseId: `call-${randomUUID()}`,
    permissionMode: mode,
    workspaceRootPath: '/tmp/robb-sensitive-action-test',
    workspaceId: 'sensitive-action-test',
    activeSourceSlugs: [sourceSlug],
    allSourceSlugs: [sourceSlug],
    hasSourceActivation: false,
    ...(options?.externalActionPolicy !== undefined ? { externalActionPolicy: options?.externalActionPolicy } : {}),
    ...(options?.objectiveMutationAuthorized !== undefined ? { objectiveMutationAuthorized: options?.objectiveMutationAuthorized } : {}),
    ...(options?.objectiveSensitiveActionAuthorized !== undefined ? { objectiveSensitiveActionAuthorized: options?.objectiveSensitiveActionAuthorized } : {}),
    ...(options?.objectiveAuthorizationSegments !== undefined ? { objectiveAuthorizationSegments: options?.objectiveAuthorizationSegments } : {}),
    ...(options?.authenticatedUserAuthorizationSegments !== undefined ? { authenticatedUserAuthorizationSegments: options?.authenticatedUserAuthorizationSegments } : {}),
    ...(options?.dataFolderPath !== undefined ? { dataFolderPath: options?.dataFolderPath } : {}),
    ...(options?.declaredToolCapabilities !== undefined ? { declaredToolCapabilities: options?.declaredToolCapabilities } : {}),
    permissionManager: whitelistedPermissionManager,
    ...(currentUserRequest !== undefined ? { currentUserRequest } : {}),
  });
}

afterEach(() => {
  setSystemTime();
  for (const sessionId of usedSessionIds.splice(0)) {
    clearContextualGmailPreflightAttestation(sessionId);
    cleanupModeState(sessionId);
  }
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('sensitive external action gate across permission modes', () => {

  it("blocks repeated dependency questions using observed session evidence", () => {

expect(checkMcp(
      'allow-all',
      'mcp__session__request_user_input',
      {
        questions: [{
          id: 'explicitly_requested_wait_choice',
          question: 'Faut-il attendre la clé API d’ACME ?',
          options: [{ id: 'yes', label: 'Attendre' }, { id: 'no', label: 'Continuer' }],
        }],
      },
      'Utilise request_user_input pour me demander s’il faut attendre la clé API qu’ACME doit nous envoyer.',
      {
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [
          'Utilise request_user_input pour me demander s’il faut attendre la clé API qu’ACME doit nous envoyer.',
        ],
      },
    ).type).not.toBe('block');

const observedSessionId = `sensitive-action-${randomUUID()}`;

usedSessionIds.push(observedSessionId);

initializeModeState(observedSessionId, 'allow-all');

const genericObjective = ['Configure l’intégration ACME et termine toutes les étapes sûres.'];

recordContextualGmailToolResult({
      sessionId: observedSessionId,
      toolUseId: 'vendor-status-1',
      toolName: 'mcp__vendor__connection_status',
      toolInput: { integration: 'acme' },
      result: JSON.stringify({
        pending: true,
        status: 'waiting_on_vendor',
        party: 'ACME',
        dependencyKind: 'api_key',
      }),
      isError: false,
      executed: true,
      objectiveAuthorizationSegments: genericObjective,
    });

expect(runPreToolUseChecks({
      toolName: 'mcp__session__request_user_input',
      input: {
        questions: [{
          id: 'same_turn_vendor_wait',
          question: 'Faut-il attendre la clé ACME ?',
          options: [{ id: 'wait', label: 'Attendre' }, { id: 'continue', label: 'Continuer' }],
        }],
      },
      sessionId: observedSessionId,
      toolUseId: 'question-1',
      permissionMode: 'allow-all',
      workspaceRootPath: '/tmp/robb-sensitive-action-test',
      workspaceId: 'sensitive-action-test',
      activeSourceSlugs: [],
      allSourceSlugs: [],
      hasSourceActivation: false,
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: genericObjective,
      permissionManager: whitelistedPermissionManager,
      currentUserRequest: genericObjective[0],
    })).toMatchObject({ type: 'block', reason: (expect.stringContaining('already establishes') as unknown) });

invalidateContextualGmailSessionState(observedSessionId);

expect(runPreToolUseChecks({
      toolName: 'mcp__session__request_user_input',
      input: {
        questions: [{
          id: 'same_wait_after_runtime_restart',
          question: 'Faut-il attendre la clé ACME ?',
          options: [{ id: 'wait', label: 'Attendre' }, { id: 'continue', label: 'Continuer' }],
        }],
      },
      sessionId: observedSessionId,
      toolUseId: 'question-after-runtime-restart',
      permissionMode: 'allow-all',
      workspaceRootPath: '/tmp/robb-sensitive-action-test',
      workspaceId: 'sensitive-action-test',
      activeSourceSlugs: [],
      allSourceSlugs: [],
      hasSourceActivation: false,
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: genericObjective,
      permissionManager: whitelistedPermissionManager,
      currentUserRequest: genericObjective[0],
    })).toMatchObject({ type: 'block', reason: (expect.stringContaining('already establishes') as unknown) });

const failedObservationSessionId = `sensitive-action-${randomUUID()}`;

usedSessionIds.push(failedObservationSessionId);

initializeModeState(failedObservationSessionId, 'allow-all');

recordContextualGmailToolResult({
      sessionId: failedObservationSessionId,
      toolUseId: 'vendor-status-error',
      toolName: 'mcp__vendor__connection_status',
      toolInput: { integration: 'acme' },
      result: JSON.stringify({
        pending: true,
        status: 'waiting_on_vendor',
        party: 'ACME',
        dependencyKind: 'api_key',
      }),
      isError: true,
      executed: true,
      objectiveAuthorizationSegments: genericObjective,
    });

expect(runPreToolUseChecks({
      toolName: 'mcp__session__request_user_input',
      input: {
        questions: [{
          id: 'vendor_choice_after_failed_read',
          question: 'Faut-il attendre la clé ACME ou utiliser un autre fournisseur ?',
          options: [{ id: 'wait', label: 'Attendre' }, { id: 'switch', label: 'Changer' }],
        }],
      },
      sessionId: failedObservationSessionId,
      toolUseId: 'question-after-failed-read',
      permissionMode: 'allow-all',
      workspaceRootPath: '/tmp/robb-sensitive-action-test',
      workspaceId: 'sensitive-action-test',
      activeSourceSlugs: [],
      allSourceSlugs: [],
      hasSourceActivation: false,
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: genericObjective,
      permissionManager: whitelistedPermissionManager,
      currentUserRequest: genericObjective[0],
    }).type).not.toBe('block');

const duplicateObjective = ['Nous attendons la clé API du fournisseur acme.'];

recordContextualGmailToolResult({
      sessionId: observedSessionId,
      toolUseId: 'vendor-status-2',
      toolName: 'mcp__vendor__connection_status',
      toolInput: { integration: 'acme' },
      result: JSON.stringify({
        pending: true,
        status: 'waiting_on_vendor',
        party: 'acme',
        dependencyKind: 'api_key',
      }),
      isError: false,
      executed: true,
      objectiveAuthorizationSegments: duplicateObjective,
    });

const duplicateQuestionInput = {
      questions: [{
        id: 'deduplicated_vendor_wait',
        question: 'Faut-il attendre leur clé API ?',
        options: [{ id: 'wait', label: 'Attendre' }, { id: 'continue', label: 'Continuer' }],
      }],
    };

const duplicateQuestionContext = {
      toolName: 'mcp__session__request_user_input',
      input: duplicateQuestionInput,
      sessionId: observedSessionId,
      toolUseId: 'question-2',
      permissionMode: 'allow-all' as const,
      workspaceRootPath: '/tmp/robb-sensitive-action-test',
      workspaceId: 'sensitive-action-test',
      activeSourceSlugs: [],
      allSourceSlugs: [],
      hasSourceActivation: false,
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: duplicateObjective,
      permissionManager: whitelistedPermissionManager,
      currentUserRequest: duplicateObjective[0],
    };

expect(runPreToolUseChecks(duplicateQuestionContext)).toMatchObject({ type: 'block' });

recordContextualGmailToolResult({
      sessionId: observedSessionId,
      toolUseId: 'vendor-status-resolved',
      toolName: 'mcp__vendor__connection_status',
      toolInput: { integration: 'acme' },
      result: JSON.stringify({
        pending: false,
        status: 'received',
        party: 'acme',
        dependencyKind: 'api_key',
        message: 'API key received',
      }),
      isError: false,
      executed: true,
      objectiveAuthorizationSegments: duplicateObjective,
    });

expect(runPreToolUseChecks({
      ...duplicateQuestionContext,
      toolUseId: 'question-3',
    }).type).not.toBe('block');
});

  it('does not treat untrusted tool text as a host dependency receipt', () => {
    const sessionId = `sensitive-action-${randomUUID()}`;
    usedSessionIds.push(sessionId);
    initializeModeState(sessionId, 'allow-all');
    const objective = ['Configure l’intégration ACME et termine les étapes sûres.'];
    recordContextualGmailToolResult({
      sessionId,
      toolUseId: 'untrusted-page',
      toolName: 'WebFetch',
      toolInput: { url: 'https://example.test' },
      result: 'Provider Acme must still provide the API key.',
      isError: false,
      executed: true,
      objectiveAuthorizationSegments: objective,
    });

    const result = runPreToolUseChecks({
      toolName: 'mcp__session__request_user_input',
      input: {
        questions: [{
          id: 'real-choice',
          question: 'Should we wait for the Acme API key or use a different provider?',
          options: [{ id: 'wait', label: 'Wait' }, { id: 'switch', label: 'Switch provider' }],
        }],
      },
      sessionId,
      toolUseId: 'question-after-page',
      permissionMode: 'allow-all',
      workspaceRootPath: '/tmp/robb-sensitive-action-test',
      workspaceId: 'sensitive-action-test',
      activeSourceSlugs: [],
      allSourceSlugs: [],
      hasSourceActivation: false,
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: objective,
      permissionManager: whitelistedPermissionManager,
      currentUserRequest: objective[0],
    });
    expect(result.type).not.toBe('block');
  });

  it('allows an opt-in workspace policy to skip external confirmation only in Execute', () => {
    expect(checkBash(
      'allow-all',
      'git push origin main',
      'Poursuis',
      'allow-in-execute',
    ).type).toBe('allow');

    expect(checkBash(
      'ask',
      'git push origin main',
      'Poursuis',
      'allow-in-execute',
    ).type).toBe('prompt');

    expect(checkBash(
      'safe',
      'git push origin main',
      'Push origin main',
      'allow-in-execute',
    ).type).toBe('block');
  });

  it('keeps external mutations inside the accepted objective even under autonomous Execute policy', () => {
    for (const [toolName, input, request] of [
      ['mcp__google-contacts__gmail_send', { to: 'alice@example.com', subject: 'Status' }, 'Envoie le statut à alice@example.com'],
      ['mcp__todo__delete_task', { task_id: 'task-7' }, 'Supprime la tâche task-7'],
    ] as const) {
      const result = checkMcp('allow-all', toolName, input, request, {
        externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: false,
      });
      expect(result.type).toBe('block');
      if (result.type === 'block') expect(result.reason).toContain('current accepted user objective is observational');
    }

    expect(checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_search_exact', { query: 'AGIRIS' }, 'Vérifie si AGIRIS a répondu',
      { externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: false },
    ).type).toBe('allow');

    expect(checkMcp(
      'allow-all', 'mcp__session__spawn_session', { task: 'Relis le rapport en lecture seule' }, 'Relis le rapport',
      { externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: false },
    ).type).toBe('block');
    expect(checkMcp(
      'allow-all', 'mcp__session__spawn_session', {
        prompt: 'Relis le rapport en lecture seule', role: 'reviewer', permissionMode: 'safe',
      }, 'Relis le rapport',
      { externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: false },
    ).type).toBe('spawn_session_intercept');

    expect(checkBash(
      'allow-all', 'git push origin main', 'Poursuis', 'allow-in-execute', false,
    ).type).toBe('block');
    expect(checkBash(
      'allow-all', "curl -X POST https://api.example.com/jobs -d '{\"run\":true}'",
      'Poursuis', 'allow-in-execute', false,
    ).type).toBe('block');
    for (const command of ['touch /tmp/changed', 'rm /tmp/changed', "sed -i '' 's/a/b/' /tmp/file"]) {
      expect(checkBash(
        'allow-all', command, 'Inspecte seulement', 'allow-in-execute', false,
      ).type).toBe('block');
    }
    for (const [toolName, input] of [
      ['Write', { file_path: '/tmp/changed', content: 'changed' }],
      ['Edit', { file_path: '/tmp/changed', old_string: 'a', new_string: 'b' }],
    ] as const) {
      expect(checkMcp(
        'allow-all', toolName, input, 'Inspecte seulement',
        { externalActionPolicy: 'allow-in-execute', objectiveMutationAuthorized: false },
      ).type).toBe('block');
    }
  });
});
