import type { ActiveSessionObjective } from '../../../shared/src/sessions/types/objectives.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import { describe, expect, it } from "bun:test";
import type { Message } from "@craft-agent/core/types";
import { hasObjectiveExecutionEvidence, objectiveRequiresExecutionEvidence, transitionObjectiveContract } from "./objective-contract.ts";

describe('legacy direct repair authority', () => {
  it('recovers an authenticated repair command while preserving explicit denial', () => {
    const text = 'Solutionne et relance, tu dois y accéder par API';
    const current = transitionObjectiveContract({ messageId: 'repair', text });
    expect(current.requiresExecutionEvidence).toBe(true);
    const legacy = omitUndefined<ActiveSessionObjective>({ ...current, requiresExecutionEvidence: undefined });
    expect(objectiveRequiresExecutionEvidence(legacy)).toBe(true);
    expect(objectiveRequiresExecutionEvidence({ ...legacy, requiresExecutionEvidence: false })).toBe(false);
    expect(objectiveRequiresExecutionEvidence({
      ...legacy, amendments: [{ messageId: 'stop', text: 'Ne relance rien.', timestamp: 2 }],
    })).toBe(false);
    expect(objectiveRequiresExecutionEvidence({
      ...legacy, delegatedRole: 'reviewer',
    })).toBe(false);
  });

  it('recognizes a completed non-reviewer delegated child session as parent execution evidence', () => {
    const root: Message = {
      id: 'parent-root',
      role: 'user',
      content: 'Délègue la création du fichier à un sous-agent worker puis lis-le.',
      timestamp: 10,
    };
    const spawnWorker: Message = {
      id: 'spawn-worker',
      role: 'tool',
      content: '',
      timestamp: 20,
      toolName: 'mcp__session__spawn_session',
      toolStatus: 'completed',
      toolExecuted: true,
      toolInput: { role: 'worker', waitMode: 'wait', prompt: 'Crée /tmp/worker.json' },
      toolResult: JSON.stringify({ sessionId: 'child-worker-1', status: 'started' }),
    };
    const waitWorker: Message = {
      id: 'wait-worker',
      role: 'tool',
      content: '',
      timestamp: 30,
      toolName: 'mcp__session__wait_sessions',
      toolStatus: 'completed',
      toolExecuted: true,
      toolInput: { sessionIds: ['child-worker-1'] },
      toolResult: JSON.stringify({
        completed: true,
        sessions: [{ sessionId: 'child-worker-1', status: 'completed', objectiveState: 'complete_verified' }],
      }),
    };
    const workerTerminalReceipt: Message = {
      id: 'worker-receipt',
      role: 'user',
      timestamp: 29,
      internalOrigin: { kind: 'agent-message', senderSessionId: 'child-worker-1' },
      content: [
        '[host-delegated-terminal-result-v1]',
        JSON.stringify({
          childSessionId: 'child-worker-1',
          parentObjectiveId: 'parent-root',
          role: 'worker',
          status: 'completed',
          state: 'complete_verified',
        }),
      ].join('\n'),
    };
    const spawnReviewer: Message = {
      ...spawnWorker,
      id: 'spawn-reviewer',
      toolInput: { role: 'reviewer', waitMode: 'wait', prompt: 'Vérifie /tmp/worker.json' },
      toolResult: JSON.stringify({ sessionId: 'child-reviewer-1', status: 'started' }),
    };
    const waitReviewer: Message = {
      ...waitWorker,
      id: 'wait-reviewer',
      toolInput: { sessionIds: ['child-reviewer-1'] },
      toolResult: JSON.stringify({
        completed: true,
        sessions: [{ sessionId: 'child-reviewer-1', status: 'completed', objectiveState: 'complete_verified' }],
      }),
    };
    const reviewerTerminalReceipt: Message = {
      id: 'reviewer-receipt',
      role: 'user',
      timestamp: 29,
      internalOrigin: { kind: 'agent-message', senderSessionId: 'child-reviewer-1' },
      content: [
        '[host-delegated-terminal-result-v1]',
        JSON.stringify({
          childSessionId: 'child-reviewer-1',
          parentObjectiveId: 'parent-root',
          role: 'reviewer',
          status: 'completed',
          state: 'complete_verified',
        }),
      ].join('\n'),
    };

    expect(hasObjectiveExecutionEvidence([root, spawnWorker, waitWorker], 'parent-root')).toBe(true);
    expect(hasObjectiveExecutionEvidence([root, workerTerminalReceipt], 'parent-root')).toBe(true);
    expect(hasObjectiveExecutionEvidence([root, spawnReviewer, waitReviewer], 'parent-root')).toBe(false);
    expect(hasObjectiveExecutionEvidence([root, reviewerTerminalReceipt], 'parent-root')).toBe(false);
  });
});
