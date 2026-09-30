import { describe, expect, it } from 'bun:test';
import type { Message, ObjectiveAcceptanceCriterion, ObjectiveOutcomeDeclaration } from '@craft-agent/core/types';
import { hasObjectiveExecutionEvidence, isObjectiveEvidenceInvalidatingMutation, isObjectiveMutationTool, transitionObjectiveContract } from './objective-contract.ts';
import { registerObjectiveAcceptanceCriteria, validateObjectiveAcceptanceCriteria } from './objective-acceptance-criteria.ts';

// Exact local status invocation from fluid-coast; no transcript/profile writes.
const status: Message = {
  id: 'msg-1788948865048-qgkkug', role: 'tool', content: '', timestamp: 1788948865048,
  toolName: 'mcp__session__set_session_status',
  toolUseId: 'call_MwwKxUjk8I3E3tNgh2UzmAQG|fc_0f2f52330d183de6016aa1317f5a6c87d29eb1d19f5d598a70',
  toolInput: { status: 'needs-review', _displayName: 'Passer en revue',
    _intent: 'Signaler que la livraison est complète, déployée et prête pour la revue de Thibault sans fermer la tâche.' },
  toolStatus: 'completed', toolExecuted: true,
  toolResult: 'Status set to "needs-review" on current session.',
};
const root: Message = { id: 'root', role: 'user', content: 'Vérifie le service.', timestamp: 1 };
const criterion: ObjectiveAcceptanceCriterion = { id: 'target-ready', description: 'The requested target is ready',
  toolName: 'Read', input: { file_path: '/srv/status.json' }, checks: [{ path: 'ready', equals: true }] };
const objective = registerObjectiveAcceptanceCriteria(transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [criterion], 2);
const observation: Message = { id: 'check', role: 'tool', content: '', timestamp: 3, toolName: 'Read', toolUseId: 'check-call',
  toolInput: { file_path: '/srv/status.json' }, toolResult: '{"ready":true}', toolStatus: 'completed', toolExecuted: true };
const outcome: ObjectiveOutcomeDeclaration = { state: 'complete_verified', blocker: null, remainingWork: [],
  criteria: [{ id: criterion.id, satisfied: true, evidence: ['check-call'] }] };

describe('current session status and target evidence', () => {
  it('preserves a prior valid check across the exact fluid-coast status invocation and local aliases', () => {
    for (const toolName of ['set_session_status', 'session__set_session_status', 'mcp__session__set_session_status']) {
      const event = { ...status, toolName };
      expect(isObjectiveMutationTool(event)).toBe(true);
      expect(isObjectiveEvidenceInvalidatingMutation(event)).toBe(false);
      expect(hasObjectiveExecutionEvidence([root, event], root.id)).toBe(false);
      expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, event], outcome)).toEqual([]);
      expect(validateObjectiveAcceptanceCriteria(objective, [root, event], outcome)).toHaveLength(1);
    }
  });

  it('does not exempt other targets, namespaces, added operations or permission changes', () => {
    const variants: Array<Partial<Message>> = [
      { toolName: 'mcp__crm__set_session_status' },
      { toolName: 'mcp__session__set_session_status_and_delete' },
      { toolName: 'mcp__session__set_permission_mode', toolInput: { mode: 'allow-all' } },
      { toolName: 'mcp__session__set_session_permissions', toolInput: { permissions: 'execute' } },
      { toolInput: { status: 'needs-review', sessionId: 'another-session' } },
      { toolInput: { status: 'needs-review', sessionId: '' } },
      { toolInput: { status: 'needs-review', permissionMode: 'allow-all' } },
      { toolInput: { status: 'needs-review', operation: 'delete' } },
      { toolInput: { status: 'needs-review', command: 'rm /srv/status.json' } },
      { toolInput: {} },
    ];
    for (const change of variants) {
      const event = { ...status, ...change };
      expect(isObjectiveEvidenceInvalidatingMutation(event)).toBe(true);
      expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, event], outcome)).toHaveLength(1);
    }
  });

  it('keeps real business writes, screenshot copies and project memory edits invalidating', () => {
    for (const change of [
      { toolName: 'Edit', toolInput: { file_path: '/srv/status.json', old_string: 'true', new_string: 'false' } },
      { toolName: 'Edit', toolInput: { file_path: '/Users/local/.craft-agent/workspaces/test/projects/jlm/MEMORY.md' } },
      { toolName: 'mcp__rbw-servers__ssh_execute', toolInput: { server: 'dev', command: 'docker cp work-prod-backend:/tmp/check.png /tmp/check.png' } },
      { toolName: 'mcp__rbw-servers__ssh_execute', toolInput: { server: 'dev', command: 'systemctl restart work' } },
    ]) {
      const event = { ...status, ...change };
      expect(isObjectiveEvidenceInvalidatingMutation(event)).toBe(true);
      expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, event], outcome)).toHaveLength(1);
      expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, event, status], outcome)).toHaveLength(1);
    }
  });
});
