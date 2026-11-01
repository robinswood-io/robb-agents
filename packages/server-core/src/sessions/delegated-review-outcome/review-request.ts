import type { Message } from "@craft-agent/core/types";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { READ_ONLY_GIT_HARDENING_ARGS } from "@craft-agent/shared/agent/bash-validator";
import { Buffer } from "node:buffer";
import type { DelegatedReviewRequest } from './host-scope.ts';
import { HOST_DELEGATED_REVIEWER_PREFIX, HOST_REVIEW_CONTEXT_CLOSE, HOST_REVIEW_CONTEXT_OPEN, HOST_REVIEW_OPEN, hostParentReviewContract } from './host-scope.ts';
import { isBoundReadOnlyReviewScope, requestObjects, reviewTarget } from './review-target.ts';

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
  const bindings = objects.filter(value => typeof value["objectiveId"] === 'string' && /^[a-f0-9]{64}$/i.test(String(value["acceptanceSha256"])));
  const uniqueBindings = new Set(bindings.map(value => JSON.stringify([value["objectiveId"], value["acceptanceSha256"]])));
  if (uniqueBindings.size !== 1) return undefined;
  const templates = bindings.filter(value => ['PASS', 'FAIL', 'PASS|FAIL'].includes(String(value["verdict"])) && Array.isArray(value["criteria"]));
  if (!templates.length) return undefined;
  const criteria = (templates[0]!["criteria"] as unknown[]).map(item => (item as { id?: unknown })?.id);
  if (!criteria.length || criteria.length > 32 || criteria.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,127}$/.test(id))
    || new Set(criteria).size !== criteria.length
    || templates.some(value => JSON.stringify((value["criteria"] as Array<{ id: string }>).map(item => item?.id)) !== JSON.stringify(criteria))) return undefined;
  // A concrete target must be part of the task itself. A binding/hash alone
  // cannot turn an arbitrary tool invocation into an audit of a real resource.
  const target = reviewTarget(text, sourceSlugs);
  if (!target) return undefined;
  const folded = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const revision = /\b(?:commit|HEAD(?:\s+(?:attendu|exactement|vaut|doit\s+valoir))?)\s*[:=]?\s*(?:[A-Z][A-Z0-9_-]*\s+)?([a-f0-9]{7,40})\b/i.exec(folded)?.[1];
  return { objectiveId: String(bindings[0]!["objectiveId"]), acceptanceSha256: String(bindings[0]!["acceptanceSha256"]), criteria: criteria as string[], ...target, ...(revision ? { revision } : {}) };
}

/** Replace only the objective-contract paragraph for this qualified child task. */
export function buildDelegatedReviewPrompt(input: {
  parentSessionId?: string | undefined;
  objective: ActiveSessionObjective;
  sourceSlugs?: readonly string[] | undefined;
  messages?: readonly Message[] | undefined;
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
    `Use simple read-only inspection commands with their actual stdout. Never use inline interpreters (python3 -c, node -e, bash -c); use Read or simple read-only commands (cat, head, tail, wc, stat, ls, cmp -s, diff, shasum -a 256, sed -n) with explicit target paths. Every Git probe must start exactly with ${safeGit}; this neutralizes repository-configured filesystem, hook, pager, default-format and signature helpers. For example: ${safeGit} rev-parse HEAD. If -C is needed, place the exact static target path after --no-pager and before the subcommand. Only the closed metadata/search operations rev-parse, branch --show-current, merge-base, ls-files, grep without a pattern file, and non-patch log are accepted. Git status, diff, show and patch/stat log are not accepted because repository attributes and filters can execute helpers; inspect literal target files with direct target-bound read/cmp commands instead. Pipelines, scripts, computed verdicts and echoed constants are not accepted as inspection evidence. If an existing registered check cannot establish an inspection, preserve the gap and report that limitation; do not rewrite its criteria or obtain another reviewer to bypass it.`,
    'PASS requires every criterion to have passed=true and findings to be exactly []. FAIL requires a non-empty findings array of concrete strings consistent with the observed failed conditions or inspection limitation; each criterion passed value must still report its actual result. Never return an incomplete shorthand such as {"verdict":"FAIL"}. A substantiated FAIL is a completed review; it does not certify the parent’s deliverable or authorize a correction.',
    'Do not call update_plan or SubmitPlan. Complete this review in the current turn with its requested PASS or substantiated FAIL receipt.',
    'If the host reports only a receipt syntax, field or shape mismatch, immediately return the corrected JSON from the evidence already collected. Do not call a tool, repeat an inspection, re-register checks or reopen the review.',
    'Do not change the target, repair findings, weaken registered checks, recruit another reviewer solely to satisfy your own completion gate, or repeat external actions to manufacture a passing review. Preserve all authorization and credential boundaries.',
    'Return only the requested review JSON. Do not append a robb_objective_outcome comment; the host separately verifies delivery of this review. If inspection itself is unavailable, preserve that concrete limitation rather than inventing PASS or evidence.',
  ].join('\n');
}
