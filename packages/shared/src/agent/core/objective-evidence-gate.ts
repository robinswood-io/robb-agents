export type HighStakesEvidenceDomain = 'legal' | 'financial' | 'medical' | 'security';

export interface ObjectiveEvidenceGateState {
  objectiveId: string;
  domain: HighStakesEvidenceDomain;
  evidenceObserved: boolean;
  authoritativeEvidenceObserved: boolean;
  independentReviewObserved: boolean;
}

const states = new Map<string, ObjectiveEvidenceGateState>();
const MUTATING_REQUEST_PATTERN = /\b(?:create|draft|write|change|modify|correct|implement|apply|publish|submit|deploy|delete|remove|sign|approve|cr[ée](?:e|er)|r[ée]dig\w*|[ée]cri\w*|fais\s+[ée]voluer|modifi\w*|corrig\w*|impl[ée]ment\w*|implant\w*|appliqu\w*|publi\w*|soumet\w*|d[ée]ploi\w*|supprim\w*|sign\w*|approuv\w*)\b/i;
const DOMAINS: Array<[HighStakesEvidenceDomain, RegExp]> = [
  ['legal', /\b(?:legal|law|juridique|droit|nda|non[- ]disclosure|contrat|contract|compliance|conformit[ée]|signature|notari[sz])\b/i],
  ['financial', /\b(?:financial|finance|accounting|comptab|fiscal|tax|imp[oô]t|ledger|factur|paiement|payment)\b/i],
  ['medical', /\b(?:medical|m[ée]dical|sant[ée]|patient|traitement|treatment|diagnostic\s+m[ée]dical)\b/i],
  ['security', /\b(?:cybersecurity|cybers[ée]curit[ée]|security|s[ée]curit[ée]|credential|secret|permission|rbac|vuln[ée]rabilit[ée])\b/i],
];
const EVIDENCE_TOOL_PATTERN = /(?:search|query|fetch|browser|read|open|download|source|research)/i;
const REVIEW_TOOL_PATTERN = /(?:call_llm|spawn_session|wait_sessions|reviewer|review)/i;
const OFFICIAL_SOURCE_PATTERN = /(?:https?:\/\/[^\s"')]*(?:\.gov\b|\.gouv\.fr\b|\.gc\.ca\b|\.gov\.uk\b|europa\.eu\b|eur-lex\.europa\.eu\b|legifrance\.gouv\.fr\b|service-public\.fr\b|cnil\.fr\b|who\.int\b|sec\.gov\b|finra\.org\b|nist\.gov\b|owasp\.org\b)|\b(?:official|primary source|source primaire|source officielle|texte en vigueur|legifrance|eur-lex)\b)/i;

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
    if (OFFICIAL_SOURCE_PATTERN.test(result)) state.authoritativeEvidenceObserved = true;
  }
  if (REVIEW_TOOL_PATTERN.test(toolName)) state.independentReviewObserved = true;
}

export function isEvidenceAcquisitionTool(toolName: string): boolean {
  return EVIDENCE_TOOL_PATTERN.test(toolName) || REVIEW_TOOL_PATTERN.test(toolName);
}

export function checkObjectiveEvidenceBeforeMutation(
  sessionId: string,
  toolName: string,
): { allowed: true } | { allowed: false; reason: string } {
  const state = states.get(sessionId);
  if (!state || isEvidenceAcquisitionTool(toolName)) return { allowed: true };
  const sufficientEvidence = state.evidenceObserved
    && (state.domain !== 'legal' || state.authoritativeEvidenceObserved);
  if (sufficientEvidence) return { allowed: true };
  return {
    allowed: false,
    reason: state.domain === 'legal'
      ? 'High-stakes evidence gate: inspect a current primary or official legal source before creating or materially changing the deliverable.'
      : `High-stakes evidence gate: inspect current authoritative ${state.domain} evidence before creating or materially changing the deliverable.`,
  };
}

export function getObjectiveEvidenceCompletionGap(sessionId: string): string | undefined {
  const state = states.get(sessionId);
  if (!state) return undefined;
  if (!state.evidenceObserved) return 'authoritative evidence has not been inspected';
  if (state.domain === 'legal' && !state.authoritativeEvidenceObserved) {
    return 'no primary or official legal source was verified';
  }
  if (!state.independentReviewObserved) return 'independent review has not been completed';
  return undefined;
}

export function clearObjectiveEvidenceGate(sessionId: string): void {
  states.delete(sessionId);
}
