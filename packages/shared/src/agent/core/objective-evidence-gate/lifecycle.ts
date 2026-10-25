import { classifyHighStakesEvidenceDomain } from './classification.ts';
import type { ObjectiveEvidenceGateAuthority, ObjectiveEvidenceGateState, ObjectiveEvidenceToolEffectKind } from './contracts.ts';
import type { IndependentReviewContext } from './review-receipts.ts';
import { WAIT_SESSIONS_TOOL_PATTERN, parseIndependentReviewReceipt } from './review-receipts.ts';
import { EVIDENCE_TOOL_PATTERN, FIRST_PARTY_SOURCE_TOOLS, REVIEW_TOOL_PATTERN, SOURCE_INSPECTION_TOOL_PATTERN, hasOfficialSourceUrl, objectiveBusinessSourceVendors, objectiveSecurityDocumentationProviders, sourceObservationSucceeded, targetsOfficialSource } from './sources.ts';

const states = new Map<string, ObjectiveEvidenceGateState>();

/** @deprecated Pass the persisted objective authority as the fourth argument. */
export function beginObjectiveEvidenceGate(
  sessionId: string,
  objectiveId: string,
  objectiveText: string,
): ObjectiveEvidenceGateState | undefined;

export function beginObjectiveEvidenceGate(
  sessionId: string,
  objectiveId: string,
  objectiveText: string,
  authority: ObjectiveEvidenceGateAuthority,
): ObjectiveEvidenceGateState | undefined;

export function beginObjectiveEvidenceGate(
  sessionId: string,
  objectiveId: string,
  objectiveText: string,
  authority?: ObjectiveEvidenceGateAuthority,
): ObjectiveEvidenceGateState | undefined {
  // Current hosts must supply persisted authority so negated/read-only prose
  // cannot activate the gate. Preserve the published three-argument overload's
  // conservative historical behavior for consumers that have not migrated:
  // it may over-block from prose, but must never silently lose a safety gate.
  if (authority && (authority.risk !== 'high-stakes'
    || authority.evidenceRequirement !== 'authoritative-sources-before-mutation'
    || !authority.domain || authority.domain === 'unspecified')) {
    states.delete(sessionId);
    return undefined;
  }
  // When the current host supplies persisted authority, never fall back to
  // free-form prose for its domain: negated or quoted sensitive words are not
  // authority. High-risk production work without an applicable evidence
  // subject still retains its permission and independent-review guards, but
  // must not enter an impossible unspecified-source gate.
  const domain = authority
    ? authority.domain ?? 'unspecified'
    : classifyHighStakesEvidenceDomain(objectiveText);
  if (!domain) {
    states.delete(sessionId);
    return undefined;
  }
  const businessSourceVendors = objectiveBusinessSourceVendors(objectiveText);
  const securityDocumentationProviders = domain === 'security'
    ? objectiveSecurityDocumentationProviders(objectiveText) : [];
  const existing = states.get(sessionId);
  if (existing?.objectiveId === objectiveId && existing.domain === domain
    && JSON.stringify(existing.businessSourceVendors ?? []) === JSON.stringify(businessSourceVendors)
    && JSON.stringify(existing.securityDocumentationProviders ?? []) === JSON.stringify(securityDocumentationProviders)) return existing;
  const state: ObjectiveEvidenceGateState = {
    objectiveId,
    domain,
    evidenceObserved: false,
    authoritativeEvidenceObserved: false,
    independentReviewObserved: false,
    independentReviewAttempted: false,
    ...(businessSourceVendors.length ? { businessSourceVendors } : {}),
    ...(securityDocumentationProviders.length ? { securityDocumentationProviders } : {}),
  };
  states.set(sessionId, state);
  return state;
}

