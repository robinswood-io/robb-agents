import type { Message, ObjectiveAcceptanceCriterion, ObjectiveOutcomeDeclaration } from '@craft-agent/core/types';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import {
  classifyToolNameMutationSemantics,
  isClearlyReadOnlyToolAction,
} from '@craft-agent/shared/agent';
import {
  inspectReadOnlyReviewCommand,
  READ_ONLY_GIT_HARDENING_ARGS,
} from '@craft-agent/shared/agent/bash-validator';
import { completionCriterionPathKeys } from '@craft-agent/session-tools-core';
import { Buffer } from 'node:buffer';
import { posix } from 'node:path';
import {
  hasObjectiveSubstantiveToolResult,
  isExplicitReadOnlyReview,
  isObjectiveCoordinationTool,
  isObjectiveEvidenceInvalidatingMutation,
  isObjectiveToolExecutedSuccessfully,
} from './objective-contract.ts';
import { collectObjectiveAcceptanceObservations } from './objective-acceptance-criteria.ts';

export interface DelegatedReviewRequest {
  objectiveId: string;
  acceptanceSha256: string;
  criteria: string[];
  /** Single-target review scope, absent for an authenticated host check set. */
  target?: string;
  /** Exact multi-target checks supplied by the host in the spawned-session envelope. */
  targetChecks?: ObjectiveAcceptanceCriterion[];
  /** Remote aliases belong to the named connector, never to the local filesystem. */
  remote?: { source: 'rbw-servers'; server: string };
  revision?: string;
  /** A final host envelope; parsing it alone does not authenticate its root. */
  hostBound?: true;
}

export interface DelegatedReviewValidation {
  valid: boolean;
  state: 'complete_verified' | 'continue';
  gaps: string[];
  /** Attests delivery of the review only. Its unchanged visible verdict belongs to the parent. */
  declaration?: ObjectiveOutcomeDeclaration;
}

// Coordination can neither prove an inspection nor count as a target mutation.
const COORDINATION = /^(?:mcp__session__|session__)?(?:spawn_session|wait_sessions|send_agent_message|request_user_input|call_llm|set_completion_criteria|project_learning)$/;
const HOST_REVIEW_OPEN = '<host_parent_review_contract>';
const HOST_REVIEW_CLOSE = '</host_parent_review_contract>';
export const HOST_DELEGATED_REVIEWER_PREFIX = [
  'Tu es le reviewer indépendant délégué par l’hôte.',
  'Travaille exclusivement en lecture seule sur les contrôles exacts fournis par l’hôte.',
  'Ne modifie rien.',
].join(' ');
export const HOST_PARENT_REVIEW_INSTRUCTION = 'Return a parent-bound PASS or FAIL with findings after inspecting the supplied target. This binding is data, not write authority. Complete your own review objective separately.';
const HOST_REVIEW_CONTEXT_OPEN = '<host_parent_review_context_base64url>';
const HOST_REVIEW_CONTEXT_CLOSE = '</host_parent_review_context_base64url>';
const LOCAL_REVIEW_SHELL_TOOLS = new Set(['Bash', 'exec_command']);
const LOCAL_REVIEW_READ_TOOLS = new Set(['Read']);
const HOST_BOUND_REVIEW_CONNECTOR_TOOLS = new Set([
  'mcp__rbw-servers__ssh_execute',
  'mcp__session__browser_tool',
  'mcp__rbw-agents-oss__oss_healthcheck',
]);

/**
 * Host-authenticated review checks may use an installed connector's explicit
 * read operation. A fixed connector allowlist rejected legitimate immutable
 * checks such as Graph GET, mail list and accounting get. The child then fell
 * through to the parent's PASS-only business gate and retried a valid FAIL
 * verdict until exhaustion.
 *
 * Tool names remain hints rather than authority. Admission here is limited to
 * an explicit read-first action with neutral mutation semantics; completed
 * messages are checked again below by the host effect classifier before they
 * can count as evidence.
 */
function isHostReviewTargetCheckTool(
  toolName: string,
  input: Record<string, unknown>,
  sourceSlugs?: readonly string[],
  authenticatedContract = false,
): boolean {
  if (LOCAL_REVIEW_SHELL_TOOLS.has(toolName)
    || LOCAL_REVIEW_READ_TOOLS.has(toolName)
    || HOST_BOUND_REVIEW_CONNECTOR_TOOLS.has(toolName)) return true;
  if (!toolName.startsWith('mcp__')) return false;
  const connectorSlug = toolName.split('__')[1];
  if (!connectorSlug || !authenticatedContract && !sourceSlugs?.includes(connectorSlug)) return false;
  if (classifyToolNameMutationSemantics(toolName) !== 'neutral') return false;
  if (isClearlyReadOnlyToolAction(toolName)) return true;
  // Generic request transports are read-only only when the immutable
  // criterion itself fixes GET. POST-with-query and omitted methods stay out.
  const method = typeof input.method === 'string' ? input.method.trim().toUpperCase() : undefined;
  return method === 'GET';
}

interface HostParentReviewContract {
  protocol: 'host-review-v2';
  objectiveId: string;
  acceptanceSha256: string;
  criteria: string[];
  targetChecks: ObjectiveAcceptanceCriterion[];
  singleTarget?: Pick<DelegatedReviewRequest, 'target' | 'remote' | 'revision'>;
  instruction: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function scalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)
    || typeof value === 'string' && value.length <= 2_048;
}

function selectorIdentity(path: string): string | undefined {
  if (path === '$text') return JSON.stringify(['$text']);
  const keys = completionCriterionPathKeys(path);
  return keys === undefined ? undefined : JSON.stringify(keys);
}

