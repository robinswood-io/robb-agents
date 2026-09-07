import { describe, expect, it } from 'bun:test';
import type { Message } from '@craft-agent/core/types';
import {
  OBJECTIVE_OUTCOME_CONTINUE_EXAMPLE,
  buildObjectiveContractPrompt,
  findObjectiveText,
  hasObjectiveExecutionEvidence,
  hasObjectiveSubstantiveToolResult,
  objectiveCostUsd,
  transitionObjectiveContract,
  turnProgressFingerprint,
  turnProgressFingerprints,
} from './objective-contract.ts';
import { extractObjectiveOutcome } from './objective-outcome.ts';

describe('durable objective contract', () => {
  it('promotes complex and high-stakes work to mission semantics', () => {
    const objective = transitionObjectiveContract({
      messageId: 'u1',
      text: 'Analyse le NDA, recherche le droit applicable, corrige-le puis vérifie le document.',
      lifetimeCostUsd: 740,
      lifetimeTokens: 2_000_000,
      nowMs: 10,
    });
    expect(objective.orchestrationMode).toBe('mission');
    expect(objective.risk).toBe('high-stakes');
    expect(objective.budgetBaselineUsd).toBe(740);
    expect(objective.completionCriteria).toContain('independent-review-passed');
    expect(buildObjectiveContractPrompt(objective)).toContain('High-stakes evidence gate');
  });

  it('recognizes inflected accounting work as high-stakes', () => {
    const objective = transitionObjectiveContract({
      messageId: 'u-accounting',
      text: 'Corrige cette écriture comptable puis vérifie le grand livre.',
    });
    expect(objective.risk).toBe('high-stakes');
    expect(objective.evidenceRequirement).toBe('authoritative-sources-before-mutation');
    expect(objective.completionCriteria).toContain('independent-review-passed');
  });

  it('keeps the objective and budget baseline for terse continuation variants', () => {
    const initial = transitionObjectiveContract({
      messageId: 'u1', text: 'Diagnostique et corrige ce problème complexe.', lifetimeCostUsd: 20,
    });
    const continued = transitionObjectiveContract({
      existing: initial, messageId: 'u2', text: 'Fais le avec précision', lifetimeCostUsd: 80,
    });
    expect(continued.userMessageId).toBe('u1');
    expect(continued.budgetBaselineUsd).toBe(20);
    expect(continued.continuationCount).toBe(1);
    expect(objectiveCostUsd(continued, 24)).toBe(4);
  });

  it('preserves root identity and budget across colloquial and misspelled French resumptions', () => {
    const initial = {
      ...transitionObjectiveContract({
        messageId: 'root-user',
        text: 'Implémente la synchronisation puis vérifie le résultat.',
        lifetimeCostUsd: 20,
        nowMs: 10,
      }),
      terminalState: 'complete_verified' as const,
      completedAt: 20,
    };

    for (const [index, text] of [
      'Bah poursuit alors',
      'alors continue',
      'Reprned exactement où tu en étais',
      "Il faut qu'il s'occupe aussi du dépôt",
      "Non, ce n'est pas terminé",
    ].entries()) {
      const continued = transitionObjectiveContract({
        existing: initial,
        messageId: `follow-up-${index}`,
        text,
        lifetimeCostUsd: 90,
      });
      expect(continued.objectiveId).toBe('root-user');
      expect(continued.userMessageId).toBe('root-user');
      expect(continued.lastUserMessageId).toBe(`follow-up-${index}`);
      expect(continued.budgetBaselineUsd).toBe(20);
      expect(continued.terminalState).toBe('active');
      expect(continued.completedAt).toBeUndefined();
    }
  });

  it('starts a fresh budget for an unrelated new objective', () => {
    const first = transitionObjectiveContract({ messageId: 'u1', text: 'Corrige le bug.', lifetimeCostUsd: 12 });
    const second = transitionObjectiveContract({
      existing: first, messageId: 'u2', text: 'Résume ce nouveau document.', lifetimeCostUsd: 40,
    });
    expect(second.userMessageId).toBe('u2');
    expect(second.objectiveId).toBe('u2');
    expect(second.lastUserMessageId).toBe('u2');
    expect(second.budgetBaselineUsd).toBe(40);
  });

  it('keeps referenced follow-ups but resets an independent request even while active', () => {
    const first = transitionObjectiveContract({
      messageId: 'u1', text: 'Analyse et corrige la campagne.', lifetimeCostUsd: 12,
    });
    const scopedFollowUp = transitionObjectiveContract({
      existing: first,
      messageId: 'u2',
      text: 'Vérifie maintenant les sociétés restantes.',
      lifetimeCostUsd: 30,
    });
    expect(scopedFollowUp.userMessageId).toBe('u1');
    const independent = transitionObjectiveContract({
      existing: scopedFollowUp,
      messageId: 'u-independent',
      text: 'Prépare le budget marketing 2027 à partir du tableur joint.',
      lifetimeCostUsd: 30.5,
    });
    expect(independent.userMessageId).toBe('u-independent');
    const replacement = transitionObjectiveContract({
      existing: scopedFollowUp,
      messageId: 'u3',
      text: 'Nouvel objectif : prépare un autre dossier.',
      lifetimeCostUsd: 31,
    });
    expect(replacement.userMessageId).toBe('u3');
    expect(replacement.budgetBaselineUsd).toBe(31);
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

  it('advances evidence when the bounded result changes for the same normalized query', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Recherche', timestamp: 1 },
      {
        id: 'search-1', role: 'tool', content: 'first result', timestamp: 2,
        toolName: 'search', toolUseId: 's1', toolStatus: 'completed', toolInput: { query: '  VAT   receipt ' },
      },
    ];
    const first = turnProgressFingerprint(messages, 'u1');
    messages.push({
      id: 'search-2', role: 'tool', content: 'updated result', timestamp: 3,
      toolName: 'search', toolUseId: 's2', toolStatus: 'completed', toolInput: { query: 'VAT receipt' },
    });
    expect(turnProgressFingerprint(messages, 'u1')).not.toBe(first);
  });

  it('does not treat unchanged waits or reloads as progress', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Surveille', timestamp: 1 },
    ];
    const initial = turnProgressFingerprints(messages, 'u1');
    messages.push({
      id: 'wait', role: 'tool', content: 'still running', timestamp: 2,
      toolName: 'wait_threads', toolUseId: 'w1', toolStatus: 'completed', toolInput: { threadId: 't1' },
    }, {
      id: 'reload', role: 'tool', content: 'same page', timestamp: 3,
      toolName: 'browser', toolUseId: 'b1', toolStatus: 'completed', toolInput: { command: 'reload' },
    });
    expect(turnProgressFingerprints(messages, 'u1')).toEqual(initial);
  });

  it('separates executed mutation progress and excludes a non-executed checkpoint', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Corrige', timestamp: 1 },
      {
        id: 'blocked-edit', role: 'tool', content: 'Cost guard checkpoint: mutation Edit was not started.', timestamp: 2,
        toolName: 'Edit', toolUseId: 'e0', toolStatus: 'completed', toolInput: { file_path: '/tmp/a.ts' },
        toolExecuted: false,
        toolCheckpoint: { schemaVersion: 1, kind: 'tool-call-budget', reason: 'structural checkpoint' },
      },
    ];
    const blocked = turnProgressFingerprints(messages, 'u1');
    expect(blocked.executionCount).toBe(0);
    expect(hasObjectiveExecutionEvidence(messages, 'u1')).toBe(false);

    messages.push({
      id: 'executed-edit', role: 'tool', content: 'updated', timestamp: 3,
      toolName: 'Edit', toolUseId: 'e1', toolStatus: 'completed', toolInput: { file_path: '/tmp/a.ts' },
      toolExecuted: true,
    });
    const executed = turnProgressFingerprints(messages, 'u1');
    expect(executed.executionCount).toBe(1);
    expect(executed.executionProgress).not.toBe(blocked.executionProgress);
    expect(hasObjectiveExecutionEvidence(messages, 'u1')).toBe(true);
  });

  it('exposes only genuine substantive tool results for persisted evidence', () => {
    const base: Message = {
      id: 'read', role: 'tool', content: 'Read', timestamp: 1,
      toolName: 'Read', toolUseId: 'read-1', toolStatus: 'completed', toolExecuted: true,
      toolResult: 'verified contents',
    };
    expect(hasObjectiveSubstantiveToolResult(base)).toBe(true);
    expect(hasObjectiveSubstantiveToolResult({ ...base, toolResult: '' })).toBe(false);
    expect(hasObjectiveSubstantiveToolResult({ ...base, toolResult: 'auto-completed' })).toBe(false);
    expect(hasObjectiveSubstantiveToolResult({
      ...base,
      toolResult: 'Cost guard checkpoint: Read was not started.',
    })).toBe(false);
    expect(hasObjectiveSubstantiveToolResult({
      ...base,
      toolExecuted: false,
      toolResult: 'verified contents',
    })).toBe(false);
  });

  it('advances same-file Edit and Write mutations when transformer arguments differ', () => {
    for (const [toolName, transformKey] of [
      ['Edit', 'new_string'],
      ['Write', 'content'],
      ['Edit', 'patch'],
    ] as const) {
      const messages: Message[] = [
        { id: 'u1', role: 'user', content: 'Modifie le fichier', timestamp: 1 },
        {
          id: `${toolName}-1`, role: 'tool', content: 'updated', timestamp: 2,
          toolName, toolUseId: `${toolName}-call-1`, toolStatus: 'completed', toolExecuted: true,
          toolInput: { file_path: '/tmp/same.ts', [transformKey]: 'first transformation' },
        },
      ];
      const first = turnProgressFingerprints(messages, 'u1');
      messages.push({
        id: `${toolName}-2`, role: 'tool', content: 'updated', timestamp: 3,
        toolName, toolUseId: `${toolName}-call-2`, toolStatus: 'completed', toolExecuted: true,
        toolInput: { file_path: '/tmp/same.ts', [transformKey]: 'second transformation' },
      });
      const second = turnProgressFingerprints(messages, 'u1');
      expect(second.executionCount).toBe(2);
      expect(second.executionProgress).not.toBe(first.executionProgress);
      expect(second.fingerprint).not.toBe(first.fingerprint);

      messages.push({
        id: `${toolName}-duplicate`, role: 'tool', content: 'updated', timestamp: 4,
        toolName, toolUseId: `${toolName}-call-duplicate`, toolStatus: 'completed', toolExecuted: true,
        toolInput: { file_path: '/tmp/same.ts', [transformKey]: 'second transformation' },
      });
      expect(turnProgressFingerprints(messages, 'u1')).toEqual(second);
    }
  });

  it('requires concise host-verifiable outcome and independent-review receipts in the prompt', () => {
    const objective = transitionObjectiveContract({
      messageId: 'u1',
      text: 'Corrige cette déclaration fiscale puis vérifie-la.',
    });
    const prompt = buildObjectiveContractPrompt(objective);
    expect(prompt).toContain('Valid state values are: complete_verified, blocked_human, blocked_policy, continue');
    expect(prompt).toContain(OBJECTIVE_OUTCOME_CONTINUE_EXAMPLE);
    expect(extractObjectiveOutcome(OBJECTIVE_OUTCOME_CONTINUE_EXAMPLE).declaration?.state).toBe('continue');
    expect(prompt).toContain('toolUseId values from successful tool results');
    expect(prompt).toContain('blocker must be an object with kind, description, and evidence');
    expect(prompt).toContain('{"verdict":"PASS"');
    expect(prompt).toContain('invoking a reviewer alone is not evidence');
  });

  it('requires the structured receipt only for missions or execution objectives', () => {
    const direct = transitionObjectiveContract({
      messageId: 'u-direct',
      text: 'Explique simplement ce terme.',
    });
    expect(direct.orchestrationMode).toBe('direct');
    expect(direct.requiresExecutionEvidence).toBeUndefined();
    expect(buildObjectiveContractPrompt(direct)).not.toContain('robb_objective_outcome');

    const execution = transitionObjectiveContract({
      messageId: 'u-execution',
      text: 'Corrige ce titre.',
    });
    expect(execution.requiresExecutionEvidence).toBe(true);
    expect(buildObjectiveContractPrompt(execution)).toContain('robb_objective_outcome');

    const mission = transitionObjectiveContract({
      messageId: 'u-mission',
      text: 'Analyse le NDA et le droit applicable de bout en bout.',
    });
    expect(mission.orchestrationMode).toBe('mission');
    expect(buildObjectiveContractPrompt(mission)).toContain('robb_objective_outcome');
  });
});
