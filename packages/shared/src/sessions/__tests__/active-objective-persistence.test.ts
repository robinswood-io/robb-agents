import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_PERSISTENT_FIELDS,
  type ActiveSessionObjective,
  type PendingTurnRecovery,
  type StoredSession,
} from '../types.ts';
import { pickSessionFields } from '../utils.ts';
import { getSessionFilePath, loadSession, saveSession } from '../storage.ts';
import { readSessionHeader } from '../jsonl.ts';

describe('session persistence: active objective', () => {
  it('preserves the durable objective contract and isolated budget baseline', () => {
    const activeObjective: ActiveSessionObjective = {
      schemaVersion: 1,
      objectiveId: 'objective-root',
      userMessageId: 'user-original',
      lastUserMessageId: 'user-follow-up',
      startedAt: 10,
      budgetBaselineUsd: 740,
      tokenBaseline: 2_000_000,
      continuationCount: 2,
      orchestrationMode: 'mission',
      risk: 'high-stakes',
      requiresExecutionEvidence: true,
      evidenceDomain: 'security',
      evidenceRequirement: 'authoritative-sources-before-mutation',
      completionCriteria: [
        'requested-outcome-delivered',
        'relevant-checks-passed',
        'no-safe-work-remaining',
        'independent-review-passed',
      ],
      terminalState: 'active',
      automaticModelTier: 'highRisk',
      model: 'pi/gpt-5.6-sol',
      thinkingLevel: 'xhigh',
      lastOutcome: {
        state: 'continue',
        criteria: [{ id: 'requested-outcome-delivered', satisfied: false, evidence: [] }],
        remainingWork: ['Finish the requested outcome'],
        blocker: null,
      },
    };

    expect(SESSION_PERSISTENT_FIELDS).toContain('activeObjective');
    expect(pickSessionFields({ id: 'session-1', activeObjective })).toEqual({
      id: 'session-1',
      activeObjective,
    });
  });

  it('persists the automatic-recovery progress and wall-clock lease', () => {
    const pendingTurnRecovery: PendingTurnRecovery = {
      userMessageId: 'user-original',
      startedAt: 10,
      leaseExpiresAt: 21_600_010,
      attempts: 24,
      lastAttemptAt: 200,
      lastProgressAt: 190,
      lastProgressFingerprint: 'semantic-proof',
      stagnantAttempts: 0,
    };

    expect(SESSION_PERSISTENT_FIELDS).toContain('pendingTurnRecovery');
    expect(pickSessionFields({ id: 'session-1', pendingTurnRecovery })).toEqual({
      id: 'session-1',
      pendingTurnRecovery,
    });
  });

  it('round-trips a durable recovery strategy transition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recovery-strategy-persistence-'));
    try {
      const pendingTurnRecovery: PendingTurnRecovery = {
        userMessageId: 'user-original',
        startedAt: 10,
        leaseExpiresAt: 21_600_010,
        attempts: 2,
        continuationRequired: true,
        recoveryStrategy: {
          schemaVersion: 1,
          phase: 'replan',
          attemptBaseline: 2,
          transitionCount: 1,
          transitionedAt: 200,
          reason: 'attempt-limit',
        },
      };
      const session: StoredSession = {
        id: 'recovery-strategy', workspaceRootPath: root, createdAt: 1, lastUsedAt: 2,
        pendingTurnRecovery, messages: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
      };

      await saveSession(session);
      for (const restored of [loadSession(root, session.id), readSessionHeader(getSessionFilePath(root, session.id))]) {
        expect(restored?.pendingTurnRecovery).toEqual(pendingTurnRecovery);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('round-trips an exhausted continuation outcome and its presentation fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'objective-continuation-persistence-'));
    try {
      const remainingWork = ['Verify the installed staging candidate'];
      const activeObjective: ActiveSessionObjective = {
        schemaVersion: 1,
        objectiveId: 'objective-root',
        userMessageId: 'user-original',
        startedAt: 10,
        budgetBaselineUsd: 0,
        tokenBaseline: 0,
        continuationCount: 2,
        orchestrationMode: 'direct',
        risk: 'standard',
        completionCriteria: ['requested-outcome-delivered'],
        terminalState: 'exhausted',
        lastOutcome: { state: 'continue', criteria: [], remainingWork, blocker: null },
        interruptedTurnRecovery: {
          objectiveId: 'objective-root',
          userMessageId: 'user-original',
          recovery: {
            userMessageId: 'user-original', startedAt: 10, leaseExpiresAt: 100,
            attempts: 2, exhaustedAt: 40, lastCause: 'stream_ended',
            continuationOrigin: 'objective_continue', continuationWork: remainingWork,
          },
        },
      };
      const session: StoredSession = {
        id: 'continuation-presentation', workspaceRootPath: root, createdAt: 1, lastUsedAt: 2,
        activeObjective, messages: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
      };

      await saveSession(session);
      for (const restored of [loadSession(root, session.id), readSessionHeader(getSessionFilePath(root, session.id))]) {
        expect(restored?.activeObjective?.terminalState).toBe('exhausted');
        expect(restored?.activeObjective?.lastOutcome?.remainingWork).toEqual(remainingWork);
        expect(restored?.activeObjective?.interruptedTurnRecovery?.recovery.continuationWork).toEqual(remainingWork);
        expect(restored?.activeObjective?.interruptedTurnRecovery?.recovery.continuationOrigin).toBe('objective_continue');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('round-trips delegation and revised evidence without resetting an unknown recovery budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'competence-recovery-persistence-'));
    try {
      const criterion = { id: 'observed', description: 'The exact target is ready', toolName: 'Read',
        input: { file_path: '/fixture/state.json' }, checks: [{ path: 'ready', equals: true }] };
      const session: StoredSession = {
        id: 'combined-persistence', workspaceRootPath: root, createdAt: 1, lastUsedAt: 2,
        parentSessionId: 'parent-session', permissionMode: 'safe', model: 'pi/gpt-5.6-sol',
        delegation: { rootSessionId: 'root-session', rootObjectiveId: 'root-objective',
          parentObjectiveId: 'parent-objective', depth: 2, role: 'reviewer' },
        activeObjective: {
          schemaVersion: 1, objectiveId: 'objective-root', userMessageId: 'original-user', startedAt: 10,
          budgetBaselineUsd: 7, tokenBaseline: 1000, continuationCount: 3,
          orchestrationMode: 'direct', risk: 'standard', completionCriteria: ['requested-outcome-delivered'],
          terminalState: 'exhausted', automaticModelTier: 'complex',
          acceptanceCriteria: [criterion], acceptanceRegisteredAt: 30,
          acceptanceRegisteredAtById: { observed: 30 }, acceptanceRevision: 'amendment-user',
          acceptanceRegisteredRevision: 'amendment-user', acceptanceNeedsReview: true,
          acceptanceHistory: [{ revision: 'original-user', criteria: [criterion], registeredAt: 20,
            registeredAtById: { observed: 20 } }],
          amendments: [{ messageId: 'amendment-user', text: 'Inspect the corrected target.', timestamp: 25 }],
        },
        pendingTurnRecovery: { userMessageId: 'original-user', startedAt: 10, attempts: 2,
          leaseExpiresAt: 100_000, exhaustedAt: 40, budgetHistoryUnavailable: true },
        pendingAgentDeliveryIds: ['delivery-one'], pendingQueuedMessageIds: ['queued-one'],
        messages: [{ id: 'original-user', type: 'user', content: 'Inspect the supplied target.', timestamp: 1 }],
        tokenUsage: { inputTokens: 1600, outputTokens: 400, totalTokens: 2000, contextTokens: 1800, costUsd: 9 },
      };
      await saveSession(session);
      for (const restored of [loadSession(root, session.id), readSessionHeader(getSessionFilePath(root, session.id))]) {
        expect(restored?.activeObjective).toEqual(session.activeObjective);
        expect(restored?.pendingTurnRecovery).toEqual(session.pendingTurnRecovery);
        expect(restored?.delegation).toEqual(session.delegation);
        expect(restored?.pendingAgentDeliveryIds).toEqual(['delivery-one']);
        expect(restored?.pendingQueuedMessageIds).toEqual(['queued-one']);
        expect(restored?.permissionMode).toBe('safe');
        expect(restored?.model).toBe('pi/gpt-5.6-sol');
      }
      expect(loadSession(root, session.id)?.messages).toEqual(session.messages);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
