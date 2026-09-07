import { WorkspaceGovernanceStore } from '@craft-agent/shared/governance';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import { createHash } from 'node:crypto';
import type { Message } from '@craft-agent/core/types';
import {
  appendProjectMemoryEntry, loadProjectMemoryJournal, setProjectMemoryStatus,
  type ProjectMemoryEntry,
} from '@craft-agent/shared/projects';
import { redactSecretLikeMaterial } from '@craft-agent/shared/utils';
import { hasObjectiveSubstantiveToolResult } from './objective-contract.ts';

export async function getProjectLearningPolicy(root: string): Promise<{ enabled: boolean; retentionDays: number }> {
  const document = await new WorkspaceGovernanceStore(root).load();
  return document?.profile.space.memory ?? loadWorkspaceConfig(root)?.governance?.space.memory ?? { enabled: true, retentionDays: 30 };
}

export interface ProjectLearningRequest {
  action: 'propose' | 'validate' | 'revoke' | 'list';
  id?: string;
  content?: string;
  tags?: string[];
  evidenceIds?: string[];
  reviewToolUseId?: string;
  ttlDays?: number;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const evidenceHash = (messages: Message[]) => hash(JSON.stringify(messages.map(message => ({
  id: message.toolUseId ?? message.id, name: message.toolName, input: message.toolInput, result: message.toolResult, executed: message.toolExecuted,
}))));

/** Host-side provenance: the caller supplies references, never verdict booleans. */
export function handleProjectLearning(
  root: string, slug: string, actorSessionId: string, messages: Message[], request: ProjectLearningRequest,
): unknown {
  const entries = loadProjectMemoryJournal(root, slug, { strict: true }).entries;
  if (request.action === 'list') return entries.filter(entry => entry.status === 'proposed' && (!entry.expiresAt || Date.parse(entry.expiresAt) > Date.now())).slice(-30).map(entry => ({
    id: entry.id, content: entry.content, contentSha256: hash(entry.content),
    sourceEvidenceSha256: entry.tags.find(tag => tag.startsWith('evidence:'))?.slice(9),
    sourceSessionId: entry.provenance.actorId, expiresAt: entry.expiresAt,
  }));
  if (request.action === 'propose') {
    if (!request.content?.trim() || request.content.length > 4000) throw new Error('A learning proposal requires 1–4000 characters');
    if (redactSecretLikeMaterial(request.content) !== request.content) throw new Error('Remove secrets from the proposed memory');
    const evidence = messages.filter(message => request.evidenceIds?.some(id => id === message.id || id === message.toolUseId));
    if (!evidence.length || evidence.some(message => message.role !== 'tool' || !message.toolResult)
      || !request.evidenceIds?.every(id => evidence.some(message => id === message.id || id === message.toolUseId))) throw new Error('Proposal needs observed tool evidence');
    const digest = evidenceHash(evidence);
    const id = `learn_${hash(`${actorSessionId}:${digest}:${request.content}`).slice(0, 32)}`;
    const existing = entries.find(entry => entry.id === id);
    if (existing) return existing;
    if (entries.filter(entry => entry.status === 'proposed' && (!entry.expiresAt || Date.parse(entry.expiresAt) > Date.now())).length >= 100) throw new Error('Review or revoke pending proposals before adding more');
    const ttl = request.ttlDays ?? 30;
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > 365) throw new Error('TTL must be between 1 and 365 days');
    return appendProjectMemoryEntry(root, slug, {
      id, kind: 'procedure', content: request.content, status: 'proposed', confidence: 0.25, ttlDays: ttl,
      tags: [...(request.tags ?? []).filter(tag => /^[a-z0-9_-]{1,64}$/i.test(tag)).slice(0, 8), `evidence:${digest}`],
      provenance: { sourceType: 'session', sourceId: evidence.map(m => m.toolUseId ?? m.id).join(',').slice(0, 512), actorId: actorSessionId },
    });
  }
  const proposal = entries.find(entry => entry.id === request.id);
  if (!proposal) throw new Error('Proposal not found in the current project');
  if (request.action === 'revoke') return setProjectMemoryStatus(root, slug, proposal.id, 'forgotten');
  if (request.action !== 'validate') throw new Error('Unknown learning action');
  if (proposal.status !== 'proposed' || (proposal.expiresAt && Date.parse(proposal.expiresAt) <= Date.now())) throw new Error('Proposal is not pending or has expired');
  if (proposal.provenance.actorId === actorSessionId) throw new Error('Independent session review is required');
  const review = messages.find(message => message.toolUseId === request.reviewToolUseId);
  if (!review || !hasObjectiveSubstantiveToolResult(review) || !/(?:^|__)(?:call_llm|reviewer)$/.test(review.toolName ?? '')) throw new Error('A successful independent review tool result is required');
  let receipt: Record<string, unknown>;
  try { receipt = JSON.parse(review.toolResult!); } catch { throw new Error('Review must be an unambiguous JSON receipt'); }
  const replayIds = receipt.replayEvidenceIds;
  if (receipt.proposalId !== proposal.id || receipt.contentSha256 !== hash(proposal.content)
    || receipt.sourceEvidenceSha256 !== proposal.tags.find(tag => tag.startsWith('evidence:'))?.slice(9)
    || receipt.verdict !== 'PASS' || !Array.isArray(receipt.findings) || receipt.findings.length
    || !Array.isArray(replayIds) || !replayIds.length
    || !replayIds.every(id => messages.some(message => message.toolUseId === id
      && message !== review && message.timestamp < review.timestamp
      && hasObjectiveSubstantiveToolResult(message)
      && !/(?:project_learning|send_agent_message|call_llm)/.test(message.toolName ?? '')))) {
    throw new Error('Review must bind the exact proposal, source evidence and successful independent replay');
  }
  // Keep original provenance, lifetime and source digest; append a revision.
  const promoted: ProjectMemoryEntry = { ...proposal, status: 'active', confidence: 0.9 };
  return appendProjectMemoryEntry(root, slug, {
    ...promoted, provenance: promoted.provenance,
    tags: [...promoted.tags, `review:${hash(review.toolResult!)}`, `reviewer:${actorSessionId}`],
  });
}

/** Bounded, content-free capture. Failures create proposals, never active rules. */
export function captureObjectiveLearning(root: string, slug: string, sessionId: string, messages: Message[], ttlDays = 30): void {
  const recipes = [
    { pattern: /Validation failed for tool/i, tags: ['tool-schema'], content: 'Validate tool arguments against the active backend schema before dispatch. A rejected call is not an executed action.' },
    { pattern: /runtime not found|exec: : not found/i, tags: ['document', 'runtime'], content: 'Resolve and verify the bundled document runtime before conversion; correct missing dependencies before retrying.' },
    { pattern: /must read the browser tools guide/i, tags: ['browser', 'guide'], content: 'Load the applicable browser guide before automation, and preserve its prerequisite state through compaction.' },
  ];
  for (const recipe of recipes) {
    const message = messages.find(item => item.role === 'tool' && recipe.pattern.test(item.toolResult ?? ''));
    if (message) handleProjectLearning(root, slug, sessionId, messages, {
      action: 'propose', ttlDays, content: recipe.content, tags: recipe.tags, evidenceIds: [message.toolUseId ?? message.id],
    });
  }
}
