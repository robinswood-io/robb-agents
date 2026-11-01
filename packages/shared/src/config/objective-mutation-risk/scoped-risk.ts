import { detectHighStakesEvidenceDomain, isDirectLegalDocumentMutation } from "../../agent/core/objective-evidence-gate.ts";
import { neutralizeNonCredentialObservationIdentifiers } from './observation-text.ts';
import { CONTEXTUAL_MEDICAL_MUTATION_PATTERN, CONTEXTUAL_MEDICAL_TARGET_PATTERN, CRITICAL_DOMAIN_PATTERN, DIRECT_RBAC_DOMAIN_PATTERN, DOCUMENTED_CREDENTIAL_POLICY_PATTERN, DOCUMENT_EDIT_MUTATION_PATTERN, DOCUMENT_SUMMARY_TARGET_PATTERN, DOCUMENT_TARGET_PATTERN, EXTERNAL_COMMUNICATION_MUTATION_PATTERN, FRENCH_PRODUCTION_PROMOTION_PATTERN, INTRINSIC_SENSITIVE_MUTATION_PATTERN, LINGUISTIC_EDIT_TARGET_PATTERN, LOCAL_ARTIFACT_EDIT_MUTATION_PATTERN, LOCAL_NON_OPERATIONAL_SENSITIVE_ARTIFACT_PATTERN, MUTATION_SCOPE_BOUNDARY_PATTERN, MUTATION_TARGET_PREVERBAL_PRONOUN_PATTERN, MUTATION_TARGET_PRONOUN_PATTERN, OPERATIONAL_SENSITIVE_EFFECT_PATTERN, PRODUCTION_ENVIRONMENT_RISK_PATTERN, SENSITIVE_DOMAIN_PATTERN, STRUCTURED_SENSITIVE_TARGET_PATTERN, hasLocallyBoundOperationalTreatmentTarget } from './patterns.ts';
import { boundedReferentContext, implicitPreverbalSensitiveTarget, mutationHasLocalTarget, plainConjunctionStartsAnotherOperation } from './scope-boundaries.ts';

