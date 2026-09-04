import { describe, expect, it } from 'bun:test';
import type { Message } from '@craft-agent/core/types';
import {
  buildObjectiveContractPrompt,
  findObjectiveText,
  hasObjectiveExecutionEvidence,
  objectiveCostUsd,
  transitionObjectiveContract,
  turnProgressFingerprint,
} from './objective-contract.ts';

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

  it('starts a fresh budget for an unrelated new objective', () => {
    const first = transitionObjectiveContract({ messageId: 'u1', text: 'Corrige le bug.', lifetimeCostUsd: 12 });
    const second = transitionObjectiveContract({
      existing: first, messageId: 'u2', text: 'Résume ce nouveau document.', lifetimeCostUsd: 40,
    });
    expect(second.userMessageId).toBe('u2');
    expect(second.budgetBaselineUsd).toBe(40);
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
});
