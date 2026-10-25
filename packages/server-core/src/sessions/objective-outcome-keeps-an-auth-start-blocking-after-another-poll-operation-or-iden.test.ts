import { describe, expect, it } from "bun:test";
import type { Message } from "@craft-agent/core/types";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { extractObjectiveOutcome, validateObjectiveOutcome } from "./objective-outcome.ts";
import { activeAuthorizationExpiry, messages, objective, receipt } from "./testing/objective-outcome-fixture.ts";

describe('objective outcome receipt', () => {

  it('keeps an auth start blocking after another poll operation or identity succeeds', () => {
    const startedAt = Date.now();
    const started: Message = {
      id: 'bound-device-start', role: 'tool', content: '', timestamp: startedAt,
      toolName: 'mcp__identity__device_code_start', toolUseId: 'bound-device-start-call',
      toolStatus: 'completed', toolExecuted: true, isError: false,
      toolResult: JSON.stringify({
        ok: true,
        request_id: 'auth-request-1',
        verification_uri: 'https://login.microsoft.com/device',
        user_code: 'D949VGHX3',
        expires_at: activeAuthorizationExpiry(startedAt),
        poll_after_human_login_with: 'device_code_poll',
      }),
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Complete Microsoft device login',
        evidence: ['bound-device-start-call'] },
    });
    const wrongOperation: Message = {
      id: 'other-auth-poll', role: 'tool', content: '', timestamp: startedAt + 1,
      toolName: 'mcp__identity__oauth_status_check', toolUseId: 'other-auth-poll-call',
      toolStatus: 'completed', toolExecuted: true, isError: false,
      toolInput: { requestId: 'auth-request-1' }, toolResult: JSON.stringify({ ok: true, pending: false }),
    };
    const wrongIdentity: Message = {
      ...wrongOperation, id: 'wrong-device-poll', toolUseId: 'wrong-device-poll-call', timestamp: startedAt + 2,
      toolName: 'mcp__identity__device_code_poll', toolInput: { requestId: 'auth-request-2' },
    };
    const crossDomainIdentity: Message = {
      ...wrongIdentity, id: 'cross-domain-device-poll', toolUseId: 'cross-domain-device-poll-call',
      toolInput: { connectionId: 'auth-request-1' },
    };
    const invalidReceipts = [
      { ok: true, pending: true },
      {},
      { ok: true, pending: false, status: 'pending' },
      { status: 'authorized', state: 'pending' },
      { pending: false, error: { code: 'authorization_pending' } },
      { pending: false, error: 'authorization failed' },
      { pending: false, error: ' '.repeat(4_097) },
      { pending: false, status: 'a'.repeat(65) },
      { pending: false, state: { name: 'authorized' } },
      { pending: false, requestId: 'auth-request-2' },
      { pending: false, requestId: 'auth-request-1', request_id: 'auth-request-2' },
      { pending: false, requestId: 'auth-request-1', authRequestId: 'auth-request-2' },
      { pending: false, requestId: 'x'.repeat(513) },
    ];
    const invalidPolls = invalidReceipts.map((toolResult, index): Message => ({
      ...wrongIdentity,
      id: `invalid-device-poll-${index}`,
      toolUseId: `invalid-device-poll-call-${index}`,
      timestamp: startedAt + 3 + index,
      toolInput: { requestId: 'auth-request-1' },
      toolResult: JSON.stringify(toolResult),
    }));
    for (const candidate of [wrongOperation, wrongIdentity, crossDomainIdentity, ...invalidPolls]) {
      expect(validateObjectiveOutcome(blocked, {
        objective, messages: [...messages, started, candidate],
      }).state).toBe('blocked_human');
    }
    expect(validateObjectiveOutcome(blocked, {
      objective,
      messages: [...messages, started, {
        ...wrongIdentity,
        id: 'conflicting-host-auth-request',
        toolUseId: 'conflicting-host-auth-request-call',
        toolInput: { requestId: 'auth-request-1' },
        authRequestId: 'auth-request-2',
        toolResult: JSON.stringify({ pending: false }),
      }],
    }).state).toBe('blocked_human');
  });

  it('retires an auth-start blocker when its strict receipt expires', () => {
    const startedAt = Date.now();
    const expired: Message = {
      id: 'expired-device-start', role: 'tool', content: '', timestamp: startedAt,
      toolName: 'mcp__identity__device_code_start', toolUseId: 'expired-device-start-call',
      toolStatus: 'completed', toolExecuted: true, isError: false,
      toolResult: JSON.stringify({
        ok: true,
        requestId: 'expired-auth-request',
        verification_uri: 'https://login.microsoft.com/device',
        user_code: 'D949VGHX3',
        expiresAt: '2000-01-01T00:00:00.000Z',
        pollAfterHumanLoginWith: 'device_code_poll',
      }),
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Complete Microsoft device login',
        evidence: ['expired-device-start-call'] },
    });
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, expired] }).state)
      .toBe('continue');
  });

  it('accepts a known identity-provider password challenge but not a custom application login', () => {
    const loginPage: Message = {
      id: 'login-page', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__session__browser_tool', toolUseId: 'login-page-call',
      toolStatus: 'completed', toolExecuted: true, isError: false, toolInput: { action: 'snapshot' },
      toolResult: 'URL: https://login.microsoftonline.com/oauth2/authorize\n@e38 [textbox] "Entrer le mot de passe"',
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'credential', description: 'The login page requires a password', evidence: ['login-page-call'] },
    });
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, loginPage] }).state)
      .toBe('blocked_human');

    const customApplicationLogin: Message = {
      ...loginPage,
      id: 'zero-login-page',
      toolUseId: 'zero-login-page-call',
      toolResult: 'URL: https://zero.example.test/login\nTitle: Stack Zero - Application Démo\n'
        + '@e9 [textbox] "Email"\n@e10 [textbox] "Mot de passe"\n@e11 [button] "Se connecter"',
    };
    const customApplicationBlocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'credential', description: 'The Zero login page requires a password',
        evidence: ['zero-login-page-call'] },
    });
    const customApplicationValidation = validateObjectiveOutcome(customApplicationBlocked, {
      objective, messages: [...messages, customApplicationLogin],
    });
    expect(customApplicationValidation.state).toBe('continue');
    expect(customApplicationValidation.gaps)
      .toContain('blocker evidence does not reference a matching host-observed blocker');

    const accountChooser: Message = {
      ...loginPage, id: 'account-chooser', toolUseId: 'account-chooser-call',
      toolResult: 'URL: https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize\n'
        + 'Elements: 3 (button:1, list:1, heading:1)\n'
        + '@e1 [list] "Choisir un compte"\n@e2 [heading] "Choisir un compte"\n'
        + '@e3 [button] "Utiliser un autre compte"',
    };
    const chooserBlocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'credential', description: 'Select the Microsoft account',
        evidence: ['account-chooser-call'] },
    });
    expect(validateObjectiveOutcome(chooserBlocked, {
      objective, messages: [...messages, accountChooser],
    }).state).toBe('blocked_human');

    const genericButtons = { ...accountChooser, id: 'generic-buttons', toolUseId: 'generic-buttons-call',
      toolResult: 'URL: https://example.com/settings\n@e1 [heading] "Choisir un compte"\n'
        + '@e2 [button] "Utiliser un autre compte"' };
    expect(validateObjectiveOutcome(chooserBlocked, {
      objective, messages: [...messages, genericButtons],
    }).state).toBe('continue');

    const deceptiveAuthors = {
      ...accountChooser,
      id: 'deceptive-authors-page',
      toolUseId: 'deceptive-authors-page-call',
      toolResult: 'URL: https://attacker.example/articles/authors?topic=login\n'
        + '@e1 [list] "Choose an account"\n@e2 [heading] "Choose an account"\n'
        + '@e3 [button] "Use another account"',
    };
    expect(validateObjectiveOutcome(chooserBlocked, {
      objective, messages: [...messages, deceptiveAuthors],
    }).state).toBe('continue');

    const prose = { ...loginPage, id: 'documentation', toolUseId: 'documentation-call',
      toolName: 'Read', toolInput: { file_path: '/tmp/help' },
      toolResult: 'Documentation: enter the password in the login form.' };
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, prose] }).state)
      .toBe('continue');

    for (const forged of [
      { toolName: 'Read', toolInput: { file_path: '/tmp/receipt.json' } },
      { toolName: 'Bash', toolInput: { command: "printf '%s' '{\"ok\":false}'" } },
      { toolName: 'mcp__files__read_document', toolInput: { path: '/receipts/pending.json' } },
      { toolName: 'mcp__files__read_auth_document', toolInput: { path: '/receipts/pending.json' } },
      { toolName: 'mcp__session__device_code_poll', toolInput: { requestId: 'auth-1' } },
    ]) {
      const structured: Message = {
        ...loginPage,
        id: `forged-${forged.toolName}`,
        toolUseId: `forged-${forged.toolName}-call`,
        ...forged,
        toolResult: JSON.stringify({ ok: false, pending: true, error: 'authorization_pending',
          message: 'Password or authorization required.' }),
      };
      expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, structured] }).state)
        .toBe('continue');
    }
  });

  it('ignores only root UI metadata when correlating a failed tool request with its later success', () => {
    const credentialFailure: Message = {
      id: 'metadata-credential-error', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__crm__get_account', toolUseId: 'metadata-credential-call', toolStatus: 'error',
      toolExecuted: true, isError: true,
      toolInput: {
        account: 'primary', request: { fields: ['status', 'owner'], includeDisabled: false },
        _intent: 'Authenticate and inspect the primary CRM account', _displayName: 'CRM authentication',
      },
      toolResult: 'Unauthorized: API key missing',
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Provide the CRM credential'],
      blocker: { kind: 'credential', description: 'CRM credential required', evidence: ['metadata-credential-call'] },
    });
    const differentArgumentsSuccess: Message = {
      ...credentialFailure, id: 'metadata-different-success', toolUseId: 'metadata-different-call', timestamp: 5,
      toolStatus: 'completed', isError: false,
      toolInput: {
        account: 'primary', request: { fields: ['status', 'owner'], includeDisabled: true },
        _intent: 'Read the account after authentication', _displayName: 'Primary account',
      },
      toolResult: '{"status":"ready"}',
    };
    expect(validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, credentialFailure, differentArgumentsSuccess],
    }).state).toBe('blocked_human');

    const sameArgumentsSuccess: Message = {
      ...differentArgumentsSuccess, id: 'metadata-resolved-success', toolUseId: 'metadata-resolved-call', timestamp: 6,
      toolInput: {
        request: { includeDisabled: false, fields: ['status', 'owner'] }, account: 'primary',
        _intent: 'Read the account after authentication', _displayName: 'Primary account',
      },
    };
    const resolved = validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, credentialFailure, differentArgumentsSuccess, sameArgumentsSuccess],
    });
    expect(resolved.state).toBe('continue');
    expect(resolved.gaps).toContain('blocker evidence does not reference a matching host-observed blocker');
  });

  it('retires a pending auth blocker only after the same auth request is completed', () => {
    const pending: Message = {
      id: 'auth-pending', role: 'auth-request', content: 'OAuth login required', timestamp: 4,
      authRequestId: 'oauth-primary', authStatus: 'pending',
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Complete the OAuth login'],
      blocker: { kind: 'credential', description: 'OAuth login required', evidence: ['oauth-primary'] },
    });
    const otherCompleted = { ...pending, id: 'other-auth', timestamp: 5,
      authRequestId: 'oauth-secondary', authStatus: 'completed' as const };
    expect(validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, pending, otherCompleted],
    }).state).toBe('blocked_human');
    const completed = { ...pending, id: 'auth-completed', timestamp: 6, authStatus: 'completed' as const };
    expect(validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, pending, otherCompleted, completed],
    }).state).toBe('continue');
  });

  it('never accepts target-free autonomy escalation IDs as terminal tool/auth blocker proof', () => {
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Provide the CRM credential'],
      blocker: { kind: 'credential', description: 'CRM credential required', evidence: ['stale-escalation'] },
    });
    const autonomyEvents = [
      { id: 'stale-escalation', timestamp: 4, phase: 'escalated' as const,
        toolName: 'mcp__crm__get_account', escalationReason: 'credential_required' as const,
        message: 'Human credential input is required.' },
      { id: 'later-success', timestamp: 6, phase: 'verified' as const,
        toolName: 'mcp__crm__get_account', message: 'Tool completed successfully.' },
    ];
    const validation = validateObjectiveOutcome(blocked, { objective, messages, autonomyEvents });
    expect(validation.state).toBe('continue');
    expect(validation.gaps).toContain('blocker evidence does not reference a matching host-observed blocker');
  });

  it('keeps a current host business decision event only until the next real user turn', () => {
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Choose the rollout region'],
      blocker: { kind: 'business_decision', description: 'Rollout region required', evidence: ['decision-needed'] },
    });
    const autonomyEvents = [{
      id: 'decision-needed', timestamp: 4, phase: 'escalated' as const,
      escalationReason: 'business_decision_required' as const, message: 'Business decision required.',
    }];
    expect(validateObjectiveOutcome(blocked, { objective, messages, autonomyEvents }).state).toBe('blocked_human');
    const answered: Message = { id: 'decision-answer', role: 'user', content: 'Use eu-west.', timestamp: 5 };
    expect(validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, answered], autonomyEvents,
    }).state).toBe('continue');
  });

  it('requires an observed blocker receipt and never accepts policy as a human blocker', () => {
    const blockedMessages: Message[] = [...messages, {
      id: 'auth-1',
      role: 'auth-request',
      content: 'OAuth requires MFA.',
      timestamp: 3,
      authRequestId: 'request-1',
      authRequestType: 'oauth',
      authStatus: 'pending',
    }];
    const blocked = extractObjectiveOutcome(
      `MFA requis.\n<!-- robb_objective_outcome ${JSON.stringify(receipt({
        state: 'blocked_human',
        criteria: [],
        remainingWork: ['Terminer après MFA'],
        blocker: { kind: 'mfa', description: 'Code MFA requis', evidence: ['request-1'] },
      }))} -->`,
    ).declaration;
    expect(validateObjectiveOutcome(blocked, { objective, messages: blockedMessages }).state).toBe('blocked_human');
    if (blocked?.blocker) blocked.blocker.kind = 'policy';
    expect(validateObjectiveOutcome(blocked, { objective, messages: blockedMessages }).state).toBe('continue');
  });

  it('accepts an exact read-only preflight authority handoff without bypassing safe work or mutations', () => {
    const rootText = 'Déploie Zero sur le serveur de staging puis vérifie le service.';
    const restriction = 'Effectue uniquement le préflight en lecture seule. N’effectue aucune mutation distante et ne déploie rien.';
    const restrictedObjective: ActiveSessionObjective = {
      ...objective,
      originalText: rootText,
      lastUserMessageId: 'read-only-boundary',
      requiresExecutionEvidence: true,
      requiresAcceptanceCriteria: true,
      acceptanceCriteria: [{
        id: 'zero-preflight', description: 'Zero staging preflight is reachable',
        toolName: 'mcp__rbw-servers__get_status', input: { server: 'zero' },
        checks: [{ path: '$.reachable', equals: true }],
      }],
      amendments: [{ messageId: 'read-only-boundary', text: restriction, timestamp: 4 }],
    };
    const root: Message = { id: 'u1', role: 'user', content: rootText, timestamp: 1 };
    const boundary: Message = {
      id: 'read-only-boundary', role: 'user', content: restriction, timestamp: 4,
    };
    const preflight: Message = {
      id: 'zero-preflight-result', role: 'tool', content: '', timestamp: 5,
      toolName: 'mcp__rbw-servers__get_status', toolUseId: 'zero-preflight-call',
      toolStatus: 'completed', toolExecuted: true, isError: false,
      toolInput: { server: 'zero' }, toolResult: '{"reachable":true}',
    };
    const authorityBlocker = {
      kind: 'external_authorization' as const,
      description: 'Le déploiement reste hors autorité', evidence: ['read-only-boundary'],
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [],
      remainingWork: ['Déployer Zero sur staging uniquement après une autorisation explicite'],
      blocker: authorityBlocker,
    });
    expect(validateObjectiveOutcome(blocked, {
      objective: restrictedObjective,
      messages: [root, boundary, preflight],
      executionEvidenceMissing: true,
    })).toEqual({ state: 'blocked_human', valid: true, gaps: [] });

    const expectRejected = (candidate: Parameters<typeof validateObjectiveOutcome>[0], candidateMessages: Message[],
      candidateObjective = restrictedObjective) => {
      const validation = validateObjectiveOutcome(candidate, {
        objective: candidateObjective, messages: candidateMessages, executionEvidenceMissing: true,
      });
      expect(validation.state).toBe('continue');
      expect(validation.gaps).toContain('blocker evidence does not reference a matching host-observed blocker');
    };
    expectRejected(blocked, [root, boundary]);
    expectRejected({ ...blocked, remainingWork: ['Vérifier encore le statut distant'] }, [root, boundary, preflight]);
    expectRejected({ ...blocked, remainingWork: ['Redémarrer le service après autorisation explicite'] }, [root, boundary, preflight]);
    expectRejected({ ...blocked, remainingWork: ['Déployer Orion sur staging après autorisation explicite'] }, [root, boundary, preflight]);
    expectRejected({ ...blocked, remainingWork: ['Déployer l’application Orion sur staging après autorisation explicite'] }, [root, boundary, preflight]);
    expectRejected({ ...blocked, remainingWork: ['Déployer Zero en production après autorisation explicite'] }, [root, boundary, preflight]);
    expectRejected({ ...blocked, remainingWork: ['Déployer prod après autorisation explicite'] }, [root, boundary, preflight]);
    expectRejected({ ...blocked, blocker: { ...authorityBlocker, evidence: ['u1'] } }, [root, boundary, preflight]);
    expectRejected({ ...blocked, blocker: { ...authorityBlocker, kind: 'irreversible_authority' } }, [root, boundary, preflight]);
    expectRejected(blocked, [boundary, preflight], {
      ...restrictedObjective,
      userMessageId: boundary.id,
      originalText: restriction,
      lastUserMessageId: boundary.id,
      requiresExecutionEvidence: false,
      amendments: undefined,
    });
    const priorMutation: Message = {
      id: 'authorized-mutation', role: 'tool', content: '', timestamp: 3,
      toolName: 'Write', toolUseId: 'authorized-mutation-call', toolStatus: 'completed', toolExecuted: true,
      toolInput: { file_path: '/srv/zero/config.json', content: '{}' }, toolResult: 'updated',
    };
    expect(validateObjectiveOutcome(blocked, {
      objective: restrictedObjective, messages: [root, priorMutation, boundary, preflight],
      executionEvidenceMissing: false,
    })).toEqual({ state: 'blocked_human', valid: true, gaps: [] });
    expectRejected(blocked, [root, boundary, { ...priorMutation, timestamp: 4.5 }, preflight]);
    expectRejected(blocked, [root, boundary, { ...preflight, toolInput: { server: 'other' } }]);
    expectRejected(blocked, [root, boundary, preflight], {
      ...restrictedObjective, acceptanceCriteria: undefined, requiresAcceptanceCriteria: undefined,
    });
  });

  it('never accepts the user objective itself as blocker evidence', () => {
    const blocked = extractObjectiveOutcome(
      `Blocage.\n<!-- robb_objective_outcome ${JSON.stringify(receipt({
        state: 'blocked_human',
        criteria: [],
        remainingWork: ['Attendre'],
        blocker: { kind: 'credential', description: 'Identifiant requis', evidence: ['u1'] },
      }))} -->`,
    ).declaration;
    const validation = validateObjectiveOutcome(blocked, { objective, messages });
    expect(validation.state).toBe('continue');
    expect(validation.gaps).toContain(
      'blocker evidence does not reference a matching host-observed blocker',
    );
  });
});