export function scopedMutationRisk(
  authorityText: string,
  mutation: { index: number; length: number },
  sensitiveDomain: boolean,
  contextText: string,
  structuredSensitive: boolean,
  medicalDomain: boolean,
): { highRisk: boolean; criticalRisk: boolean } {
  let start = 0;
  let end = authorityText.length;
  for (const boundary of authorityText.matchAll(MUTATION_SCOPE_BOUNDARY_PATTERN)) {
    const boundaryIndex = boundary.index ?? 0;
    const boundaryEnd = boundaryIndex + boundary[0].length;
    if (boundaryEnd <= mutation.index) {
      start = boundaryEnd;
    } else if (boundaryIndex >= mutation.index + mutation.length) {
      const normalizedBoundary = boundary[0].trim().toLocaleLowerCase().replace(/^,\s*/, '');
      const tailStartsAnotherOperation = plainConjunctionStartsAnotherOperation(
        authorityText.slice(boundaryEnd),
      );
      // A sequencing adverb can modify the current verb ("Supprime ensuite le
      // compte") instead of introducing another operation. Keep its target in
      // the current scope unless the remainder actually starts a new action.
      if (['and', 'et', 'and then', 'then', 'puis', 'ensuite'].includes(normalizedBoundary)
        && !tailStartsAnotherOperation) {
        continue;
      }
      if (tailStartsAnotherOperation) {
        end = boundaryIndex;
        break;
      }
      // Newlines, semicolons and sentence punctuation can format the target
      // of the same command on a following line. Do not detach an incomplete
      // mutation from that target merely because prose punctuation intervenes.
      if (!mutationHasLocalTarget(authorityText.slice(
        mutation.index + mutation.length,
        boundaryIndex,
      ))) {
        continue;
      }
      end = boundaryIndex;
      break;
    }
  }
  const scope = authorityText.slice(start, end);
  const scopedRiskText = neutralizeNonCredentialObservationIdentifiers(scope);
  const mutationText = authorityText.slice(mutation.index, mutation.index + mutation.length);
  const beforeMutation = authorityText.slice(start, mutation.index);
  const after = authorityText.slice(mutation.index + mutation.length, end);
  const antecedent = authorityText.slice(Math.max(0, start - 180), start);
  // Runtime risk context puts the current direct turn first so it cannot be
  // truncated by history. A terse deictic mutation can therefore refer to a
  // sensitive objective immediately after its clause as well as before it.
  // Keep both ends of a bounded authenticated context. Long objectives often
  // place the concrete sensitive target after explanatory setup; a head-only
  // slice made "fix the reported issues" forget a trailing RBAC/credential
  // referent and silently lowered its safety tier.
  const referentContext = `${antecedent}\n${authorityText.slice(end, end + 180)}\n${boundedReferentContext(contextText)}`;
  const referentRiskContext = neutralizeNonCredentialObservationIdentifiers(referentContext);
  const implicitPreverbalTarget = implicitPreverbalSensitiveTarget(
    authorityText,
    start,
    beforeMutation,
    after,
  );
  const hasDeicticTarget = MUTATION_TARGET_PRONOUN_PATTERN.test(after)
    || MUTATION_TARGET_PREVERBAL_PRONOUN_PATTERN.test(beforeMutation);
  const targetReferentRiskContext = implicitPreverbalTarget
    ? neutralizeNonCredentialObservationIdentifiers(implicitPreverbalTarget)
    : referentRiskContext;
  const sensitiveAntecedent = (hasDeicticTarget || implicitPreverbalTarget !== undefined)
    && (SENSITIVE_DOMAIN_PATTERN.test(targetReferentRiskContext)
      || DIRECT_RBAC_DOMAIN_PATTERN.test(targetReferentRiskContext)
      || detectHighStakesEvidenceDomain(targetReferentRiskContext) !== undefined
      || PRODUCTION_ENVIRONMENT_RISK_PATTERN.test(targetReferentRiskContext));
  const productionEnvironmentRisk = PRODUCTION_ENVIRONMENT_RISK_PATTERN.test(scope)
    || FRENCH_PRODUCTION_PROMOTION_PATTERN.test(scope);
  const operationalTreatmentMutation = new RegExp(CONTEXTUAL_MEDICAL_MUTATION_PATTERN.source, 'iu').test(mutationText)
    && hasLocallyBoundOperationalTreatmentTarget(after);
  const medicalDomainRisk = !operationalTreatmentMutation
    && (detectHighStakesEvidenceDomain(scope) === 'medical'
      || medicalDomain && CONTEXTUAL_MEDICAL_TARGET_PATTERN.test(scope));
  const directLegalDocumentMutation = isDirectLegalDocumentMutation(scope);
  const targetBeforeQualifier = after.split(/\b(?:with|about|of|in|on|avec|sur|de|dans|concernant)\b/iu, 1)[0] ?? after;
  const documentTargetText = `${mutationText} ${targetBeforeQualifier}`;
  const explicitlyLinguisticEdit = LINGUISTIC_EDIT_TARGET_PATTERN.test(scope);
  const describesCredentialPolicy = DOCUMENT_SUMMARY_TARGET_PATTERN.test(scope)
    && DOCUMENTED_CREDENTIAL_POLICY_PATTERN.test(scope);
  const editsDocumentOnly = DOCUMENT_EDIT_MUTATION_PATTERN.test(mutationText)
    && DOCUMENT_TARGET_PATTERN.test(documentTargetText)
    && (explicitlyLinguisticEdit || describesCredentialPolicy || !CRITICAL_DOMAIN_PATTERN.test(scopedRiskText));
  const structuredSensitiveTarget = structuredSensitive
    && (STRUCTURED_SENSITIVE_TARGET_PATTERN.test(after) || hasDeicticTarget);
  // Merely notifying someone about a sensitive topic is still an external
  // mutation, but it is not the same as transferring a credential, payment,
  // or customer data. The longer transfer grammar above retains that tier.
  const communicationWithoutSensitivePayload = EXTERNAL_COMMUNICATION_MUTATION_PATTERN.test(mutationText)
    && !structuredSensitiveTarget && !directLegalDocumentMutation;
  // Sensitive vocabulary in a local parser, mock, fixture, UI field or type
  // definition is not itself an operational credential/payment/data action.
  // Keep real effects, confidential sources and production targets on the
  // sensitive tier while allowing Terra/Luna to handle bounded local code.
  const localNonOperationalSensitiveArtifact = !structuredSensitive
    && !productionEnvironmentRisk
    && !medicalDomainRisk
    && !DIRECT_RBAC_DOMAIN_PATTERN.test(scope)
    && LOCAL_ARTIFACT_EDIT_MUTATION_PATTERN.test(mutationText)
    && LOCAL_NON_OPERATIONAL_SENSITIVE_ARTIFACT_PATTERN.test(scope)
    && !OPERATIONAL_SENSITIVE_EFFECT_PATTERN.test(scope);
  const highRisk = !editsDocumentOnly && !communicationWithoutSensitivePayload
    && !localNonOperationalSensitiveArtifact && (
    SENSITIVE_DOMAIN_PATTERN.test(scopedRiskText)
      || DIRECT_RBAC_DOMAIN_PATTERN.test(scope)
      || directLegalDocumentMutation
      || medicalDomainRisk
      || productionEnvironmentRisk
      || (sensitiveDomain && INTRINSIC_SENSITIVE_MUTATION_PATTERN.test(mutationText))
      || sensitiveAntecedent
      || structuredSensitiveTarget
  );
  return {
    highRisk,
    criticalRisk: highRisk
      && (CRITICAL_DOMAIN_PATTERN.test(scopedRiskText)
        || (sensitiveAntecedent && CRITICAL_DOMAIN_PATTERN.test(targetReferentRiskContext))
        || productionEnvironmentRisk),
  };
}
