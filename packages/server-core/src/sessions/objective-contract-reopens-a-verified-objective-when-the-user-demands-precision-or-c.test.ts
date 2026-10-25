import { describe, expect, it } from "bun:test";
import type { Message } from "@craft-agent/core/types";
import { findObjectiveText, hasObjectiveExecutionEvidence, hasObjectiveSubstantiveToolResult, isObjectiveEvidenceInvalidatingMutation, isObjectiveMutationTool, transitionObjectiveContract, turnProgressFingerprint, turnProgressFingerprints } from "./objective-contract.ts";

describe('durable objective contract', () => {
  it('reopens a verified objective when the user demands precision or challenges completeness', () => {
    const originalText = "J'ai besoin que tu envoi un email a Gary derrivière avec l'ensemble des accès à ses sites, ses hébergements, éventuellement stripe etc pour qu'il puisse migrer son site";
    const root = {
      ...transitionObjectiveContract({
        messageId: 'bmb-root',
        text: originalText,
        lifetimeCostUsd: 15,
        lifetimeTokens: 10_000,
        nowMs: 1,
      }),
      terminalState: 'complete_verified' as const,
      completedAt: 2,
      acceptanceCriteria: [{
        id: 'delivery_receipt',
        description: 'Email envoyé présent dans Envoyés',
        toolName: 'mcp__gmail__search_emails',
        input: { query: 'in:sent' },
        checks: [{ path: 'resultCount', equals: 1 }],
      }],
      acceptanceRegisteredAt: 2,
    };

    for (const [index, challenge] of [
      'Avec précision',
      'Sois plus précis',
      'C’est incomplet, il manque les accès hébergement',
      'Il manque les identifiants',
    ].entries()) {
      const next = transitionObjectiveContract({
        existing: root,
        messageId: `precision-turn-${index}`,
        text: challenge,
        lifetimeCostUsd: 45,
        lifetimeTokens: 35_000,
        nowMs: 10 + index,
      });

      expect(next).toMatchObject({
        objectiveId: 'bmb-root',
        userMessageId: 'bmb-root',
        lastUserMessageId: `precision-turn-${index}`,
        originalText,
        terminalState: 'active',
        acceptanceNeedsReview: true,
        acceptanceRevision: `precision-turn-${index}`,
      });
      expect(next.completedAt).toBeUndefined();
      expect(next.lastOutcome).toBeUndefined();
      expect(next.continuationCount).toBe(1);
      expect(next.amendments).toContainEqual({
        messageId: `precision-turn-${index}`,
        text: challenge,
        timestamp: 10 + index,
      });
    }
  });

  it('keeps the incomplete Wild Orion root for "Résout" but never revives a verified objective from it', () => {
    const originalText = 'Reprends et termine la mission Orion sur le serveur dev dans /srv/workspace/orion. Répare uniquement orion-agent-bridge, puis vérifie l\'API des comptes, la révision et bun run test:orion-production.';
    const root = transitionObjectiveContract({
      messageId: 'wild-orion-root', text: originalText,
      lifetimeCostUsd: 31, lifetimeTokens: 8_400, nowMs: 1,
    });

    for (const terminalState of ['exhausted', 'blocked_human', 'blocked_policy'] as const) {
      const incomplete = {
        ...root,
        terminalState,
        completedAt: 2,
      };
      const continued = transitionObjectiveContract({
        existing: incomplete,
        messageId: `wild-resolve-${terminalState}`,
        text: 'Résout',
        lifetimeCostUsd: 90,
        lifetimeTokens: 50_000,
        nowMs: 3,
      });

      expect(continued).toMatchObject({
        objectiveId: 'wild-orion-root',
        userMessageId: 'wild-orion-root',
        lastUserMessageId: `wild-resolve-${terminalState}`,
        originalText,
        terminalState: 'active',
        budgetBaselineUsd: 31,
        tokenBaseline: 8_400,
        continuationCount: 1,
      });
      expect(continued.amendments).toEqual([{
        messageId: `wild-resolve-${terminalState}`,
        text: 'Résout',
        timestamp: 3,
      }]);
      expect(continued.completedAt).toBeUndefined();
    }

    const verified = transitionObjectiveContract({
      existing: { ...root, terminalState: 'complete_verified', completedAt: 2 },
      messageId: 'post-completion-resolve',
      text: 'Résout',
      lifetimeCostUsd: 90,
      lifetimeTokens: 50_000,
      nowMs: 3,
    });
    expect(verified).toMatchObject({
      objectiveId: 'post-completion-resolve',
      userMessageId: 'post-completion-resolve',
      lastUserMessageId: 'post-completion-resolve',
      originalText: 'Résout',
      terminalState: 'active',
      budgetBaselineUsd: 90,
      tokenBaseline: 50_000,
      continuationCount: 0,
    });
    expect(verified.amendments).toBeUndefined();
  });

  it('separates internal report delivery from target mutation and objective progress', () => {
    const root: Message = { id: 'root', role: 'user', content: 'Vérifie le service', timestamp: 1 };
    const originalProgress = turnProgressFingerprints([root], 'root');
    for (const toolName of ['send_agent_message', 'session__send_agent_message', 'mcp__session__send_agent_message']) {
      const handoff: Message = { id: 'handoff', role: 'tool', content: '', timestamp: 2,
        toolName, toolInput: { sessionId: 'parent', message: 'Vérification réussie' },
        toolStatus: 'completed', toolExecuted: true, toolResult: '{"status":"queued"}' };
      expect(isObjectiveMutationTool(handoff)).toBe(true);
      expect(isObjectiveEvidenceInvalidatingMutation(handoff)).toBe(false);
      expect(hasObjectiveSubstantiveToolResult(handoff)).toBe(false);
      expect(hasObjectiveExecutionEvidence([root, handoff], 'root')).toBe(false);
      expect(turnProgressFingerprints([root, handoff], 'root')).toEqual(originalProgress);
      expect(isObjectiveEvidenceInvalidatingMutation({ ...handoff, toolName: 'mcp__crm__send_agent_message' })).toBe(true);
    }
  });

  it('does not count asking the user as verified progress or execution evidence', () => {
    const root: Message = { id: 'root', role: 'user', content: 'Prépare le document', timestamp: 1 };
    const originalProgress = turnProgressFingerprints([root], 'root');
    for (const toolName of ['request_user_input', 'session__request_user_input', 'mcp__session__request_user_input']) {
      const question: Message = { id: 'question', role: 'tool', content: '', timestamp: 2,
        toolName, toolInput: { questions: [{ id: 'format', question: 'Quel format ?' }] },
        toolStatus: 'completed', toolExecuted: true, toolResult: '{"status":"pending","requestId":"question-1"}' };
      expect(isObjectiveEvidenceInvalidatingMutation(question)).toBe(false);
      expect(hasObjectiveSubstantiveToolResult(question)).toBe(false);
      expect(hasObjectiveExecutionEvidence([root, question], 'root')).toBe(false);
      expect(turnProgressFingerprints([root, question], 'root')).toEqual(originalProgress);
    }
  });

  it('keeps namespaced shell writes classified as mutations', () => {
    const invocation: Message = { id: 'shell', role: 'tool', content: '', timestamp: 1,
      toolName: 'functions.bash', toolInput: { command: 'touch /tmp/report.pdf' },
      toolStatus: 'completed', toolExecuted: true, toolResult: '{"exit_code":0}' };
    expect(isObjectiveMutationTool(invocation)).toBe(true);
    expect(isObjectiveEvidenceInvalidatingMutation(invocation)).toBe(true);
    expect(isObjectiveMutationTool({ ...invocation, toolInput: { command: 'cat /tmp/report.pdf' } })).toBe(false);
  });

  it('does not reactivate a terminal objective for a standalone deictic sentence', () => {
    const completed = {
      ...transitionObjectiveContract({ messageId: 'u1', text: 'Corrige le rapport.' }),
      terminalState: 'complete_verified' as const,
    };
    const next = transitionObjectiveContract({
      existing: completed,
      messageId: 'u2',
      text: 'Ce document doit respecter la nouvelle charte graphique.',
      lifetimeCostUsd: 5,
    });
    expect(next.userMessageId).toBe('u2');
    expect(next.objectiveId).toBe('u2');
  });

  it('references the original transcript objective and advances only on successful tool evidence', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Objectif source', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'Je vais le faire', timestamp: 2 },
      { id: 't1', role: 'tool', content: '', timestamp: 3, toolName: 'Read', toolUseId: 'call-1', toolStatus: 'completed' },
    ];
    const objective = transitionObjectiveContract({ messageId: 'u1', text: 'Objectif source' });
    expect(findObjectiveText(messages, objective)).toBe('Objectif source');
    const first = turnProgressFingerprint(messages, 'u1');
    messages.push({ id: 'a2', role: 'assistant', content: 'Encore du texte', timestamp: 4 });
    expect(turnProgressFingerprint(messages, 'u1')).toBe(first);
    messages.push({ id: 't2', role: 'tool', content: '', timestamp: 5, toolName: 'Bash', toolUseId: 'call-2', toolStatus: 'completed' });
    expect(turnProgressFingerprint(messages, 'u1')).not.toBe(first);
  });

  it('requires mutation evidence rather than accepting a read as implementation', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Corrige', timestamp: 1 },
      { id: 'read', role: 'tool', content: '', timestamp: 2, toolName: 'Read', toolUseId: 'r1', toolStatus: 'completed' },
    ];
    expect(hasObjectiveExecutionEvidence(messages, 'u1')).toBe(false);
    messages.push({
      id: 'edit', role: 'tool', content: '', timestamp: 3, toolName: 'Edit', toolUseId: 'e1', toolStatus: 'completed',
    });
    expect(hasObjectiveExecutionEvidence(messages, 'u1')).toBe(true);
  });

  it('fails closed for generic execute tools whose inputs only describe reads', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Inspecte sans modifier', timestamp: 1 },
      {
        id: 'ssh-pwd', role: 'tool', content: '/srv/app', timestamp: 2,
        toolName: 'mcp__remote__ssh_execute', toolUseId: 'ssh-1', toolStatus: 'completed',
        toolInput: { command: 'pwd' }, toolExecuted: true,
      },
      {
        id: 'ssh-cat', role: 'tool', content: 'configuration', timestamp: 3,
        toolName: 'ssh_execute', toolUseId: 'ssh-2', toolStatus: 'completed',
        toolInput: { command: 'cat /etc/app.conf' }, toolExecuted: true,
      },
      {
        id: 'sql-select', role: 'tool', content: '[{"id":1}]', timestamp: 4,
        toolName: 'mcp__database__execute_query', toolUseId: 'sql-1', toolStatus: 'completed',
        toolInput: { query: 'SELECT id FROM invoices' }, toolExecuted: true,
      },
      {
        id: 'opaque-execute', role: 'tool', content: 'ok', timestamp: 5,
        toolName: 'execute', toolUseId: 'generic-1', toolStatus: 'completed',
        toolInput: { target: 'resource-1' }, toolExecuted: true,
      },
    ];

    expect(hasObjectiveExecutionEvidence(messages, 'u1')).toBe(false);
    const progress = turnProgressFingerprints(messages, 'u1');
    expect(progress.executionCount).toBe(0);
    expect(progress.evidenceCount).toBe(4);
  });

  it('accepts generic execute tools only with explicit mutation semantics', () => {
    const base: Message[] = [
      { id: 'u1', role: 'user', content: 'Applique la mise à jour', timestamp: 1 },
    ];
    const sqlMutation: Message = {
      id: 'sql-update', role: 'tool', content: '1 row updated', timestamp: 2,
      toolName: 'mcp__database__execute_query', toolUseId: 'sql-2', toolStatus: 'completed',
      toolInput: { query: 'UPDATE invoices SET status = \'paid\' WHERE id = 1' }, toolExecuted: true,
    };
    const sshMutation: Message = {
      id: 'ssh-write', role: 'tool', content: 'written', timestamp: 3,
      toolName: 'ssh_execute', toolUseId: 'ssh-3', toolStatus: 'completed',
      toolInput: { command: 'echo enabled > /etc/app.flag' }, toolExecuted: true,
    };

    expect(hasObjectiveExecutionEvidence([...base, sqlMutation], 'u1')).toBe(true);
    expect(hasObjectiveExecutionEvidence([...base, sshMutation], 'u1')).toBe(true);
  });

  it('recognizes structured connector mutations without interpreting connector query or command payloads', () => {
    const root: Message = { id: 'u1', role: 'user', content: 'Applique la mise à jour.', timestamp: 1 };
    const connector: Message = {
      id: 'graph-request', role: 'tool', content: '', timestamp: 2,
      toolName: 'mcp__plc-microsoft-365__graph_request', toolUseId: 'graph-call',
      toolStatus: 'completed', toolExecuted: true, toolResult: '{"ok":true}',
    };
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      const message = { ...connector, toolInput: { method } };
      expect(isObjectiveMutationTool(message)).toBe(true);
      expect(hasObjectiveExecutionEvidence([root, message], root.id)).toBe(true);
    }
    const opaquePost = { ...connector, toolInput: { method: 'POST' } };
    expect(isObjectiveMutationTool(opaquePost)).toBe(false);
    expect(isObjectiveEvidenceInvalidatingMutation(opaquePost)).toBe(true);
    expect(hasObjectiveExecutionEvidence([root, opaquePost], root.id)).toBe(false);
    for (const toolInput of [
      { method: 'POST', path: '/v1.0/me/sendMail' },
      { method: 'POST', url: 'https://api.example.test/v1/records/create?validate=true' },
    ]) {
      const message = { ...connector, toolInput };
      expect(isObjectiveMutationTool(message)).toBe(true);
      expect(isObjectiveEvidenceInvalidatingMutation(message)).toBe(true);
      expect(hasObjectiveExecutionEvidence([root, message], root.id)).toBe(true);
    }
    for (const method of ['GET', 'HEAD']) {
      const message = { ...connector, toolInput: { method } };
      expect(isObjectiveMutationTool(message)).toBe(false);
      expect(hasObjectiveExecutionEvidence([root, message], root.id)).toBe(false);
    }
    for (const toolInput of [{ action: 'configure_service' }, { operation: 'delete_record' }]) {
      const message = { ...connector, toolInput };
      expect(isObjectiveMutationTool(message)).toBe(true);
      expect(hasObjectiveExecutionEvidence([root, message], root.id)).toBe(true);
    }
    // Opaque connector payload fields are data unless the tool is a generic
    // executor; broad parsing here would turn user content into authority.
    for (const toolInput of [
      { query: 'UPDATE invoices SET paid = true' },
      { command: 'rm /tmp/target' },
    ]) expect(isObjectiveMutationTool({ ...connector, toolInput })).toBe(false);
  });

  it('keeps POST searches and validations conservative without treating them as execution proof', () => {
    const root: Message = {
      id: 'u1', role: 'user', content: 'Applique la mise à jour.', timestamp: 1,
    };
    const observations: Message[] = [
      {
        id: 'post-search', role: 'tool', content: '', timestamp: 2,
        toolName: 'mcp__research__search_records', toolUseId: 'search-call',
        toolStatus: 'completed', toolExecuted: true,
        toolInput: { method: 'POST', path: '/search/query', body: { query: 'current state' } },
        toolResult: '{"results":[{"id":"record-1"}]}',
      },
      {
        id: 'post-validation', role: 'tool', content: '', timestamp: 3,
        toolName: 'mcp__quality__validate_payload', toolUseId: 'validation-call',
        toolStatus: 'completed', toolExecuted: true,
        toolInput: { method: 'POST', path: '/validate', body: { id: 'record-1' } },
        toolResult: '{"valid":true}',
      },
    ];

    for (const observation of observations) {
      expect(isObjectiveMutationTool(observation)).toBe(false);
      expect(isObjectiveEvidenceInvalidatingMutation(observation)).toBe(true);
      expect(hasObjectiveExecutionEvidence([root, observation], root.id)).toBe(false);
    }
    const progress = turnProgressFingerprints([root, ...observations], root.id);
    expect(progress.executionCount).toBe(0);
    expect(progress.evidenceCount).toBe(2);
  });

  it('uses the shared tool-name semantics for generic mutation actions', () => {
    for (const [index, action] of [
      'copy_file',
      'forward-message',
      'erase_records',
      'destroy_cluster',
      'wipe_database',
      'purge_cache',
      'change_settings',
      'modify_record',
      'configure_service',
      'clear_queue',
      'export_records',
      'clone_repo',
      'duplicate_item',
      'provision_instance',
      'deprovision_instance',
    ].entries()) {
      const message: Message = {
        id: `action-${index}`, role: 'tool', content: 'completed', timestamp: index + 2,
        toolName: 'functions.exec', toolUseId: `action-call-${index}`, toolStatus: 'completed',
        toolExecuted: true, toolInput: { action }, toolResult: 'Mutation completed',
      };
      expect(isObjectiveMutationTool(message)).toBe(true);
      expect(isObjectiveEvidenceInvalidatingMutation(message)).toBe(true);
      expect(hasObjectiveExecutionEvidence([
        { id: 'u1', role: 'user', content: 'Applique la modification.', timestamp: 1 }, message,
      ], 'u1')).toBe(true);
    }
  });

  it('invalidates every non-empty generic SQL statement while only explicit writes prove execution', () => {
    const base: Message = {
      id: 'sql', role: 'tool', content: 'completed', timestamp: 2,
      toolName: 'mcp__database__execute_query', toolUseId: 'sql-call', toolStatus: 'completed',
      toolExecuted: true, toolResult: 'completed',
    };
    for (const query of [
      'SELECT id FROM invoices',
      'WITH changed AS (DELETE FROM invoices RETURNING id) SELECT * FROM changed',
      'SELECT mutate_invoice(1)',
    ]) {
      const message = { ...base, toolInput: { query } };
      expect(isObjectiveMutationTool(message)).toBe(false);
      expect(isObjectiveEvidenceInvalidatingMutation(message)).toBe(true);
      expect(hasObjectiveExecutionEvidence([
        { id: 'u1', role: 'user', content: 'Applique la modification.', timestamp: 1 }, message,
      ], 'u1')).toBe(false);
    }
    for (const query of [
      'CALL mutate_invoice(1)',
      'COPY invoices TO \'/tmp/invoices.csv\'',
      'DO $$ BEGIN DELETE FROM invoices; END $$',
      'VACUUM invoices',
    ]) {
      const message = { ...base, toolInput: { query } };
      expect(isObjectiveMutationTool(message)).toBe(true);
      expect(isObjectiveEvidenceInvalidatingMutation(message)).toBe(true);
    }
    expect(isObjectiveEvidenceInvalidatingMutation({ ...base, toolInput: { query: '   ' } })).toBe(false);
  });

  it('lets mutation tokens win inside compound connector tool names', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Applique les changements', timestamp: 1 },
      ...[
        'mcp__crm__search_and_delete',
        'api_check_and_publish',
        'mcp__storage__search_and_upload',
        'mcp__settings__get_and_set',
      ].map((toolName, index): Message => ({
        id: `compound-${index}`, role: 'tool', content: '', timestamp: index + 2,
        toolName, toolUseId: `mutation-${index}`, toolStatus: 'completed', toolExecuted: true,
        toolResult: 'Mutation completed with one affected resource',
      })),
    ];

    expect(hasObjectiveExecutionEvidence(messages, 'u1')).toBe(true);
    const progress = turnProgressFingerprints(messages, 'u1');
    expect(progress.executionCount).toBe(4);
    expect(progress.evidenceCount).toBe(0);
  });

  it('advances evidence for a distinct read but not for an identical repeated read', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Recherche', timestamp: 1 },
      {
        id: 'read-a', role: 'tool', content: 'alpha', timestamp: 2,
        toolName: 'Read', toolUseId: 'r1', toolStatus: 'completed', toolInput: { file_path: '/tmp/a.txt' },
      },
    ];
    const first = turnProgressFingerprints(messages, 'u1');
    expect(first.evidenceCount).toBe(1);
    expect(first.executionCount).toBe(0);

    messages.push({
      id: 'read-a-again', role: 'tool', content: 'alpha', timestamp: 3,
      toolName: 'Read', toolUseId: 'r2', toolStatus: 'completed', toolInput: { file_path: '/tmp/a.txt' },
    });
    expect(turnProgressFingerprints(messages, 'u1')).toEqual(first);

    messages.push({
      id: 'read-b', role: 'tool', content: 'beta', timestamp: 4,
      toolName: 'Read', toolUseId: 'r3', toolStatus: 'completed', toolInput: { file_path: '/tmp/b.txt' },
    });
    const second = turnProgressFingerprints(messages, 'u1');
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.evidenceProgress).not.toBe(first.evidenceProgress);
    expect(second.evidenceCount).toBe(2);
  });
});