export function recordObjectiveEvidence(
  sessionId: string,
  toolName: string,
  result: string,
  isError: boolean,
  reviewContext?: Omit<IndependentReviewContext, 'toolName'>,
  toolInput?: Record<string, unknown>,
): void {
  const state = states.get(sessionId);
  if (!state || isError || result.trim().length < 40) return;
  if (EVIDENCE_TOOL_PATTERN.test(toolName)) {
    state.evidenceObserved = true;
    // An unknown domain cannot safely select an authoritative source class.
    // Keep the gate closed until the host restores a specific domain rather
    // than letting an unrelated official URL satisfy a generic high-risk task.
    const officialSourceObserved = sourceObservationSucceeded(result)
      && state.domain !== 'unspecified' && (toolInput === undefined
      ? SOURCE_INSPECTION_TOOL_PATTERN.test(toolName)
        && hasOfficialSourceUrl(result, state.domain, state.businessSourceVendors ?? [], state.securityDocumentationProviders ?? [])
      : targetsOfficialSource(toolName, toolInput, state.domain, state.businessSourceVendors ?? [], state.securityDocumentationProviders ?? []));
    if (officialSourceObserved || FIRST_PARTY_SOURCE_TOOLS[state.domain]?.test(toolName)) {
      state.authoritativeEvidenceObserved = true;
    }
  }
  if (REVIEW_TOOL_PATTERN.test(toolName)) {
    state.independentReviewAttempted = true;
    state.reviewInvalidatedByMutation = false;
    state.lastMutationTool = undefined;
    const receipt = parseIndependentReviewReceipt(result, reviewContext
      ? { ...reviewContext, toolName }
      : WAIT_SESSIONS_TOOL_PATTERN.test(toolName)
        ? { toolName, objectiveId: state.objectiveId, acceptanceSha256: '' }
        : undefined);
    if (receipt) {
      state.lastReviewVerdict = receipt.verdict;
      state.independentReviewObserved = receipt.verdict === 'PASS'
        && receipt.criteria.every(criterion => criterion.passed)
        && receipt.findings.length === 0;
    }
  }
}

export function isEvidenceAcquisitionTool(toolName: string): boolean {
  return EVIDENCE_TOOL_PATTERN.test(toolName) || REVIEW_TOOL_PATTERN.test(toolName);
}

export function checkObjectiveEvidenceBeforeMutation(
  sessionId: string,
  toolName: string,
  effectKind: ObjectiveEvidenceToolEffectKind = 'unknown',
): { allowed: true } | { allowed: false; reason: string } {
  const state = states.get(sessionId);
  // Delivering an internal report changes the inbox, not the reviewed target.
  // Registering immutable checks changes the host's validation contract, not
  // the reviewed deliverable. Let its strict schema/immutability validator run
  // even when source evidence is still missing. Registration cannot satisfy
  // this gate or authorize the observation tool recorded in its arguments.
  // Their own permission checks still apply; another source's send/set tool
  // remains an external mutation and must invalidate the prior review.
  if (!state || effectKind === 'read'
    || /^(?:mcp__session__|session__)?(?:send_agent_message|set_completion_criteria|update_plan|wait_sessions)$/.test(toolName)) return { allowed: true };
  const sufficientEvidence = state.evidenceObserved && state.authoritativeEvidenceObserved;
  if (!sufficientEvidence) {
    const domain = state.domain === 'unspecified' ? 'applicable high-stakes' : state.domain;
    return {
      allowed: false,
      reason: `High-stakes evidence gate: inspect a current authoritative or first-party ${domain} source before creating or materially changing the deliverable.`,
    };
  }

  // This is deliberately conservative and happens when the host authorizes the
  // mutation attempt. If a later permission boundary or runtime error prevents
  // execution, requiring a fresh review is a safe false negative; retaining a
  // stale PASS after a possibly-applied mutation would be a false positive.
  state.independentReviewObserved = false;
  state.independentReviewAttempted = false;
  state.lastReviewVerdict = undefined;
  state.reviewInvalidatedByMutation = true;
  state.lastMutationTool = toolName;
  return { allowed: true };
}

export function getObjectiveEvidenceCompletionGap(sessionId: string): string | undefined {
  const state = states.get(sessionId);
  if (!state) return undefined;
  const domain = state.domain === 'unspecified' ? 'applicable high-stakes' : state.domain;
  if (!state.evidenceObserved) return 'authoritative evidence has not been inspected';
  if (!state.authoritativeEvidenceObserved) return `no authoritative or first-party ${domain} source was verified`;
  if (!state.independentReviewObserved) {
    if (state.reviewInvalidatedByMutation) {
      return `independent review must be repeated after subsequent mutation${state.lastMutationTool ? ` (${state.lastMutationTool})` : ''}`;
    }
    return state.independentReviewAttempted
      ? `independent review did not return a structured PASS receipt${state.lastReviewVerdict === 'FAIL' ? ' (latest verdict: FAIL)' : ''}`
      : 'independent review has not been completed';
  }
  return undefined;
}

export function clearObjectiveEvidenceGate(sessionId: string): void {
  states.delete(sessionId);
}