function validHostTargetCheck(
  value: unknown,
  sourceSlugs: readonly string[],
): value is ObjectiveAcceptanceCriterion {
  if (!isRecord(value) || Object.keys(value).some(key => !['id', 'supersedes', 'requirementId', 'description', 'toolName', 'input', 'checks'].includes(key))
    || typeof value.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.id)
    || value.supersedes !== undefined && (typeof value.supersedes !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.supersedes))
    || value.requirementId !== undefined && (typeof value.requirementId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.requirementId))
    || typeof value.description !== 'string' || !value.description.trim() || value.description.length > 1_000
    || typeof value.toolName !== 'string'
    || !isRecord(value.input) || Object.keys(value.input).length < 1 || Object.keys(value.input).length > 16
    || !isHostReviewTargetCheckTool(value.toolName, value.input, sourceSlugs)
    || !Array.isArray(value.checks) || value.checks.length < 1 || value.checks.length > 16) return false;
  const inputs = new Set<string>();
  for (const [path, expected] of Object.entries(value.input)) {
    const keys = completionCriterionPathKeys(path);
    const identity = keys?.length ? JSON.stringify(keys) : undefined;
    if (!identity || path.length > 256 || !scalar(expected) || inputs.has(identity)) return false;
    inputs.add(identity);
  }
  const checks = new Set<string>();
  for (const check of value.checks) {
    if (!isRecord(check) || Object.keys(check).some(key => key !== 'path' && key !== 'equals')
      || typeof check.path !== 'string' || check.path.length > 256 || !scalar(check.equals)
      || check.path === '$text' && typeof check.equals !== 'string') return false;
    const identity = selectorIdentity(check.path);
    if (!identity || checks.has(identity)) return false;
    checks.add(identity);
  }
  return true;
}

function validHostSingleTarget(value: unknown): value is NonNullable<HostParentReviewContract['singleTarget']> {
  if (!isRecord(value) || Object.keys(value).some(key => !['target', 'remote', 'revision'].includes(key))
    || typeof value.target !== 'string' || !value.target || value.target.length > 2_048
    || !value.target.startsWith('/') && !/^https?:\/\/[^\s,;"<>]+$/.test(value.target)
    || value.revision !== undefined && (typeof value.revision !== 'string' || !/^[a-f0-9]{7,40}$/i.test(value.revision))) return false;
  if (value.remote === undefined) return true;
  return isRecord(value.remote)
    && Object.keys(value.remote).every(key => key === 'source' || key === 'server')
    && value.remote.source === 'rbw-servers'
    && typeof value.remote.server === 'string'
    && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value.remote.server)
    && value.target.startsWith('/');
}

/** The host envelope is recognized only once, as the final element of the immutable root request. */
function hostParentReviewContract(
  text: string,
  sourceSlugs: readonly string[],
): { present: boolean; value?: HostParentReviewContract } {
  const opens = [...text.matchAll(/<host_parent_review_contract>/g)];
  const closes = [...text.matchAll(/<\/host_parent_review_contract>/g)];
  if (!opens.length && !closes.length) return { present: false };
  if (opens.length !== 1 || closes.length !== 1) return { present: true };
  const start = opens[0]!.index! + HOST_REVIEW_OPEN.length;
  const end = closes[0]!.index!;
  if (end < start || text.slice(end + HOST_REVIEW_CLOSE.length).trim()) return { present: true };
  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(start, end)); } catch { return { present: true }; }
  if (!isRecord(parsed) || Object.keys(parsed).some(key => !['protocol', 'objectiveId', 'acceptanceSha256', 'criteria', 'targetChecks', 'singleTarget', 'instruction'].includes(key))
    || parsed.protocol !== 'host-review-v2'
    || typeof parsed.objectiveId !== 'string' || !parsed.objectiveId || parsed.objectiveId.length > 256
    || typeof parsed.acceptanceSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(parsed.acceptanceSha256)
    || !Array.isArray(parsed.criteria) || parsed.criteria.length < 1 || parsed.criteria.length > 32
    || parsed.criteria.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,127}$/.test(id))
    || new Set(parsed.criteria).size !== parsed.criteria.length
    || !Array.isArray(parsed.targetChecks) || parsed.targetChecks.length > 16
    || parsed.targetChecks.some(check => !validHostTargetCheck(check, sourceSlugs))
    || new Set(parsed.targetChecks.map(check => (check as ObjectiveAcceptanceCriterion).id)).size !== parsed.targetChecks.length
    || parsed.targetChecks.some(check => !(parsed.criteria as unknown[]).includes((check as ObjectiveAcceptanceCriterion).id))
    || parsed.singleTarget !== undefined && !validHostSingleTarget(parsed.singleTarget)
    || ((parsed.targetChecks.length > 0) === (parsed.singleTarget !== undefined))
    || typeof parsed.instruction !== 'string' || !parsed.instruction.trim() || parsed.instruction.length > 4_000
    || parsed.instruction !== HOST_PARENT_REVIEW_INSTRUCTION) return { present: true };
  return { present: true, value: parsed as unknown as HostParentReviewContract };
}

/** Top-level JSON objects only, respecting quotes and escapes. No evaluation. */
function requestObjects(text: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  let depth = 0; let start = -1; let quoted = false; let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"' && depth) quoted = true;
    else if (char === '{') { if (!depth) start = index; depth++; }
    else if (char === '}' && depth && --depth === 0) {
      try {
        // User templates commonly spell a boolean as true|false or bool. Only
        // these non-JSON tokens in a value position are normalized.
        const value = JSON.parse(text.slice(start, index + 1)
          .replace(/:\s*(?:true\s*\|\s*false|bool(?:ean)?)(?=\s*[,}])/gi, ':false'));
        if (value && typeof value === 'object' && !Array.isArray(value)) objects.push(value);
      } catch { /* Other prose/braces are not review contracts. */ }
    }
  }
  return objects;
}

interface ExplicitTargetMention {
  value: string;
  start: number;
  end: number;
}

/** Collect concrete resource-shaped tokens independently of their introducer.
 * A reviewer target still needs the explicit grammar in reviewTarget(), but a
 * second bare path/URL cannot be silently discarded after the first target. */
