import { describe, expect, it } from "bun:test";
import type { Message, ObjectiveAcceptanceCriterion } from "@craft-agent/core/types";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { validateObjectiveOutcome } from "./objective-outcome.ts";
import { objectiveReviewBinding } from "./objective-contract.ts";
import { registerObjectiveAcceptanceCriteria } from "./objective-acceptance-criteria.ts";
import { messages, objective, receipt } from "./testing/objective-outcome-fixture.ts";

describe('objective outcome receipt', () => {

  it('keeps a PASS current across exact SSH reads, SSH history and internal delivery', () => {
    const remoteCriterion: ObjectiveAcceptanceCriterion = {
      id: 'remote-state',
      description: 'The exact remote deployment verifier passes',
      toolName: 'mcp__rbw-servers__ssh_execute',
      input: { server: 'dev', cwd: '/srv/app', command: './scripts/verify-deployment.sh --json' },
      checks: [{ path: 'ready', equals: true }],
    };
    const reviewedObjective = registerObjectiveAcceptanceCriteria({
      ...objective,
      risk: 'high-stakes',
      completionCriteria: [...objective.completionCriteria, 'independent-review-passed'],
    }, [remoteCriterion], 2);
    const remoteRead: Message = {
      id: 'remote-read-before-review', role: 'tool', content: '', timestamp: 3,
      toolName: remoteCriterion.toolName, toolUseId: 'remote-read-before-review',
      toolStatus: 'completed', toolExecuted: true,
      toolInput: structuredClone(remoteCriterion.input), toolResult: '{"ready":true}',
    };
    const review: Message = {
      id: 'independent-review', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__security__reviewer', toolUseId: 'independent-review',
      toolStatus: 'completed', toolExecuted: true,
      toolResult: JSON.stringify({
        ...objectiveReviewBinding(reviewedObjective),
        verdict: 'PASS',
        criteria: [
          ...reviewedObjective.completionCriteria.filter(id => id !== 'independent-review-passed'),
          remoteCriterion.id,
        ].map(id => ({ id, passed: true })),
        findings: [],
      }),
    };
    const latestRemoteRead: Message = {
      ...remoteRead,
      id: 'remote-read-after-review', toolUseId: 'remote-read-after-review', timestamp: 5,
    };
    const sshHistory: Message = {
      id: 'ssh-history', role: 'tool', content: '', timestamp: 6,
      toolName: 'mcp__rbw-servers__ssh_history', toolUseId: 'ssh-history',
      toolStatus: 'completed', toolExecuted: true, toolResult: '{"commands":[]}',
    };
    const delivery: Message = {
      id: 'delivery', role: 'tool', content: '', timestamp: 7,
      toolName: 'mcp__session__send_agent_message', toolUseId: 'delivery',
      toolStatus: 'completed', toolExecuted: true,
      toolInput: { sessionId: 'parent', message: 'PASS' }, toolResult: '{"status":"queued"}',
    };
    const declaration = receipt({ criteria: [
      { id: 'requested-outcome-delivered', satisfied: true, evidence: ['assistant-final'] },
      { id: 'relevant-checks-passed', satisfied: true, evidence: ['remote-read-after-review'] },
      { id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] },
      { id: 'independent-review-passed', satisfied: true, evidence: ['independent-review'] },
      { id: remoteCriterion.id, satisfied: true, evidence: ['remote-read-after-review'] },
    ] });
    expect(validateObjectiveOutcome(declaration, {
      objective: reviewedObjective,
      messages: [messages[0]!, remoteRead, review, latestRemoteRead, sshHistory, delivery],
    })).toMatchObject({ valid: true, state: 'complete_verified', gaps: [] });
  });

  it('accepts native Bash aliases only after the host observed matching check evidence', () => {
    const aliases = ['tool:Bash', 'tool:bash', 'tool:functions.bash'];
    for (const toolName of ['Bash', 'bash', 'functions.bash']) {
      const bashCheck: Message = {
        ...messages[2]!, id: `check-${toolName}`, toolUseId: `call-${toolName}`, toolName,
        toolInput: { command: 'cat /tmp/app.ts' }, toolResult: 'verified fixed content', timestamp: 4,
      };
      for (const evidence of aliases) {
        const declaration = receipt({ criteria: receipt().criteria.map(criterion => criterion.id === 'relevant-checks-passed'
          ? { ...criterion, evidence: [evidence] }
          : criterion) });
        expect(validateObjectiveOutcome(declaration, { objective, messages: [...messages, bashCheck] }).valid).toBe(true);
      }
      const unsupportedCase = receipt({ criteria: receipt().criteria.map(criterion => criterion.id === 'relevant-checks-passed'
        ? { ...criterion, evidence: ['tool:BASH'] }
        : criterion) });
      expect(validateObjectiveOutcome(unsupportedCase, { objective, messages: [...messages, bashCheck] }).valid).toBe(false);
    }
    const aliasOnly = receipt({ criteria: receipt().criteria.map(criterion => criterion.id === 'relevant-checks-passed'
      ? { ...criterion, evidence: ['tool:Bash'] }
      : criterion) });
    expect(validateObjectiveOutcome(aliasOnly, { objective, messages }).valid).toBe(false);
    expect(validateObjectiveOutcome(aliasOnly, { objective, messages: [...messages, {
      ...messages[2]!, id: 'foreign-bash', toolUseId: 'foreign-bash', toolName: 'mcp__other__bash', timestamp: 4,
    }] }).valid).toBe(false);
    const firstBash = { ...messages[2]!, id: 'bash-first', toolUseId: 'bash-first', toolName: 'Bash',
      toolInput: { command: 'cat /tmp/app.ts' }, timestamp: 4 };
    const secondBash = { ...firstBash, id: 'bash-second', toolUseId: 'bash-second', toolName: 'functions.bash', timestamp: 5 };
    expect(validateObjectiveOutcome(aliasOnly, { objective, messages: [...messages, firstBash, secondBash] }).valid).toBe(false);
    const concrete = receipt({ criteria: receipt().criteria.map(criterion => criterion.id === 'relevant-checks-passed'
      ? { ...criterion, evidence: ['bash-second'] }
      : criterion) });
    expect(validateObjectiveOutcome(concrete, { objective, messages: [...messages, firstBash, secondBash] }).valid).toBe(true);
  });

  it('keeps non-native tool aliases exact and rejects ambiguous aliases', () => {
    const connectorCheck: Message = {
      ...messages[2]!, id: 'connector-check', toolUseId: 'connector-call', timestamp: 4,
      toolName: 'mcp__ops__get_status', toolInput: { host: 'staging' }, toolResult: '{"ready":true}',
    };
    const aliasReceipt = receipt({ criteria: receipt().criteria.map(criterion => criterion.id === 'relevant-checks-passed'
      ? { ...criterion, evidence: ['tool:mcp__ops__get_status'] }
      : criterion) });
    expect(validateObjectiveOutcome(aliasReceipt, { objective, messages: [...messages, connectorCheck] }).valid).toBe(true);
    const wrongCase = receipt({ criteria: receipt().criteria.map(criterion => criterion.id === 'relevant-checks-passed'
      ? { ...criterion, evidence: ['tool:MCP__OPS__GET_STATUS'] }
      : criterion) });
    expect(validateObjectiveOutcome(wrongCase, { objective, messages: [...messages, connectorCheck] }).valid).toBe(false);
    const duplicate = { ...connectorCheck, id: 'connector-check-2', toolUseId: 'connector-call-2', timestamp: 5 };
    expect(validateObjectiveOutcome(aliasReceipt, { objective, messages: [...messages, connectorCheck, duplicate] }).valid).toBe(false);
    const concrete = receipt({ criteria: receipt().criteria.map(criterion => criterion.id === 'relevant-checks-passed'
      ? { ...criterion, evidence: ['connector-call-2'] }
      : criterion) });
    expect(validateObjectiveOutcome(concrete, { objective, messages: [...messages, connectorCheck, duplicate] }).valid).toBe(true);
  });

  it('scopes native Bash blocker aliases to a host-observed blocker of the declared type', () => {
    const failedBash: Message = {
      id: 'permission-error', role: 'tool', content: '', timestamp: 4,
      toolName: 'Bash', toolUseId: 'permission-call', toolStatus: 'error', toolExecuted: true,
      isError: true, toolInput: { command: 'cat /restricted/state' }, toolResult: 'Permission denied',
    };
    for (const toolName of ['Bash', 'bash', 'functions.bash']) {
      for (const evidence of ['tool:Bash', 'tool:bash', 'tool:functions.bash']) {
        const blocked = receipt({
          state: 'blocked_human', criteria: [], remainingWork: ['Obtenir l’autorisation externe'],
          blocker: { kind: 'external_authorization', description: 'Autorisation requise', evidence: [evidence] },
        });
        expect(validateObjectiveOutcome(blocked, {
          objective, messages: [...messages, { ...failedBash, toolName }],
        }).state).toBe('blocked_human');
        expect(validateObjectiveOutcome(blocked, { objective, messages }).state).toBe('continue');
      }
    }
    const wrongKind = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Fournir un identifiant'],
      blocker: { kind: 'credential', description: 'Identifiant requis', evidence: ['tool:Bash'] },
    });
    expect(validateObjectiveOutcome(wrongKind, { objective, messages: [...messages, failedBash] }).state).toBe('continue');
    expect(validateObjectiveOutcome(wrongKind, { objective, messages: [...messages, {
      ...failedBash, isError: false, toolStatus: 'completed', toolResult: 'verified fixed content',
    }] }).state).toBe('continue');
    const blockedAlias = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Obtenir l’autorisation externe'],
      blocker: { kind: 'external_authorization', description: 'Autorisation requise', evidence: ['tool:Bash'] },
    });
    const secondFailure = { ...failedBash, id: 'permission-error-2', toolUseId: 'permission-call-2',
      toolName: 'functions.bash', timestamp: 5 };
    expect(validateObjectiveOutcome(blockedAlias, {
      objective, messages: [...messages, failedBash, secondFailure],
    }).state).toBe('continue');
    const blockedConcrete = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Obtenir l’autorisation externe'],
      blocker: { kind: 'external_authorization', description: 'Autorisation requise', evidence: ['permission-call-2'] },
    });
    expect(validateObjectiveOutcome(blockedConcrete, {
      objective, messages: [...messages, failedBash, secondFailure],
    }).state).toBe('blocked_human');

    const connectorFailure = { ...failedBash, id: 'connector-denied', toolUseId: 'connector-denied-call',
      toolName: 'mcp__ops__graph_request' };
    const connectorBlocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Obtenir l’autorisation externe'],
      blocker: { kind: 'external_authorization', description: 'Autorisation requise', evidence: ['tool:mcp__ops__graph_request'] },
    });
    expect(validateObjectiveOutcome(connectorBlocked, {
      objective, messages: [...messages, connectorFailure],
    }).state).toBe('blocked_human');
    const connectorWrongCase = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Obtenir l’autorisation externe'],
      blocker: { kind: 'external_authorization', description: 'Autorisation requise', evidence: ['tool:MCP__OPS__GRAPH_REQUEST'] },
    });
    expect(validateObjectiveOutcome(connectorWrongCase, {
      objective, messages: [...messages, connectorFailure],
    }).state).toBe('continue');
    const duplicateConnectorFailure = { ...connectorFailure, id: 'connector-denied-2',
      toolUseId: 'connector-denied-call-2', timestamp: 5 };
    expect(validateObjectiveOutcome(connectorBlocked, {
      objective, messages: [...messages, connectorFailure, duplicateConnectorFailure],
    }).state).toBe('continue');
    const connectorConcrete = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Obtenir l’autorisation externe'],
      blocker: { kind: 'external_authorization', description: 'Autorisation requise', evidence: ['connector-denied-call-2'] },
    });
    expect(validateObjectiveOutcome(connectorConcrete, {
      objective, messages: [...messages, connectorFailure, duplicateConnectorFailure],
    }).state).toBe('blocked_human');
  });

  it('retires a credential blocker only after the same tool request succeeds', () => {
    const credentialFailure: Message = {
      id: 'credential-error', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__crm__get_account', toolUseId: 'credential-call', toolStatus: 'error',
      toolExecuted: true, isError: true,
      toolInput: { account: 'primary', request: { fields: ['status', 'owner'], includeDisabled: false } },
      toolResult: 'Unauthorized: API key missing',
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Provide the CRM credential'],
      blocker: { kind: 'credential', description: 'CRM credential required', evidence: ['credential-call'] },
    });
    const otherTargetSuccess: Message = {
      ...credentialFailure, id: 'other-success', toolUseId: 'other-call', timestamp: 5,
      toolStatus: 'completed', isError: false,
      toolInput: { account: 'secondary', request: { fields: ['status', 'owner'], includeDisabled: false } },
      toolResult: '{"status":"ready"}',
    };
    expect(validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, credentialFailure, otherTargetSuccess],
    }).state).toBe('blocked_human');

    const sameRequestSuccess: Message = {
      ...otherTargetSuccess, id: 'resolved-success', toolUseId: 'resolved-call', timestamp: 6,
      // Reordered object keys remain the same persisted request.
      toolInput: { request: { includeDisabled: false, fields: ['status', 'owner'] }, account: 'primary' },
    };
    const resolved = validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, credentialFailure, otherTargetSuccess, sameRequestSuccess],
    });
    expect(resolved.state).toBe('continue');
    expect(resolved.gaps).toContain('blocker evidence does not reference a matching host-observed blocker');
  });

  it('requires a fresh blocker observation after a real user relaunch', () => {
    const denied: Message = {
      id: 'stale-policy-denial', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__ops__ssh_execute', toolUseId: 'stale-policy-call', toolStatus: 'error',
      toolExecuted: true, isError: true, toolInput: { server: 'dev', command: 'git status --short' },
      toolResult: 'MCP write operations are blocked in Explore. Switch to Ask or Allow All mode.',
    };
    const blocked = receipt({
      state: 'blocked_policy', criteria: [], remainingWork: ['Inspecter de nouveau puis poursuivre'],
      blocker: { kind: 'policy', description: 'Le contrôle a refusé la lecture distante',
        evidence: ['stale-policy-call'] },
    });
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, denied] }).state)
      .toBe('blocked_policy');

    const relaunch: Message = {
      id: 'real-user-relaunch', role: 'user', timestamp: 5,
      content: 'Reprends maintenant et lève les blocages récupérables.',
    };
    const stale = validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, denied, relaunch],
    });
    expect(stale.state).toBe('continue');
    expect(stale.gaps).toContain('blocker evidence does not reference a matching host-observed blocker');

    const hiddenRecovery: Message = {
      ...relaunch, id: 'hidden-recovery', hidden: true,
      content: '<automatic_turn_recovery attempt="1">Continue.</automatic_turn_recovery>',
    };
    expect(validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, denied, hiddenRecovery],
    }).state).toBe('blocked_policy');

    const freshDenial: Message = {
      ...denied, id: 'fresh-policy-denial', toolUseId: 'fresh-policy-call', timestamp: 6,
    };
    const refreshedBlocked = receipt({
      ...blocked,
      blocker: {
        kind: 'policy',
        description: 'Le contrôle a refusé la lecture distante',
        evidence: ['fresh-policy-call'],
      },
    });
    expect(validateObjectiveOutcome(refreshedBlocked, {
      objective, messages: [...messages, denied, relaunch, freshDenial],
    }).state).toBe('blocked_policy');
  });

  it('binds exact negative Gmail evidence to the current external wait (pure-boulder regression)', () => {
    const agirisObjective: ActiveSessionObjective = {
      ...objective,
      originalText: 'On attend surtout que laurent@example.test réponde sur les questions des API et ouvre les accès.',
    };
    const sentRequest: Message = {
      id: 'agiris-request', role: 'tool', content: '', timestamp: 3.5,
      toolName: 'mcp__google-contacts__gmail_send', toolUseId: 'agiris-request-call',
      toolStatus: 'completed', toolExecuted: true, isError: false,
      toolInput: {
        to: 'laurent@example.test',
        subject: 'RE: Compte-rendu de l’échange du 25/08 - Example Org',
        body: 'Merci de confirmer la procédure d’ouverture et les prérequis des accès.',
      },
      toolResult: '{"id":"sent-agiris","labelIds":["SENT"]}',
    };
    const noReply: Message = {
      id: 'gmail-no-reply', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__google-contacts__gmail_search_exact', toolUseId: 'gmail-no-reply-call',
      toolStatus: 'completed', toolExecuted: true, isError: false,
      toolInput: {
        query: 'from:(laurent@example.test) subject:(Compte-rendu de l’échange du 25/08 - Example Org) after:2026/09/15',
        maxResults: 5,
      },
      toolResult: 'Aucun message Gmail trouvé pour : « from:(laurent@example.test) subject:(Compte-rendu de l’échange du 25/08 - Example Org) after:2026/09/15 »',
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Attendre la réponse d’AGIRIS'],
      blocker: { kind: 'external_authorization', description: 'La réponse externe est toujours attendue',
        evidence: ['gmail-no-reply-call'] },
    });
    expect(validateObjectiveOutcome(blocked, {
      objective: agirisObjective, messages: [...messages, sentRequest, noReply],
    })).toEqual({ state: 'blocked_human', valid: true, gaps: [] });

    const directlyBound = {
      ...noReply,
      id: 'gmail-direct-no-reply',
      toolUseId: 'gmail-direct-no-reply-call',
      toolInput: { query: 'from:agiris@example.com newer_than:7d', maxResults: 5 },
      toolResult: 'Aucun message Gmail trouvé pour : « from:agiris@example.com newer_than:7d »',
    };
    expect(validateObjectiveOutcome(receipt({
      ...blocked,
      blocker: { kind: 'external_authorization', description: 'La réponse externe est toujours attendue',
        evidence: ['gmail-direct-no-reply-call'] },
    }), { objective: agirisObjective, messages: [...messages, directlyBound] }).state).toBe('blocked_human');

    for (const candidate of [
      { ...noReply, toolName: 'mcp__other__gmail_search_exact' },
      { ...noReply, toolResult: 'Aucun message Gmail trouvé.' },
      { ...noReply, toolResult: `${noReply.toolResult}\nRéessayez plus tard.` },
      { ...noReply, toolInput: { query: 'from:other@example.com newer_than:7d', maxResults: 5 } },
      { ...noReply, toolResult: '**Recherche Gmail API : « from:agiris@example.com newer_than:7d »**\n_0 message(s) retourné(s) ; lire le message exact avant toute action._' },
    ]) {
      const validation = validateObjectiveOutcome(blocked, {
        objective: agirisObjective, messages: [...messages, sentRequest, candidate],
      });
      expect(validation.state).toBe('continue');
      expect(validation.gaps).toContain(
        'blocker evidence does not reference a matching host-observed blocker',
      );
    }

    const unrelatedObjective: ActiveSessionObjective = {
      ...objective,
      originalText: 'Attendre la réponse de GuardTek sur la clé Analytics.',
    };
    expect(validateObjectiveOutcome(blocked, {
      objective: unrelatedObjective, messages: [...messages, sentRequest, noReply],
    }).state).toBe('continue');

    const genericOverlapObjective: ActiveSessionObjective = {
      ...objective,
      originalText: 'Attendre la réponse de GuardTek au sujet de la production.',
    };
    const wrongProductionSender = {
      ...noReply,
      id: 'gmail-wrong-production-sender',
      toolUseId: 'gmail-wrong-production-sender-call',
      toolInput: { query: 'from:other@example.com subject:production', maxResults: 5 },
      toolResult: 'Aucun message Gmail trouvé pour : « from:other@example.com subject:production »',
    };
    expect(validateObjectiveOutcome(receipt({
      ...blocked,
      blocker: { kind: 'external_authorization', description: 'La réponse externe est toujours attendue',
        evidence: ['gmail-wrong-production-sender-call'] },
    }), { objective: genericOverlapObjective, messages: [...messages, wrongProductionSender] }).state).toBe('continue');

    const invoiceOverlapObjective: ActiveSessionObjective = {
      ...objective,
      originalText: 'Attendre la réponse de GuardTek au sujet de la facture de septembre.',
    };
    const wrongInvoiceSender = {
      ...wrongProductionSender,
      id: 'gmail-wrong-invoice-sender',
      toolUseId: 'gmail-wrong-invoice-sender-call',
      toolInput: { query: 'from:other@example.com subject:facture', maxResults: 5 },
      toolResult: 'Aucun message Gmail trouvé pour : « from:other@example.com subject:facture »',
    };
    expect(validateObjectiveOutcome(receipt({
      ...blocked,
      blocker: { kind: 'external_authorization', description: 'La réponse externe est toujours attendue',
        evidence: ['gmail-wrong-invoice-sender-call'] },
    }), { objective: invoiceOverlapObjective, messages: [...messages, wrongInvoiceSender] }).state).toBe('continue');

    const replyFound: Message = {
      ...noReply, id: 'gmail-reply-found', toolUseId: 'gmail-reply-found-call', timestamp: 5,
      toolResult: '**Recherche Gmail API : « from:agiris@example.com newer_than:7d »**\n_1 message(s) retourné(s) ; lire le message exact avant toute action._',
    };
    expect(validateObjectiveOutcome(blocked, {
      objective: agirisObjective, messages: [...messages, sentRequest, noReply, replyFound],
    }).state).toBe('continue');
  });

  it('accepts connector machine-code evidence for a missing API key', () => {
    const missingKey: Message = {
      id: 'guardtek-key-missing', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__atria__atria_guardtek_visits', toolUseId: 'guardtek-key-call',
      toolStatus: 'error', toolExecuted: true, isError: true,
      toolInput: { startDate: '2026-09-01', endDate: '2026-09-15' },
      toolResult: '{"ok":false,"error":"guardtek_analytics_api_key_missing"}',
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: ['Configurer la clé GuardTek Analytics'],
      blocker: { kind: 'credential', description: 'Clé GuardTek Analytics requise',
        evidence: ['guardtek-key-call'] },
    });
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, missingKey] }).state)
      .toBe('blocked_human');
  });
});
