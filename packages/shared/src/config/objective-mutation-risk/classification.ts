import { detectHighStakesEvidenceDomain, isDirectLegalDocumentMutation } from "../../agent/core/objective-evidence-gate.ts";
import type { SourceSensitivity } from "../selection-provenance.ts";
import { authoritativeMutationMatches } from './authoritative-actions.ts';
import type { ObjectiveMutationRiskClassification } from './observation-text.ts';
import { isAuditedPnsPostgresReadOnlyCommand, neutralizeAuditedPnsPostgresReadOnlyProse } from './observation-text.ts';
import { DIRECT_RBAC_DOMAIN_PATTERN, EXPLICIT_READ_ONLY_PATTERN, FRENCH_PRODUCTION_PROMOTION_PATTERN, PRODUCTION_ENVIRONMENT_RISK_PATTERN, READ_ONLY_OPERATION_PATTERN, SENSITIVE_DOMAIN_PATTERN } from './patterns.ts';
import { scopedMutationRisk } from './scoped-risk.ts';

export interface ObjectiveMutationRiskContext {
  /** Current authority; context outside this text may supply a deictic target but not a stale command. */
  authorityText?: string;
  /** Host-classified source sensitivity. */
  routingSensitivity?: SourceSensitivity;
}

export function classifyObjectiveMutationRisk(
  text: string,
  context: ObjectiveMutationRiskContext = {},
): ObjectiveMutationRiskClassification {
  const authorityText = context.authorityText ?? text;
  const exactAuditedPnsPostgresReadOnly = isAuditedPnsPostgresReadOnlyCommand(authorityText);
  const normalizedAuthority = exactAuditedPnsPostgresReadOnly
    ? { text: authorityText, audited: true }
    : neutralizeAuditedPnsPostgresReadOnlyProse(authorityText);
  const routingAuthorityText = normalizedAuthority.text;
  const normalizedContextText = authorityText === text
    ? routingAuthorityText
    : neutralizeAuditedPnsPostgresReadOnlyProse(text).text;
  const auditedPnsPostgresReadOnly = exactAuditedPnsPostgresReadOnly
    || normalizedAuthority.audited;
  const productionEnvironmentRisk = PRODUCTION_ENVIRONMENT_RISK_PATTERN.test(text)
    || FRENCH_PRODUCTION_PROMOTION_PATTERN.test(text);
  const highStakesEvidenceDomain = detectHighStakesEvidenceDomain(text);
  const medicalDomainRisk = highStakesEvidenceDomain === 'medical';
  const legalDomainRisk = highStakesEvidenceDomain === 'legal';
  // Historical context can identify the legal subject of a deictic command,
  // but it must never manufacture current mutation authority. Bind the direct
  // mutation predicate to the same host-selected authority text as verbs.
  const directLegalDocumentMutation = isDirectLegalDocumentMutation(routingAuthorityText);
  const structuredSensitive = context.routingSensitivity === 'confidential'
    || context.routingSensitivity === 'restricted';
  const sensitiveDomain = SENSITIVE_DOMAIN_PATTERN.test(text)
    || DIRECT_RBAC_DOMAIN_PATTERN.test(text)
    || productionEnvironmentRisk
    || medicalDomainRisk
    || legalDomainRisk
    || directLegalDocumentMutation
    || structuredSensitive;
  const explicitReadOnly = EXPLICIT_READ_ONLY_PATTERN.test(routingAuthorityText);
  const readOnlyOperation = READ_ONLY_OPERATION_PATTERN.test(routingAuthorityText);
  const mutationMatches = exactAuditedPnsPostgresReadOnly
    ? []
    : authoritativeMutationMatches(routingAuthorityText, structuredSensitive);
  const mutationVerbPresent = mutationMatches.length > 0;
  // Read-only wording describes the audit/review step; it must never erase a
  // separate authoritative mutation elsewhere in the same request. Negated,
  // hypothetical, quoted and reported mutations are filtered per match above.
  const mutationRequested = mutationVerbPresent || directLegalDocumentMutation;
  const scopedRisks = mutationMatches.map(mutation => scopedMutationRisk(
    routingAuthorityText,
    mutation,
    sensitiveDomain,
    normalizedContextText,
    structuredSensitive,
    medicalDomainRisk,
  ));
  const highRisk = directLegalDocumentMutation
    || sensitiveDomain && scopedRisks.some(risk => risk.highRisk);
  const criticalRisk = highRisk && scopedRisks.some(risk => risk.criticalRisk);
  const readOnlyRisk = (auditedPnsPostgresReadOnly || sensitiveDomain
    && (explicitReadOnly || readOnlyOperation))
    && !highRisk;
  return { sensitiveDomain, mutationRequested, highRisk, criticalRisk, readOnlyRisk };
}
