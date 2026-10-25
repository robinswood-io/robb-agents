
export type HighStakesEvidenceDomain = 'legal' | 'financial' | 'medical' | 'security' | 'unspecified';

export type SecurityDocumentationProvider = 'docker' | 'github' | 'microsoft' | 'openai' | 'systemd';

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
  /** Narrow vendor bindings derived from the accepted objective text. */
  businessSourceVendors?: Array<'cerfrance' | 'silae'>;
  /** Provider documentation is authoritative only when the accepted objective
   * actually concerns that provider or runtime. */
  securityDocumentationProviders?: SecurityDocumentationProvider[];
}

/**
 * Host-owned objective authority. Free-form objective prose is untrusted input:
 * it may mention a forbidden high-stakes mutation while explicitly asking not
 * to perform it. The evidence gate therefore requires the persisted objective
 * contract to opt in before its narrower domain classifier is consulted.
 */
export interface ObjectiveEvidenceGateAuthority {
  risk: 'standard' | 'high-stakes';
  evidenceRequirement?: 'authoritative-sources-before-mutation';
  /** Host-derived from the latest applicable segment of the persisted contract. */
  domain?: HighStakesEvidenceDomain;
}

export type ObjectiveEvidenceToolEffectKind =
  | 'read'
  | 'local-write'
  | 'external-mutation'
  | 'unknown';