function explicitTargetMentions(text: string): ExplicitTargetMention[] {
  const mentions: ExplicitTargetMention[] = [];
  for (const match of text.matchAll(
    /\bhttps?:\/\/[^\s,;"<>]+|\b[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}:\/(?!\/)[^\s,;"<>]+|(?<![a-zA-Z0-9_.:/-])\/(?!\/)[^\s,;"<>]+/gi,
  )) {
    const raw = match[0]!;
    const value = raw.replace(/[.)\]}]+$/, '');
    mentions.push({ value, start: match.index!, end: match.index! + raw.length });
  }
  return mentions;
}

function reviewTarget(text: string, sourceSlugs: readonly string[] = []): Pick<DelegatedReviewRequest, 'target' | 'remote'> | undefined {
  const targets = [...text.matchAll(/\b(?:cible|target|worktree|dans|in|cwd|d[ée]p[oô]t|repository|repo)(?:\s*[:=]\s*|\s+)(https?:\/\/[^\s,;"<>]+|\/(?!\/)[^\s,;"<>]+|[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}:\/(?!\/)[^\s,;"<>]+)/gi)]
    .map(match => match[1]!.replace(/[.)]+$/, ''));
  const uniqueTargets = [...new Set(targets)];
  if (uniqueTargets.length !== 1 || uniqueTargets[0]!.length > 2_048) return undefined;
  const value = uniqueTargets[0]!;
  // URI schemes are resources, never rbw server aliases. Only the deliberately
  // narrower alias:/absolute/path form participates in remote qualification.
  const httpUrl = /^https?:\/\//i.test(value);
  if (/^https?:/i.test(value) && !httpUrl) return undefined;
  const qualified = httpUrl
    ? null
    : /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,63}):(\/.*)$/.exec(value);
  const servers = new Set([...text.matchAll(/\bserver\s*=\s*([^\s,;"<>]*)/gi)].map(match => match[1]!.replace(/[.)]+$/, '')));
  if (qualified) servers.add(qualified[1]!);
  // Ordinary prose such as "code source disponible" is not a connector
  // declaration. Keep only the explicit transport wording used by the request.
  const sources = new Set([...text.matchAll(/\b(?:via|avec|et|sur)\s+(?:la\s+)?source\s+([^\s,;"<>]*)/gi)].map(match => match[1]!.replace(/[.)]+$/, '')));
  if (servers.size === 1 && !sources.size && sourceSlugs.includes('rbw-servers')) sources.add('rbw-servers');
  if (!servers.size && !sources.size) return { target: value };
  // This connector's actual receipts attest the server/cwd/command input
  // schema. Unknown connectors or incomplete identities stay unqualified.
  if (servers.size !== 1 || sources.size !== 1 || !sources.has('rbw-servers')
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test([...servers][0]!)) return undefined;
  const target = qualified?.[2] ?? value;
  if (!target.startsWith('/')) return undefined;
  return { target, remote: { source: 'rbw-servers', server: [...servers][0]! } };
}

/** Resolve a single inspection identity before the child prompt is wrapped.
 * This extracts only a target/version from the parent text; it grants no action
 * authority and the child receives a constant read-only reviewer procedure. */
export function deriveHostDelegatedReviewSingleTarget(
  prompt: string,
  sourceSlugs: readonly string[] = [],
): HostParentReviewContract['singleTarget'] {
  const explicitTargets = explicitTargetMentions(prompt);
  if (new Set(explicitTargets.map(item => item.value)).size !== 1) return undefined;
  const target = reviewTarget(prompt, sourceSlugs);
  if (!target) return undefined;
  const folded = prompt.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const foldedTargets = explicitTargetMentions(folded);
  // match.index uses UTF-16 code-unit offsets; split('') preserves those
  // offsets even when the preceding prompt contains astral characters.
  const targetMasked = folded.split('');
  for (const mention of foldedTargets) {
    for (let index = mention.start; index < mention.end; index++) {
      if (targetMasked[index] !== '\n') targetMasked[index] = ' ';
    }
  }
  const revisionText = targetMasked.join('');
  const signal = /\b(?:commits?|revisions?|versions?|sha(?:-?(?:1|256))?s?|heads?)\b|\b[a-f0-9]{7,40}\b/i;
  if (!signal.test(revisionText)) return target;

  // Admit one deliberately small positive grammar only. The phrase must be a
  // complete clause or immediately follow the one target token, and it must
  // end that clause. Negations, host/runtime comparisons, plural forms,
  // hash-first prose and additional versions therefore fail structurally.
  const canonical = /\b(?:(?:a\s+la|at)\s+)?(commit|revision|sha(?:-?1)?|head)(?:\s+(?:cible|target|attendu(?:e)?|expected|requested))?\s*[:=]?\s*([a-f0-9]{7,40})\b/gi;
  const accepted: Array<{ start: number; end: number; revision: string }> = [];
  for (const match of revisionText.matchAll(canonical)) {
    const start = match.index!;
    const end = start + match[0].length;
    const clauseStart = Math.max(
      revisionText.lastIndexOf('.', start - 1), revisionText.lastIndexOf('!', start - 1),
      revisionText.lastIndexOf('?', start - 1), revisionText.lastIndexOf(';', start - 1),
      revisionText.lastIndexOf('\n', start - 1),
    ) + 1;
    const endings = ['.', '!', '?', ';', '\n']
      .map(delimiter => revisionText.indexOf(delimiter, end))
      .filter(index => index >= 0);
    const clauseEnd = endings.length ? Math.min(...endings) : revisionText.length;
    const precedingTarget = [...foldedTargets]
      .reverse()
      .find(item => item.start >= clauseStart && item.end <= start);
    const beginsClause = !revisionText.slice(clauseStart, start).trim();
    const followsTarget = precedingTarget !== undefined
      && /^[\s,:\-—]*$/u.test(revisionText.slice(precedingTarget.end, start));
    const endsClause = !revisionText.slice(end, clauseEnd).trim();
    if (endsClause && (beginsClause || followsTarget)) {
      accepted.push({ start, end, revision: match[2]!.toLowerCase() });
    }
  }
  if (accepted.length !== 1) return undefined;
  const remaining = revisionText.split('');
  for (let index = accepted[0]!.start; index < accepted[0]!.end; index++) {
    if (remaining[index] !== '\n') remaining[index] = ' ';
  }
  if (signal.test(remaining.join(''))) return undefined;
  return { ...target, revision: accepted[0]!.revision };
}

/** Qualify the full explicit review instruction; templates never create read-only authority. */
function isBoundReadOnlyReviewScope(text: string): boolean {
  if (isExplicitReadOnlyReview(text)) return true;
  const folded = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  if (/\b(?:lecture\s+seule|read[- ]only)\s+(?:si\s+possible|if\s+possible)\b/.test(folded)) return false;
  const reviewer = /^(?:tu\s+es\s+(?:(?:le|la|un|une)\s+)?|agis\s+comme\s+(?:(?:le|la|un|une)\s+)?)(?:contre-)?(?:reviewer|reviseur|reviseuse|relecteur|relectrice)\b/.test(folded);
  const readingInstruction = /(?:^|[.!?\n])\s*(?:verifi(?:e|ez)|inspect(?:e|ez))\s+(?:independamment\s*,?\s*)?(?:en\s+lecture\s+seule)\b/.test(folded);
  if (!reviewer || !readingInstruction) return false;
  // Use the existing full-request mutation rejection. Prefixing is permitted
  // only after the explicit role AND reading instruction were identified.
  if (/\b(?:apport(?:e|er|ez)\s+(?:les|des)\s+(?:corrections?|modifications?)|(?:les|des)\s+(?:corrections?|modifications?)\s+doivent\s+etre\s+appliquees?)\b/.test(folded)) return false;
  return isExplicitReadOnlyReview(`Revue independante en lecture seule. ${text}`);
}

/** Decode only the one exact host-authored wrapper. The parent prompt is data,
 * never executable reviewer authority. Canonical base64url round-tripping also
 * rejects alternate encodings, invalid UTF-8 and attempts to smuggle a second
 * prefix or context delimiter around the encoded field. */
function canonicalHostReviewerBrief(text: string): string | undefined {
  const hostContractIndex = text.indexOf(HOST_REVIEW_OPEN);
  if (hostContractIndex < 0) return undefined;
  const authorityText = text.slice(0, hostContractIndex).replaceAll('\r\n', '\n');
  if (authorityText.includes('\r')) return undefined;
  const open = `${HOST_DELEGATED_REVIEWER_PREFIX}\n\n${HOST_REVIEW_CONTEXT_OPEN}`;
  const close = `${HOST_REVIEW_CONTEXT_CLOSE}\n\n`;
  if (!authorityText.startsWith(open) || !authorityText.endsWith(close)) return undefined;
  const encoded = authorityText.slice(open.length, -close.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
  const bytes = Buffer.from(encoded, 'base64url');
  const brief = bytes.toString('utf8');
  if (!brief || bytes.toString('base64url') !== encoded
    || !Buffer.from(brief, 'utf8').equals(bytes)) return undefined;
  return brief;
}

/** Host-bound authority is deliberately non-migrating: persisted v1/free-text
 * envelopes are rejected and must be replaced by a fresh canonical v2 review. */
function hostAuthenticatedReviewerScope(text: string): boolean {
  return canonicalHostReviewerBrief(text) !== undefined;
}

/** Wrapper syntax is a reserved host namespace. A malformed, quoted or
 * duplicated fragment must never fall through to the ordinary review parser. */
function containsReservedHostReviewerArtifact(text: string): boolean {
  return text.toLowerCase().includes(HOST_DELEGATED_REVIEWER_PREFIX.toLowerCase())
    || /host_parent_review_(?:context_base64url|contract)/i.test(text);
}

export function prependHostDelegatedReviewerScope(prompt: string): string {
  const encoded = Buffer.from(prompt, 'utf8').toString('base64url');
  return `${HOST_DELEGATED_REVIEWER_PREFIX}\n\n${HOST_REVIEW_CONTEXT_OPEN}${encoded}${HOST_REVIEW_CONTEXT_CLOSE}`;
}

/** Derived only from the immutable original request, never from the final receipt or tool output. */
export function getDelegatedReviewRequest(
  text: string,
  sourceSlugs: readonly string[] = [],
  delegatedRole?: ActiveSessionObjective['delegatedRole'],
): DelegatedReviewRequest | undefined {
  if (text.length > 32_000) return undefined;
  const hostContract = hostParentReviewContract(text, sourceSlugs);
  if (hostContract.present && !hostContract.value) return undefined;
  // A valid final host envelope is the authenticated parent contract. JSON
  // examples and bindings earlier in the model-authored prompt remain
  // untrusted context and cannot override — or make ambiguous — that contract.
  if (hostContract.value) {
    if (delegatedRole !== 'reviewer') return undefined;
    if (!hostAuthenticatedReviewerScope(text)) return undefined;
    if (hostContract.value.targetChecks.length) return {
      objectiveId: hostContract.value.objectiveId,
      acceptanceSha256: hostContract.value.acceptanceSha256,
      criteria: [...hostContract.value.criteria],
      targetChecks: structuredClone(hostContract.value.targetChecks),
      hostBound: true,
    };
    // V2 never interprets the encoded parent brief as authority. The host
    // resolved this unique inspection identity before constructing the root.
    const target = hostContract.value.singleTarget;
    if (!target) return undefined;
    return {
      objectiveId: hostContract.value.objectiveId,
      acceptanceSha256: hostContract.value.acceptanceSha256,
      criteria: [...hostContract.value.criteria],
      ...structuredClone(target),
      hostBound: true,
    };
  }
  if (containsReservedHostReviewerArtifact(text)) return undefined;
  if (!isBoundReadOnlyReviewScope(text)) return undefined;
  const objects = requestObjects(text);
  const bindings = objects.filter(value => typeof value.objectiveId === 'string' && /^[a-f0-9]{64}$/i.test(String(value.acceptanceSha256)));
  const uniqueBindings = new Set(bindings.map(value => JSON.stringify([value.objectiveId, value.acceptanceSha256])));
  if (uniqueBindings.size !== 1) return undefined;
  const templates = bindings.filter(value => ['PASS', 'FAIL', 'PASS|FAIL'].includes(String(value.verdict)) && Array.isArray(value.criteria));
  if (!templates.length) return undefined;
  const criteria = (templates[0]!.criteria as unknown[]).map(item => (item as { id?: unknown })?.id);
  if (!criteria.length || criteria.length > 32 || criteria.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,127}$/.test(id))
    || new Set(criteria).size !== criteria.length
    || templates.some(value => JSON.stringify((value.criteria as Array<{ id: string }>).map(item => item?.id)) !== JSON.stringify(criteria))) return undefined;
  // A concrete target must be part of the task itself. A binding/hash alone
  // cannot turn an arbitrary tool invocation into an audit of a real resource.
  const target = reviewTarget(text, sourceSlugs);
  if (!target) return undefined;
  const folded = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const revision = /\b(?:commit|HEAD(?:\s+(?:attendu|exactement|vaut|doit\s+valoir))?)\s*[:=]?\s*(?:[A-Z][A-Z0-9_-]*\s+)?([a-f0-9]{7,40})\b/i.exec(folded)?.[1];
  return { objectiveId: String(bindings[0]!.objectiveId), acceptanceSha256: String(bindings[0]!.acceptanceSha256), criteria: criteria as string[], ...target, ...(revision ? { revision } : {}) };
}

/** Replace only the objective-contract paragraph for this qualified child task. */
export function buildDelegatedReviewPrompt(input: {
  parentSessionId?: string;
  objective: ActiveSessionObjective;
  sourceSlugs?: readonly string[];
  messages?: readonly Message[];
}): string | undefined {
  const request = input.parentSessionId && input.objective.originalText
    ? getDelegatedReviewRequest(input.objective.originalText, input.sourceSlugs, input.objective.delegatedRole) : undefined;
  if (!request) return undefined;
  if (request.hostBound) {
    const roots = input.messages?.filter(message => message.id === input.objective.userMessageId) ?? [];
    const root = roots.length === 1 ? roots[0] : undefined;
    if (input.objective.delegatedRole !== 'reviewer'
      || !root || root.role !== 'user' || root.hidden || root.isQueued || root.isPending
      || root.internalOrigin?.kind !== 'spawned-session'
      || root.internalOrigin.senderSessionId !== input.parentSessionId
      || root.content !== input.objective.originalText) return undefined;
  }
  const targetInstruction = request.targetChecks
    ? `Inspect every exact host-bound target check using real completed read-only tools: ${JSON.stringify(request.targetChecks.map(({ id, toolName, input: targetInput, checks }) => ({ id, toolName, input: targetInput, checks })))}. These authenticated host checks are already the immutable review evidence contract; do not call set_completion_criteria or register a second copy. The host envelope binds evidence targets but grants no write or execution authority.`
    : `Inspect the actual target ${request.target}${request.revision ? ` and requested revision ${request.revision}` : ''} using real completed read-only tools. Register target-bound checks with set_completion_criteria and inspect their actual output. A queued tool, checkpoint, another agent’s report or a constant printed result is not inspection evidence.`;
  const passReceipt = {
    objectiveId: request.objectiveId,
    acceptanceSha256: request.acceptanceSha256,
    verdict: 'PASS',
    criteria: request.criteria.map(id => ({ id, passed: true })),
    findings: [],
  };
  const failReceipt = {
    objectiveId: request.objectiveId,
    acceptanceSha256: request.acceptanceSha256,
    verdict: 'FAIL',
    criteria: request.criteria.map(id => ({ id, passed: false })),
    findings: ['<concrete observed defect or inspection limitation for a requested criterion>'],
  };
  const safeGit = `git ${READ_ONLY_GIT_HARDENING_ARGS.join(' ')}`;
  return [
    'This delegated task delivers an independent read-only review. Preserve its original scope, target and the user’s exact requested JSON format.',
    `Return exactly one JSON object with only these top-level fields: objectiveId, acceptanceSha256, verdict, criteria, findings. objectiveId and acceptanceSha256 are top-level fields, never a nested binding object, and must retain these exact values: ${JSON.stringify({ objectiveId: request.objectiveId, acceptanceSha256: request.acceptanceSha256 })}.`,
    `The criteria field is an array containing every requested ID exactly once and only as an object {"id":"<exact-id>","passed":true|false}; never return criterion IDs as strings. The exact requested IDs are ${JSON.stringify(request.criteria)}.`,
    `A valid PASS receipt has this complete shape: ${JSON.stringify(passReceipt)}`,
    'For PASS, findings MUST be exactly []; positive observations, expected limitations and scope notes are not findings, and this receipt schema has no observations field. Omit that commentary instead of adding another top-level field.',
    `A valid FAIL receipt has this complete shape: ${JSON.stringify(failReceipt)} Before returning it, set every passed boolean to the result actually observed and replace the example finding with concrete evidence.`,
    'For an authenticated target check, passed:true requires a successful matching invocation in this reviewer session. A parent summary, copied transcript result or readback of an earlier invocation is context only. If the exact invocation is denied by the active read-only policy, mark that criterion false in the first FAIL receipt and describe the denial; do not spend recovery passes progressively changing unsupported true values.',
    targetInstruction,
    ...(request.remote ? [
      `This target is remote: use mcp__${request.remote.source}__ssh_execute with server=${JSON.stringify(request.remote.server)} and cwd=${JSON.stringify(request.target)} exactly. A local path or another connector/server cannot prove this review.`,
    ] : []),
    `Use simple read-only inspection commands with their actual stdout. Every Git probe must start exactly with ${safeGit}; this neutralizes repository-configured filesystem, hook, pager, default-format and signature helpers. For example: ${safeGit} rev-parse HEAD. If -C is needed, place the exact static target path after --no-pager and before the subcommand. Only the closed metadata/search operations rev-parse, branch --show-current, merge-base, ls-files, grep without a pattern file, and non-patch log are accepted. Git status, diff, show and patch/stat log are not accepted because repository attributes and filters can execute helpers; inspect literal target files with direct target-bound read/cmp commands instead. Pipelines, scripts, computed verdicts and echoed constants are not accepted as inspection evidence. If an existing registered check cannot establish an inspection, preserve the gap and report that limitation; do not rewrite its criteria or obtain another reviewer to bypass it.`,
    'PASS requires every criterion to have passed=true and findings to be exactly []. FAIL requires a non-empty findings array of concrete strings consistent with the observed failed conditions or inspection limitation; each criterion passed value must still report its actual result. Never return an incomplete shorthand such as {"verdict":"FAIL"}. A substantiated FAIL is a completed review; it does not certify the parent’s deliverable or authorize a correction.',
    'Do not call update_plan or SubmitPlan. Complete this review in the current turn with its requested PASS or substantiated FAIL receipt.',
    'If the host reports only a receipt syntax, field or shape mismatch, immediately return the corrected JSON from the evidence already collected. Do not call a tool, repeat an inspection, re-register checks or reopen the review.',
    'Do not change the target, repair findings, weaken registered checks, recruit another reviewer solely to satisfy your own completion gate, or repeat external actions to manufacture a passing review. Preserve all authorization and credential boundaries.',
    'Return only the requested review JSON. Do not append a robb_objective_outcome comment; the host separately verifies delivery of this review. If inspection itself is unavailable, preserve that concrete limitation rather than inventing PASS or evidence.',
  ].join('\n');
}

function shellCommand(message: Message): string | undefined {
  return [message.toolInput?.command, message.toolInput?.cmd, message.toolInput?.script].find((value): value is string => typeof value === 'string');
}

function isShellTool(message: Message): boolean {
  return /(?:^|[_:.])(?:bash|shell|exec_command|ssh_execute|run_command)(?:$|[_:.])/i.test(message.toolName ?? '');
}

function reviewCommand(message: Message, request: DelegatedReviewRequest) {
  const command = shellCommand(message);
  if (command === undefined || !request.target
    || (!request.remote && !LOCAL_REVIEW_SHELL_TOOLS.has(message.toolName ?? ''))
    || (request.remote && (
    message.toolName !== `mcp__${request.remote.source}__ssh_execute`
    || message.toolInput?.server !== request.remote.server
    || message.toolInput?.cwd !== request.target
    || message.toolInput?.command !== command
  ))) return { safe: false, observesTarget: false, revisionProbe: false };
  return inspectReadOnlyReviewCommand(command, request.target,
    typeof message.toolInput?.cwd === 'string' ? message.toolInput.cwd : undefined);
}

function observationalTool(message: Message, request: DelegatedReviewRequest): boolean {
  if (!hasObjectiveSubstantiveToolResult(message) || COORDINATION.test(message.toolName ?? '') || isObjectiveCoordinationTool(message)
    || isObjectiveEvidenceInvalidatingMutation(message)
    || classifyToolNameMutationSemantics(message.toolName ?? '') === 'ambiguous-compound') return false;
  const command = shellCommand(message);
  if (command !== undefined) return reviewCommand(message, request).observesTarget;
  if (request.remote) return false;
  const { target } = request;
  if (!target) return false;
  if (!LOCAL_REVIEW_READ_TOOLS.has(message.toolName ?? '')) return false;
  return ['file_path', 'path', 'url', 'uri'].some(key => {
    const value = message.toolInput?.[key];
    if (typeof value !== 'string') return false;
    if (target.startsWith('/')) return value.startsWith('/') && (posix.normalize(value) === posix.normalize(target)
      || posix.normalize(value).startsWith(`${posix.normalize(target)}/`));
    try {
      const actual = new URL(value); const expected = new URL(target);
      return actual.origin === expected.origin && actual.pathname === expected.pathname && actual.search === expected.search;
    } catch { return false; }
  });
}

function observedRevision(message: Message, request: DelegatedReviewRequest): string | undefined {
  const command = shellCommand(message);
  if (!command || !reviewCommand(message, request).revisionProbe) return undefined;
  let text = message.toolResult ?? '';
  try {
    const envelope = JSON.parse(text);
    // The command's stdout only; echoed input/stderr/envelope metadata cannot
    // supply a requested commit that HEAD did not actually return.
    if (typeof envelope?.stdout !== 'string') return undefined;
    text = envelope.stdout;
  } catch { /* Native Bash returns plain stdout. */ }
  const hashes = [...new Set(text.split(/\r?\n/).filter(line => /^[a-f0-9]{7,40}$/i.test(line)).map(line => line.toLowerCase()))];
  return hashes.length === 1 ? hashes[0] : undefined;
}

const BUILTIN_TOOL_NAMES = new Map([
  ['bash', 'bash'], ['read', 'read'], ['write', 'write'], ['edit', 'edit'],
  ['find', 'find'], ['glob', 'glob'], ['grep', 'grep'], ['ls', 'ls'],
  ['webfetch', 'web_fetch'], ['web_fetch', 'web_fetch'],
  ['websearch', 'web_search'], ['web_search', 'web_search'],
]);

function canonicalToolName(name: string): string {
  const candidate = name.startsWith('functions.') ? name.slice('functions.'.length) : name;
  return BUILTIN_TOOL_NAMES.get(candidate.toLowerCase()) ?? name;
}

function atPath(value: unknown, path: string): unknown {
  const keys = completionCriterionPathKeys(path);
  if (!keys) return undefined;
  for (const key of keys) {
    // Criterion selectors support non-negative array indexes. Keep this
    // traversal identical to the primary acceptance evaluator: arrays are JSON
    // containers too, and Object.getOwnPropertyDescriptor safely reads their
    // own indexed properties without consulting prototypes or getters.
    if (!value || typeof value !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return undefined;
    value = descriptor.value;
  }
  return value;
}

function criterionInvocationMatches(criterion: ObjectiveAcceptanceCriterion, message: Message): boolean {
  return !!message.toolName && canonicalToolName(message.toolName) === canonicalToolName(criterion.toolName)
    && Object.entries(criterion.input).every(([path, expected]) => atPath(message.toolInput, path) === expected);
}

/**
 * An exact shell invocation is still opaque executable code. It becomes a
 * review observation only when the registered check binds an absolute cwd and
 * the closed reviewer grammar proves the command read-only for that target.
 */
function isBoundReadOnlyHostTargetCheck(criterion: ObjectiveAcceptanceCriterion, message: Message): boolean {
  if (!criterionInvocationMatches(criterion, message)
    || classifyToolNameMutationSemantics(message.toolName ?? '') === 'ambiguous-compound') return false;
  if (!isShellTool(message)) {
    if (!isHostReviewTargetCheckTool(criterion.toolName, criterion.input, undefined, true)) return false;
    return !isObjectiveEvidenceInvalidatingMutation(message);
  }
  if (!LOCAL_REVIEW_SHELL_TOOLS.has(message.toolName ?? '')
    && message.toolName !== 'mcp__rbw-servers__ssh_execute') return false;
  const command = shellCommand(message);
  const cwdBinding = Object.entries(criterion.input).find(([path]) => {
    const keys = completionCriterionPathKeys(path);
    return keys?.length === 1 && keys[0] === 'cwd';
  })?.[1];
  if (!command || typeof cwdBinding !== 'string' || !cwdBinding.startsWith('/')
    || message.toolInput?.cwd !== cwdBinding) return false;
  const inspection = inspectReadOnlyReviewCommand(command, cwdBinding, cwdBinding);
  return inspection.safe && inspection.observesTarget;
}

/** Persisted MCP attempts can say toolExecuted=true although policy rejected them before execution. */
function isExplicitHostPolicyRefusal(message: Message): boolean {
  if (message.toolStatus !== 'error' || !message.isError || isObjectiveToolExecutedSuccessfully(message)) return false;
  const result = message.toolResult ?? '';
  return /(?:MCP write operations are blocked in Explore|blocked \(Explore mode\)|operation denied by policy|high-stakes evidence gate)/i.test(result)
    || /is not in the read-only allowlist[\s\S]{0,2048}Effective mode:\s*Explore/i.test(result);
}

/**
 * A delegated review can be delivered with a negative verdict. This host
 * attestation is deliberately separate from the parent's PASS-only gate.
 * No saved objective/criterion, result, authorization or visible JSON is changed.
 */
export function validateDelegatedReviewCompletion(input: {
  parentSessionId?: string;
  sessionId?: string;
  objective: ActiveSessionObjective;
  messages: Message[];
  sourceSlugs?: readonly string[];
  finalMessage?: Message;
}): DelegatedReviewValidation | undefined {
  if (!input.parentSessionId || !input.objective.originalText) return undefined;
  const request = getDelegatedReviewRequest(
    input.objective.originalText,
    input.sourceSlugs,
    input.objective.delegatedRole,
  );
  if (!request) return undefined;
  const reject = (gap: string): DelegatedReviewValidation => ({ valid: false, state: 'continue', gaps: [gap] });
  const final = input.finalMessage;
  const roots = input.messages.filter(message => message.id === input.objective.userMessageId);
  const root = roots.length === 1 ? roots[0] : undefined;
  const rootIndex = root ? input.messages.indexOf(root) : -1;
  const finalIndex = final ? input.messages.findIndex(message => message.id === final.id) : -1;
  if (!final || final.role !== 'assistant' || final.isIntermediate || rootIndex < 0 || finalIndex <= rootIndex) return reject('The delegated review needs a final response in its own objective transcript');
  if (request.hostBound && (input.objective.delegatedRole !== 'reviewer'
    || root!.role !== 'user' || root!.hidden || root!.isQueued || root!.isPending
    || root!.internalOrigin?.kind !== 'spawned-session'
    || root!.internalOrigin.senderSessionId !== input.parentSessionId
    || root!.content !== input.objective.originalText)) return reject('The host review contract needs its authenticated root and delegating parent');
  const content = final.content.trim();
  if (content.length > 32_000) return reject('The delegated review receipt exceeds the size limit');
  let receipt: { verdict?: unknown; objectiveId?: unknown; acceptanceSha256?: unknown; criteria?: unknown; findings?: unknown };
  try { receipt = JSON.parse(content); } catch { return reject('Return the single requested review JSON object, without a second receipt or surrounding prose'); }
  if (!receipt || Array.isArray(receipt) || !['PASS', 'FAIL'].includes(String(receipt.verdict))
    || receipt.objectiveId !== request.objectiveId || receipt.acceptanceSha256 !== request.acceptanceSha256) return reject('The review verdict must retain the exact binding from the original delegated request');
  if (!Array.isArray(receipt.criteria) || receipt.criteria.length !== request.criteria.length
    || receipt.criteria.some(item => !item || typeof item.id !== 'string' || typeof item.passed !== 'boolean')
    || new Set(receipt.criteria.map(item => item.id)).size !== request.criteria.length
    || request.criteria.some(id => !(receipt.criteria as Array<{ id: string }>).some(item => item.id === id))) return reject('The review must report every requested criterion exactly once');
  const criteria = receipt.criteria as Array<{ id: string; passed: boolean }>;
  if (!Array.isArray(receipt.findings) || receipt.findings.length > 64
    || receipt.findings.some(item => typeof item !== 'string' || !item.trim() || item.length > 4_000
      || /^<.*>$/.test(item.trim())
      || /replace this example|example[_ -]?only/i.test(item))) return reject('Review findings must be bounded, concrete text rather than an example placeholder');
  const findings = receipt.findings as string[];
  if (receipt.verdict === 'PASS' ? findings.length > 0 || criteria.some(item => !item.passed)
    : findings.length === 0) return reject('The review verdict, criterion results and findings must agree');
  const scoped = input.messages.slice(rootIndex + 1, finalIndex);
  if (scoped.some(message => message.role === 'tool' && message.toolExecuted !== false && !COORDINATION.test(message.toolName ?? '')
    && isObjectiveEvidenceInvalidatingMutation(message)
    && !request.targetChecks?.some(criterion => criterionInvocationMatches(criterion, message)
      && (isExplicitHostPolicyRefusal(message) || isBoundReadOnlyHostTargetCheck(criterion, message))))) {
    return reject('A review with a target mutation requires the normal objective validation');
  }
  if (scoped.some(message => {
    if (message.role !== 'tool' || message.toolExecuted === false || message.toolCheckpoint !== undefined || COORDINATION.test(message.toolName ?? '')) return false;
    const command = shellCommand(message);
    if (command === undefined) return false;
    if (request.targetChecks) {
      if (!isShellTool(message)) return false;
      const targetCheck = request.targetChecks.find(criterion => criterionInvocationMatches(criterion, message));
      return !targetCheck || !isExplicitHostPolicyRefusal(message)
        && !isBoundReadOnlyHostTargetCheck(targetCheck, message);
    }
    return !reviewCommand(message, request).safe;
  })) return reject('An opaque or mutating shell command requires normal objective validation');
  // The final host envelope is already authenticated by the exact spawned root
  // above. Evaluate its immutable checks directly rather than asking the child
  // model to duplicate them with set_completion_criteria. Child registration
  // metadata is neither authority nor a prerequisite for these observations.
  const evidenceObjective = request.targetChecks ? {
    ...input.objective,
    acceptanceCriteria: structuredClone(request.targetChecks),
    acceptanceNeedsReview: false,
    acceptanceRevision: undefined,
    acceptanceRegisteredRevision: undefined,
    acceptanceRegisteredAt: input.objective.startedAt,
    acceptanceRegisteredAtById: Object.fromEntries(request.targetChecks.map(check => [
      check.id,
      input.objective.startedAt,
    ])),
  } : input.objective;
  const observations = collectObjectiveAcceptanceObservations(
    evidenceObjective, input.messages.slice(0, finalIndex), input.sessionId,
  )
    .filter(({ criterionId, message }) => request.targetChecks
      ? request.targetChecks.some(criterion => criterion.id === criterionId
        && isBoundReadOnlyHostTargetCheck(criterion, message))
      : observationalTool(message, request));
  if (!observations.length && !(receipt.verdict === 'FAIL' && request.targetChecks?.length)) {
    return reject('The review needs an observed invocation of a registered check on the requested target');
  }
  const expectedObservationCount = request.targetChecks?.length ?? input.objective.acceptanceCriteria?.length;
  if (receipt.verdict === 'PASS' && (observations.length !== expectedObservationCount || observations.some(item => !item.passed))) return reject('A passing review cannot certify a failed or unobserved registered check');
  const failedTargetEvidence: Message[] = [];
  if (receipt.verdict === 'FAIL' && request.targetChecks) {
    const observationById = new Map(observations.map(observation => [observation.criterionId, observation]));
    let observedTargetFailure = false;
    for (const targetCheck of request.targetChecks) {
      const reported = criteria.find(item => item.id === targetCheck.id)!;
      const observation = observationById.get(targetCheck.id);
      if (reported.passed) {
        if (!observation?.passed) return reject(`The review marks ${targetCheck.id} passed without a matching positive host observation`);
        continue;
      }
      if (observation && !observation.passed) {
        observedTargetFailure = true;
        continue;
      }
      // A failed exact invocation can substantiate that this review check was
      // unavailable. It cannot overturn an already positive business result.
      const failedAttempts = scoped.filter(message => criterionInvocationMatches(targetCheck, message)
        && message.role === 'tool' && message.toolExecuted !== false && message.toolCheckpoint === undefined
        && (message.toolStatus === 'error' || message.isError) && !!message.toolResult?.trim()
        && input.messages.filter(candidate => candidate.id === message.id).length === 1
        && (!message.toolUseId || input.messages.filter(candidate => candidate.toolUseId === message.toolUseId).length === 1));
      if (observation?.passed || !failedAttempts.length) {
        return reject(`The review marks ${targetCheck.id} failed without a matching negative result or failed exact invocation`);
      }
      failedTargetEvidence.push(...failedAttempts);
      observedTargetFailure = true;
    }
    if (!observedTargetFailure) return reject('A failing review needs at least one host-observed target failure');
  }
  if (request.revision && !request.targetChecks) {
    const revisions = observations.map(item => observedRevision(item.message, request)).filter((value): value is string => !!value);
    const observedExpected = revisions.some(value => value.startsWith(request.revision!.toLowerCase()));
    // A changed HEAD is a valid negative audit result, never proof that the
    // expected commit was reviewed. Require the observed revision in findings.
    const reportedMismatch = receipt.verdict === 'FAIL' && revisions.some(value => !value.startsWith(request.revision!.toLowerCase())
      && findings.some(finding => finding.toLowerCase().includes(value)));
    if (!observedExpected && !reportedMismatch) return reject('The requested revision must be observed, or its observed mismatch explicitly reported as FAIL');
  }
  const evidence = [...new Set([
    ...observations.flatMap(item => [item.message.id, ...(item.message.toolUseId ? [item.message.toolUseId] : [])]),
    ...failedTargetEvidence.flatMap(message => [message.id, ...(message.toolUseId ? [message.toolUseId] : [])]),
  ])];
  return { valid: true, state: 'complete_verified', gaps: [], declaration: {
    state: 'complete_verified', criteria: [{ id: 'delegated-review-delivered', satisfied: true, evidence: [...evidence, final.id] }], remainingWork: [], blocker: null,
  } };
}
