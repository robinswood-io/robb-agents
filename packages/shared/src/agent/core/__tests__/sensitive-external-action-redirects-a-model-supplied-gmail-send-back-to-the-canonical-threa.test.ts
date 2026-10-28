import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { cleanupModeState, initializeModeState, type PermissionMode } from "../../mode-manager.ts";
import { clearContextualGmailPreflightAttestation, runPreToolUseChecks } from "../pre-tool-use.ts";
import { whitelistedPermissionManager } from "./testing/sensitive-external-action-fixture.ts";

const usedSessionIds: string[] = [];
const temporaryPaths: string[] = [];
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

  it('redirects a model-supplied Gmail send back to the canonical thread reply', () => {
    const messageId = '1a0aaa36e2769235';
    const result = checkMcp(
      'allow-all', 'mcp__google-contacts__gmail_send', {
        to: 'laurent@example.test',
        cc: 'marie@example.test, andre@example.test',
        subject: 'RE: API AGIRIS — ouverture des accès et conditions',
        body: 'Nous attendons l’ouverture de la clé API.',
      }, 'Poursuis.', {
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [
          `Envoie-la exactement une fois dans le fil existant ancré sur ${messageId}, sans modifier les destinataires.`,
          'Poursuis.',
        ],
      },
    );
    expect(result).toMatchObject({ type: 'block' });
    if (result.type === 'block') {
      expect(result.reason).toContain('contextual reply-all preserving the thread recipients');
      expect(result.reason).toContain('mcp__google-contacts__gmail_reply_all');
      expect(result.reason).toContain('Do not ask for broader permission');
    }

    const objectiveOptions = {
      externalActionPolicy: 'allow-in-execute' as const,
      objectiveMutationAuthorized: true,
      objectiveSensitiveActionAuthorized: true,
      objectiveAuthorizationSegments: [
        `Réponds à tous au message ${messageId} dans le fil existant.`,
        'Poursuis.',
      ],
    };
    expect(checkMcp(
      'allow-all',
      'mcp__session__browser_tool',
      { command: 'click @gmail-send-button' },
      'Poursuis.',
      objectiveOptions,
    )).toMatchObject({
      type: 'block',
      reason: (expect.stringContaining('cannot be used as a fallback') as unknown),
    });
    expect(checkMcp(
      'allow-all',
      'mcp__session__browser_tool',
      { command: 'click @send-button' },
      'Poursuis.',
      objectiveOptions,
    ).type).not.toBe('block');
    expect(checkMcp(
      'allow-all',
      'mcp__session__browser_tool',
      { command: 'snapshot' },
      'Poursuis.',
      objectiveOptions,
    ).type).not.toBe('block');

    for (const unrelatedBrowserScenario of [
      {
        segments: [
          `Réponds à tous au message ${messageId} dans le fil existant.`,
          'Annule finalement cette réponse Gmail. Mets à jour le formulaire web demandé.',
        ],
        command: 'click @save-button',
      },
      {
        segments: [
          `Réponds à tous au message ${messageId}, puis remplis le formulaire RH.`,
        ],
        command: 'fill @employee-name Alice',
      },
      {
        segments: [
          `Prépare un brouillon de réponse au message ${messageId}, puis publie la fiche CMS.`,
        ],
        command: 'click @publish-button',
      },
    ]) {
      expect(checkMcp(
        'allow-all',
        'mcp__session__browser_tool',
        { command: unrelatedBrowserScenario.command },
        unrelatedBrowserScenario.segments.at(-1),
        {
          externalActionPolicy: 'allow-in-execute',
          objectiveMutationAuthorized: true,
          objectiveSensitiveActionAuthorized: true,
          objectiveAuthorizationSegments: unrelatedBrowserScenario.segments,
        },
      ).type).not.toBe('block');
    }
  });

  it('does not let a signed reply-all capability retarget a contextual instruction', () => {
    const instructedMessageId = '1a0aaa36e2769235';
    const selectedMessageId = '1a0a9568009889f8';
    const result = checkMcp(
      'allow-all',
      'mcp__google-contacts__gmail_reply_all',
      {
        messageId: selectedMessageId,
        body: 'Message',
        recipientBinding: `v1.1789601856.${'a'.repeat(64)}`,
      },
      'Poursuis.',
      {
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [
          `Réponds à tous dans le fil ancré sur ${instructedMessageId}.`,
          'Poursuis.',
        ],
      },
    );
    expect(result).toMatchObject({
      type: 'block',
      reason: (expect.stringContaining('does not bind that authorization to this exact messageId') as unknown),
    });

    const ambiguous = checkMcp(
      'allow-all',
      'mcp__google-contacts__gmail_reply_all',
      {
        messageId: selectedMessageId,
        body: 'Message',
        recipientBinding: `v1.1789601856.${'a'.repeat(64)}`,
      },
      'Poursuis.',
      {
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: [
          `Compare ${instructedMessageId} et ${selectedMessageId}, puis réponds à tous dans le fil.`,
          'Poursuis.',
        ],
      },
    );
    expect(ambiguous).toMatchObject({
      type: 'block',
      reason: (expect.stringContaining('does not bind this contextual Gmail reply to one exact messageId') as unknown),
    });

    const bodyReference = `Référence ${selectedMessageId}`;
    const quotedReferenceObjective = [
      `Réponds à tous au message ${instructedMessageId} avec le texte exact « ${bodyReference} ».`,
      'Poursuis.',
    ];
    expect(checkMcp(
      'allow-all',
      'mcp__google-contacts__gmail_reply_all',
      {
        messageId: instructedMessageId,
        body: bodyReference,
        recipientBinding: `v1.1789601856.${'a'.repeat(64)}`,
      },
      'Poursuis.',
      {
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: quotedReferenceObjective,
      },
    ).type).toBe('allow');
    expect(checkMcp(
      'allow-all',
      'mcp__google-contacts__gmail_reply_all',
      {
        messageId: selectedMessageId,
        body: bodyReference,
        recipientBinding: `v1.1789601856.${'a'.repeat(64)}`,
      },
      'Poursuis.',
      {
        externalActionPolicy: 'allow-in-execute',
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        objectiveAuthorizationSegments: quotedReferenceObjective,
      },
    )).toMatchObject({
      type: 'block',
      reason: (expect.stringContaining('does not bind that authorization to this exact messageId') as unknown),
    });
  });
});
