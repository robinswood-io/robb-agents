export type HighStakesEvidenceDomain = 'legal' | 'financial' | 'medical' | 'security';

export interface ObjectiveEvidenceGateState {
  objectiveId: string;
  domain: HighStakesEvidenceDomain;
  evidenceObserved: boolean;
  authoritativeEvidenceObserved: boolean;
  independentReviewObserved: boolean;
  independentReviewAttempted: boolean;
  lastReviewVerdict?: 'PASS' | 'FAIL';
  /** A later mutation makes any earlier review stale until it is repeated. */
  reviewInvalidatedByMutation?: boolean;
  lastMutationTool?: string;
}

export type ObjectiveEvidenceToolEffectKind =
  | 'read'
  | 'local-write'
  | 'external-mutation'
  | 'unknown';

const states = new Map<string, ObjectiveEvidenceGateState>();
const MUTATING_REQUEST_PATTERN = /\b(?:create|draft|write|change|modify|correct|implement|apply|publish|submit|deploy|delete|remove|sign|approve|cr[ée](?:e|er)|r[ée]dig\w*|[ée]cri\w*|fais\s+[ée]voluer|modifi\w*|corrig\w*|impl[ée]ment\w*|implant\w*|appliqu\w*|publi\w*|soumet\w*|d[ée]ploi\w*|supprim\w*|sign\w*|approuv\w*)\b/i;
const DOMAINS: Array<[HighStakesEvidenceDomain, RegExp]> = [
  ['legal', /\b(?:legal|law|juridique|droit|nda|non[- ]disclosure|contrat|contract|compliance|conformit[ée]|signature|notari[sz])\b/i],
  ['financial', /\b(?:financial|finance|accounting|comptab\w*|fiscal\w*|tax|imp[oô]t\w*|ledger|factur\w*|paiement\w*|payment\w*)\b/i],
  ['medical', /\b(?:medical|m[ée]dical|sant[ée]|patient|traitement|treatment|diagnostic\s+m[ée]dical)\b/i],
  ['security', /\b(?:cybersecurity|cybers[ée]curit[ée]|security|s[ée]curit[ée]|credential|secret|permission|rbac|vuln[ée]rabilit[ée])\b/i],
];
const EVIDENCE_TOOL_PATTERN = /(?:search|query|fetch|browser|read|open|download|source|research|(?:^|__|_)(?:get|list|inspect|status|check)(?:__|_|$))/i;
const REVIEW_TOOL_PATTERN = /(?:call_llm|spawn_session|wait_sessions|reviewer|review)/i;
const OFFICIAL_SOURCE_PATTERN = /(?:https?:\/\/[^\s"')]*(?:\.gov\b|\.gouv\.fr\b|\.gc\.ca\b|\.gov\.uk\b|europa\.eu\b|eur-lex\.europa\.eu\b|legifrance\.gouv\.fr\b|service-public\.fr\b|cnil\.fr\b|who\.int\b|sec\.gov\b|finra\.org\b|nist\.gov\b|owasp\.org\b)|\b(?:official|primary source|source primaire|source officielle|texte en vigueur|legifrance|eur-lex)\b)/i;
const FIRST_PARTY_DOMAIN_EVIDENCE: Record<HighStakesEvidenceDomain, RegExp> = {
  legal: OFFICIAL_SOURCE_PATTERN,
  financial: /(?:^|__)(?:inqom|sellsy|bank|banking|accounting|comptabilite)(?:__|_|$)|\b(?:ledger|grand livre|balance comptable|relev[ée] bancaire|journal comptable)\b/i,
  medical: /(?:^|__)(?:ehr|emr|patient-record|clinical-record)(?:__|_|$)|\b(?:dossier patient|clinical record)\b/i,
  security: /(?:^|__)(?:security|scanner|sast|dast|vulnerability)(?:__|_|$)|\b(?:scan report|rapport de scan|cve-\d{4}-\d+)\b/i,
};

export interface IndependentReviewReceipt {
  objectiveId?: string;
  acceptanceSha256?: string;
  verdict: 'PASS' | 'FAIL';
  criteria: Array<{ id: string; passed: boolean }>;
  findings: unknown[];
}

function jsonCandidates(result: string): string[] {
  const candidates = [result.trim()];
  for (const match of result.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  const firstBrace = result.indexOf('{');
  const lastBrace = result.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(result.slice(firstBrace, lastBrace + 1));
  return [...new Set(candidates)].filter(candidate => candidate.length <= 32_000);
}

export function parseIndependentReviewReceipt(result: string): IndependentReviewReceipt | undefined {
  for (const candidate of jsonCandidates(result)) {
    try {
      const value = JSON.parse(candidate) as Partial<IndependentReviewReceipt>;
      if (value.verdict !== 'PASS' && value.verdict !== 'FAIL') continue;
      if (!Array.isArray(value.criteria) || value.criteria.length === 0 || !Array.isArray(value.findings)) continue;
      const criteria = value.criteria.filter(item => (
        !!item && typeof item.id === 'string' && typeof item.passed === 'boolean'
      ));
      if (criteria.length !== value.criteria.length) continue;
      return { verdict: value.verdict, criteria, findings: value.findings,
        ...(typeof value.objectiveId === 'string' ? { objectiveId: value.objectiveId } : {}),
        ...(typeof value.acceptanceSha256 === 'string' ? { acceptanceSha256: value.acceptanceSha256 } : {}),
      };
    } catch {
      // Try the next bounded candidate.
    }
  }
  return undefined;
}

export function classifyHighStakesEvidenceDomain(text: string): HighStakesEvidenceDomain | undefined {
  if (!MUTATING_REQUEST_PATTERN.test(text)) return undefined;
  return DOMAINS.find(([, pattern]) => pattern.test(text))?.[0];
}

export function beginObjectiveEvidenceGate(
  sessionId: string,
  objectiveId: string,
  objectiveText: string,
): ObjectiveEvidenceGateState | undefined {
  const domain = classifyHighStakesEvidenceDomain(objectiveText);
  if (!domain) {
    states.delete(sessionId);
    return undefined;
  }
  const existing = states.get(sessionId);
  if (existing?.objectiveId === objectiveId) return existing;
  const state: ObjectiveEvidenceGateState = {
    objectiveId,
    domain,
    evidenceObserved: false,
    authoritativeEvidenceObserved: false,
    independentReviewObserved: false,
    independentReviewAttempted: false,
  };
  states.set(sessionId, state);
  return state;
}

export function recordObjectiveEvidence(
  sessionId: string,
  toolName: string,
  result: string,
  isError: boolean,
): void {
  const state = states.get(sessionId);
  if (!state || isError || result.trim().length < 40) return;
  if (EVIDENCE_TOOL_PATTERN.test(toolName)) {
    state.evidenceObserved = true;
    if (OFFICIAL_SOURCE_PATTERN.test(result) || FIRST_PARTY_DOMAIN_EVIDENCE[state.domain].test(`${toolName}\n${result}`)) {
      state.authoritativeEvidenceObserved = true;
    }
  }
  if (REVIEW_TOOL_PATTERN.test(toolName)) {
    state.independentReviewAttempted = true;
    state.reviewInvalidatedByMutation = false;
    state.lastMutationTool = undefined;
    const receipt = parseIndependentReviewReceipt(result);
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
  if (!state || effectKind === 'read') return { allowed: true };
  const sufficientEvidence = state.evidenceObserved && state.authoritativeEvidenceObserved;
  if (!sufficientEvidence) {
    return {
      allowed: false,
      reason: `High-stakes evidence gate: inspect a current authoritative or first-party ${state.domain} source before creating or materially changing the deliverable.`,
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
  if (!state.evidenceObserved) return 'authoritative evidence has not been inspected';
  if (!state.authoritativeEvidenceObserved) return `no authoritative or first-party ${state.domain} source was verified`;
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
