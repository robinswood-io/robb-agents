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
  /** Host-known target/runtime version; never inferred from arbitrary result text. */
  version?: string;
  kind?: 'procedure' | 'observation';
}
export interface ProjectLearningIoOptions {
  /** Exact lexical root captured when the session was created. This is used
   * only to recognize pre-physical-identity scope keys; all I/O stays in root. */
  legacyWorkspaceRootPath?: string;
  /** Revalidate the owning runtime/root after every asynchronous read and
   * immediately before the following synchronous journal mutation. */
  assertTarget?: () => void;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const evidenceHash = (messages: Message[]) => hash(JSON.stringify(messages.map(message => ({
  id: message.toolUseId ?? message.id, role: message.role, timestamp: message.timestamp,
  name: message.toolName, input: message.toolInput, result: message.role === 'tool' ? message.toolResult : message.content,
  executed: message.toolExecuted, errorCode: message.errorCode, errorDetails: message.errorDetails,
}))));

const hostileMemory = /<\/?(?:system|developer|assistant|host[_-]|automatic_turn_recovery|project_memory)|\[Agent message|\bignore\s+(?:all\s+)?(?:previous|prior|system)\s+instructions|\b(?:disable|bypass)\s+(?:all\s+)?(?:safety|security|protection|permissions)\b|\b(?:d[ée]sactive|contourne)\s+(?:(?:toutes?|les?|la)\s+)*(?:protections?|permissions?|s[ée]curit[ée])\b/i;
function assertSafeProposal(content: string): void {
  if (redactSecretLikeMaterial(content) !== content
    || /\b(?:mot de passe|cl[ée] api|jeton d['’]acc[èe]s)\s*(?:est|:|=)\s*\S+|\bsk-(?:proj-|ant-)?[a-zA-Z0-9_-]{12,}\b/i.test(content)) throw new Error('Remove secrets from the proposed memory');
  if (hostileMemory.test(content)) throw new Error('Hostile control text cannot become project learning');
}
function isDirectHumanMessage(message: Message): boolean {
  return message.role === 'user' && !message.hidden && !message.internalOrigin
    && !message.isPending && !message.agentDelivery && !hostileMemory.test(message.content);
}
function observedEvidence(message: Message): boolean {
  return (message.role === 'tool' && Boolean(message.toolResult) && Boolean(message.toolName))
    || isObservedHostError(message)
    || isDirectHumanMessage(message);
}
function isObservedHostError(message: Message): boolean {
  return message.role === 'error' && Boolean(message.content)
    && (message.errorCode === undefined || /^[a-zA-Z0-9_.:-]{1,100}$/.test(message.errorCode));
}

/** Host-side provenance: the caller supplies references, never verdict booleans. */
export async function handleProjectLearning(
  root: string, slug: string, actorSessionId: string, messages: Message[], request: ProjectLearningRequest,
  ioOptions?: ProjectLearningIoOptions,
): Promise<unknown> {
  const policy = await getProjectLearningPolicy(root);
  ioOptions?.assertTarget?.();
  if (!policy.enabled && request.action === 'list') return [];
  if (!policy.enabled && request.action !== 'revoke') throw new Error('Project memory is disabled by workspace policy');
  const entries = loadProjectMemoryJournal(root, slug, {
    strict: true,
    legacyWorkspaceRootPath: ioOptions?.legacyWorkspaceRootPath,
  }).entries;
  if (request.action === 'list') return entries.filter(entry => entry.status === 'proposed'
    && (!entry.scope || entry.scope.projectSlug === slug)
    && (!entry.expiresAt || Date.parse(entry.expiresAt) > Date.now())
    && Date.now() - Date.parse(entry.createdAt) <= policy.retentionDays * 86400000).slice(-30).map(entry => ({
    id: entry.id, content: entry.content, contentSha256: hash(entry.content),
    sourceEvidenceSha256: entry.tags.find(tag => tag.startsWith('evidence:'))?.slice(9),
    sourceSessionId: entry.provenance.actorId, sourceEvidenceIds: entry.provenance.sourceId?.split(','),
    expiresAt: entry.expiresAt, version: entry.scope?.version,
  }));
  if (request.action === 'propose') {
    if (!request.content?.trim() || request.content.length > 4000) throw new Error('A learning proposal requires 1–4000 characters');
    assertSafeProposal(request.content);
    if (!request.evidenceIds?.length || request.evidenceIds.length > 8
      || request.evidenceIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_:.|/-]{1,160}$/.test(id))
      || request.evidenceIds.join(',').length > 512) throw new Error('Proposal needs 1–8 bounded observed tool or direct user evidence references');
    const evidence = messages.filter(message => request.evidenceIds?.some(id => id === message.id || id === message.toolUseId));
    if (!evidence.length || evidence.some(message => !observedEvidence(message))
      || !request.evidenceIds?.every(id => evidence.some(message => id === message.id || id === message.toolUseId))) throw new Error('Proposal needs observed tool evidence');
    const digest = evidenceHash(evidence);
    const id = `learn_${hash(`${slug}:${actorSessionId}:${request.version ?? ''}:${digest}:${request.content}`).slice(0, 32)}`;
    const existing = entries.find(entry => entry.id === id);
    if (existing) return existing;
    if (entries.filter(entry => entry.status === 'proposed' && (!entry.expiresAt || Date.parse(entry.expiresAt) > Date.now())).length >= 100) throw new Error('Review or revoke pending proposals before adding more');
    const ttl = Math.min(request.ttlDays ?? 30, policy.retentionDays);
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > 365) throw new Error('TTL must be between 1 and 365 days');
    return appendProjectMemoryEntry(root, slug, {
      id, kind: request.kind ?? 'procedure', content: request.content, status: 'proposed', confidence: 0.25, ttlDays: ttl,
      scope: { projectSlug: slug, ...(request.version ? { version: request.version } : {}) },
      tags: [...(request.tags ?? []).filter(tag => /^[a-z0-9_-]{1,64}$/i.test(tag)).slice(0, 8), `evidence:${digest}`],
      provenance: { sourceType: 'session', sourceId: evidence.map(m => m.toolUseId ?? m.id).join(','), actorId: actorSessionId },
    });
  }
  const proposal = entries.find(entry => entry.id === request.id);
  if (!proposal) throw new Error('Proposal not found in the current project');
  if (proposal.scope && proposal.scope.projectSlug !== slug) throw new Error('Proposal belongs to a different project');
  if (request.action === 'revoke') {
    return setProjectMemoryStatus(root, slug, proposal.id, 'forgotten', new Date(), ioOptions);
  }
  if (request.action !== 'validate') throw new Error('Unknown learning action');
  if (proposal.status !== 'proposed' || (proposal.expiresAt && Date.parse(proposal.expiresAt) <= Date.now())
    || Date.now() - Date.parse(proposal.createdAt) > policy.retentionDays * 86400000) throw new Error('Proposal is not pending or has expired');
  assertSafeProposal(proposal.content);
  if (proposal.provenance.actorId === actorSessionId) throw new Error('Independent session review is required');
  const review = messages.find(message => message.toolUseId === request.reviewToolUseId);
  if (!review || !hasObjectiveSubstantiveToolResult(review) || !/(?:^|__)(?:call_llm|reviewer)$/.test(review.toolName ?? '')) throw new Error('A successful independent review tool result is required');
  let receipt: Record<string, unknown>;
  try { receipt = JSON.parse(review.toolResult!); } catch { throw new Error('Review must be an unambiguous JSON receipt'); }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Review must be an unambiguous JSON receipt');
  const replayIds = receipt.replayEvidenceIds;
  if (receipt.proposalId !== proposal.id || receipt.contentSha256 !== hash(proposal.content)
    || receipt.sourceEvidenceSha256 !== proposal.tags.find(tag => tag.startsWith('evidence:'))?.slice(9)
    || receipt.verdict !== 'PASS' || !Array.isArray(receipt.findings) || receipt.findings.length
    || (proposal.scope?.version && (request.version !== proposal.scope.version || receipt.version !== proposal.scope.version))
    || !Array.isArray(replayIds) || !replayIds.length
    || !replayIds.every(id => messages.some(message => message.toolUseId === id
      && message !== review && message.timestamp < review.timestamp
      && message.timestamp >= Date.parse(proposal.createdAt)
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

export interface UserCorrectionLearningEvent {
  messageId: string;
  correctedMessageId: string;
  objectiveId?: string;
  version?: string;
}

/** Capture explicit feedback as a quoted observation, never as inferred advice.
 * The host passes persisted messages from this project/session only. A signal
 * selects a review candidate; its wording cannot establish truth or permission.
 */
export async function captureProjectUserCorrection(
  root: string, slug: string, sessionId: string, messages: Message[], event: UserCorrectionLearningEvent,
  ioOptions?: ProjectLearningIoOptions,
): Promise<ProjectMemoryEntry | null> {
  const policy = await getProjectLearningPolicy(root);
  ioOptions?.assertTarget?.();
  if (!policy.enabled) return null;
  const index = messages.findIndex(message => message.id === event.messageId);
  const message = messages[index];
  const corrected = messages.slice(0, index).find(item => item.id === event.correctedMessageId);
  if (!message || !corrected || !isDirectHumanMessage(message) || corrected.role !== 'assistant'
    || corrected.isIntermediate || corrected.isPending || corrected.timestamp > message.timestamp) return null;
  if (event.objectiveId) {
    const objectiveIndex = messages.findIndex(item => item.id === event.objectiveId);
    if (objectiveIndex < 0 || objectiveIndex >= index || messages.indexOf(corrected) < objectiveIndex) return null;
  }
  const feedback = message.content.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  // Deliberately excludes generic "continue", acknowledgements and new fix
  // requests. These expressions refer back to an answer or observed omission.
  const correctionSignal = /\bc['’]est\s+(?:faux|incorrect|insuffisant|trop peu)\b|\b(?:ce|cela|ca) n['’]est\s+(?:toujours\s+)?pas\s+(?:exact|suffisant|correct)\b|\bil (?:me semble qu['’]il )?manque\b|\b(?:tu as|vous avez) (?:oublie|confondu)\b|\b(?:nous utilisions|on utilisait)\b|\b(?:that is|that['’]s|this is)\s+(?:wrong|incorrect|insufficient|not enough)\b|\byou (?:missed|forgot|confused)\b|^(?:correction|rectification)\s*:/;
  if (!correctionSignal.test(feedback) || message.content.length > 4000) return null;
  try { assertSafeProposal(message.content); } catch { return null; }
  const content = `User correction awaiting independent verification: ${JSON.stringify(message.content.slice(0, 1600))}. Refers to assistant message ${corrected.id}. This records the user's assertion only, not a verified fact or permission.`;
  return await handleProjectLearning(root, slug, sessionId, messages, {
    action: 'propose', kind: 'observation', content, tags: ['user-correction', 'observation'],
    evidenceIds: [message.id], ttlDays: Math.min(30, policy.retentionDays), version: event.version,
  }, ioOptions) as ProjectMemoryEntry;
}

export interface TerminalLearningEvent {
  objectiveId: string;
  state: 'complete_verified' | 'blocked_human' | 'blocked_policy' | 'exhausted' | 'cancelled';
  /** Optional exact observations supplied by the host completion evaluator. */
  evidenceIds?: string[];
  version?: string;
  ttlDays?: number;
}

/** A temporal failure/success sequence is evidence, not proof of a repair.
 * Store references and safe metadata only; never copy tool bodies or synthesize
 * a remedy from a regex match. At most three candidates per terminal outcome.
 */
export async function captureProjectTerminalLearning(
  root: string, slug: string, sessionId: string, messages: Message[], event: TerminalLearningEvent,
  ioOptions?: ProjectLearningIoOptions,
): Promise<ProjectMemoryEntry[]> {
  const policy = await getProjectLearningPolicy(root);
  ioOptions?.assertTarget?.();
  if (!policy.enabled || event.state === 'cancelled') return [];
  if (!['complete_verified', 'blocked_human', 'blocked_policy', 'exhausted'].includes(event.state)) return [];
  const objectiveIndex = messages.findIndex(message => message.id === event.objectiveId);
  if (objectiveIndex < 0) return [];
  const scoped = messages.slice(objectiveIndex + 1);
  const observed = scoped.filter(message => ((message.role === 'tool' && message.toolName && message.toolResult)
      || isObservedHostError(message))
    && (!event.evidenceIds || event.evidenceIds.includes(message.toolUseId ?? message.id)));
  const failures = observed.filter(message => message.role === 'error' || message.isError || message.toolStatus === 'error');
  const proposals: ProjectMemoryEntry[] = [];
  const seen = new Set<string>();
  for (const failure of failures.slice(-30)) {
    const failureName = failure.role === 'error' ? `host:${failure.errorCode ?? 'unclassified-error'}` : failure.toolName!;
    if (seen.has(failureName) || proposals.length >= 3) continue;
    seen.add(failureName);
    if (!/^[a-zA-Z0-9_.:-]{1,200}$/.test(failureName)) continue;
    const replay = failure.role === 'tool' ? observed.find(message => message.timestamp > failure.timestamp
      && message.toolName === failure.toolName && hasObjectiveSubstantiveToolResult(message))
      : undefined;
    const state = replay ? 'failure-followed-by-success' : 'terminal-failure';
    const content = `Observed ${failureName} failure in objective ${event.objectiveId}; terminal outcome: ${event.state}.${replay ? ` A later ${failureName} call succeeded. Temporal sequence alone does not prove a repair or an equivalent target.` : ' No successful recovery was established by the selected evidence.'} Inspect the cited inputs/results and replay before proposing a reusable procedure.`;
    const proposal = await handleProjectLearning(root, slug, sessionId, messages, {
      action: 'propose', kind: 'observation', content, tags: [state, 'observation'], version: event.version,
      evidenceIds: [failure.toolUseId ?? failure.id, ...(replay ? [replay.toolUseId ?? replay.id] : [])],
      ttlDays: Math.min(event.ttlDays ?? 30, policy.retentionDays),
    }, ioOptions) as ProjectMemoryEntry;
    proposals.push(proposal);
  }
  return proposals;
}

/** Compatibility hook: accepts completed objective tools, with no guessed recipe. */
export async function captureObjectiveLearning(root: string, slug: string, sessionId: string, messages: Message[], ttlDays = 30): Promise<void> {
  const objectiveId = 'legacy-objective-capture';
  await captureProjectTerminalLearning(root, slug, sessionId,
    [{ id: objectiveId, role: 'user', content: '', timestamp: 0 }, ...messages],
    { objectiveId, state: 'complete_verified', ttlDays });
}
