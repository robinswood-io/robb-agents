import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_PERSISTENT_FIELDS,
  type ContextCompactionAttemptState,
  type StoredSession,
} from '../types.ts';
import { readSessionHeader } from '../jsonl.ts';
import { getSessionFilePath, listSessions, loadSession, saveSession } from '../storage.ts';
import { pickSessionFields } from '../utils.ts';

describe('session persistence: context compaction backoff', () => {
  it('round-trips the provider-scale post-compaction growth baseline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'context-compaction-growth-baseline-'));
    const contextCompactionAttempt: ContextCompactionAttemptState = {
      attemptedAt: 1_725_000_000_000,
      contextTokensBefore: 205_056,
      outcome: 'succeeded',
      objectiveRootId: 'objective-root',
      providerContextBaselineTokens: 53_812,
      hardLimitTokens: 100_000,
      hardLimitFollowUpAttempted: true,
      hardLimitRecoveryAttempted: true,
    };
    const session: StoredSession = {
      id: 'cold-context-compaction-growth-baseline',
      workspaceRootPath: root,
      createdAt: 1,
      lastUsedAt: 2,
      contextCompactionAttempt,
      messages: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 53_812,
        costUsd: 0,
      },
    };

    try {
      await saveSession(session);

      expect(loadSession(root, session.id)?.contextCompactionAttempt).toEqual(contextCompactionAttempt);
      expect(readSessionHeader(getSessionFilePath(root, session.id))?.contextCompactionAttempt)
        .toEqual(contextCompactionAttempt);
      expect(listSessions(root).find(item => item.id === session.id)?.contextCompactionAttempt)
        .toEqual(contextCompactionAttempt);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('round-trips the provider-baseline wait marker across a cold restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'context-compaction-provider-wait-'));
    const contextCompactionAttempt: ContextCompactionAttemptState = {
      attemptedAt: 1_725_000_000_000,
      contextTokensBefore: 205_056,
      contextTokensAfter: 22_381,
      outcome: 'succeeded',
      objectiveRootId: 'objective-root',
      awaitingProviderContextBaseline: true,
      providerBaselineAdmissionDispatchedAt: 1_725_000_000_100,
      hardLimitTokens: 100_000,
    };
    const session: StoredSession = {
      id: 'cold-context-compaction-provider-wait',
      workspaceRootPath: root,
      createdAt: 1,
      lastUsedAt: 2,
      contextCompactionAttempt,
      messages: [],
      tokenUsage: {
        inputTokens: 205_056,
        outputTokens: 0,
        totalTokens: 205_056,
        contextTokens: 205_056,
        costUsd: 0,
      },
    };

    try {
      await saveSession(session);

      expect(loadSession(root, session.id)?.contextCompactionAttempt).toEqual(contextCompactionAttempt);
      expect(readSessionHeader(getSessionFilePath(root, session.id))?.contextCompactionAttempt)
        .toEqual(contextCompactionAttempt);
      expect(listSessions(root).find(item => item.id === session.id)?.contextCompactionAttempt)
        .toEqual(contextCompactionAttempt);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('survives a cold JSONL round-trip with its hard-limit loop guard', async () => {
    const root = mkdtempSync(join(tmpdir(), 'context-compaction-persistence-'));
    const contextCompactionAttempt: ContextCompactionAttemptState = {
      attemptedAt: 1_725_000_000_000,
      contextTokensBefore: 360_000,
      outcome: 'skipped-not-needed',
      hardLimitTokens: 350_000,
      hardLimitFollowUpAttempted: true,
      issueCode: 'not-needed',
    };
    const session: StoredSession = {
      id: 'cold-context-compaction',
      workspaceRootPath: root,
      createdAt: 1,
      lastUsedAt: 2,
      contextCompactionAttempt,
      messages: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 360_000,
        costUsd: 0,
      },
    };

    try {
      expect(SESSION_PERSISTENT_FIELDS).toContain('contextCompactionAttempt');
      await saveSession(session);

      expect(loadSession(root, session.id)?.contextCompactionAttempt).toEqual(contextCompactionAttempt);
      expect(readSessionHeader(getSessionFilePath(root, session.id))?.contextCompactionAttempt)
        .toEqual(contextCompactionAttempt);
      expect(listSessions(root).find(item => item.id === session.id)?.contextCompactionAttempt)
        .toEqual(contextCompactionAttempt);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists only bounded host classifications and safe integer measurements', () => {
    expect(pickSessionFields({
      id: 'sanitized-context-compaction',
      contextCompactionAttempt: {
        attemptedAt: 1_725_000_000_000,
        contextTokensBefore: 360_000,
        outcome: 'failed',
        hardLimitTokens: -1,
        hardLimitFollowUpAttempted: 'yes',
        objectiveRootId: `invalid\nobjective`,
        awaitingProviderContextBaseline: true,
        providerContextBaselineTokens: 123,
        issueCode: 'raw provider error with unbounded private text',
        providerError: 'must not reach disk',
        nested: { arbitrary: 'payload' },
      },
    })).toEqual({
      id: 'sanitized-context-compaction',
      contextCompactionAttempt: {
        attemptedAt: 1_725_000_000_000,
        contextTokensBefore: 360_000,
        outcome: 'failed',
      },
    });

    expect(pickSessionFields({
      id: 'invalid-context-compaction',
      contextCompactionAttempt: {
        attemptedAt: Number.MAX_SAFE_INTEGER + 1,
        contextTokensBefore: 360_000,
        outcome: 'failed',
      },
    })).toEqual({ id: 'invalid-context-compaction' });

    expect(pickSessionFields({
      id: 'bounded-context-compaction-after',
      contextCompactionAttempt: {
        attemptedAt: 1_725_000_000_000,
        contextTokensBefore: 205_056,
        contextTokensAfter: 22_381,
        outcome: 'succeeded',
        objectiveRootId: ' objective-root ',
        awaitingProviderContextBaseline: true,
        providerContextBaselineTokens: 53_812,
      },
    })).toEqual({
      id: 'bounded-context-compaction-after',
      contextCompactionAttempt: {
        attemptedAt: 1_725_000_000_000,
        contextTokensBefore: 205_056,
        contextTokensAfter: 22_381,
        outcome: 'succeeded',
        objectiveRootId: 'objective-root',
        providerContextBaselineTokens: 53_812,
      },
    });

    expect(pickSessionFields({
      id: 'unbounded-context-compaction-after',
      contextCompactionAttempt: {
        attemptedAt: 1_725_000_000_000,
        contextTokensBefore: 205_056,
        contextTokensAfter: 205_057,
        outcome: 'succeeded',
      },
    })).toEqual({
      id: 'unbounded-context-compaction-after',
      contextCompactionAttempt: {
        attemptedAt: 1_725_000_000_000,
        contextTokensBefore: 205_056,
        outcome: 'succeeded',
      },
    });
  });
});
