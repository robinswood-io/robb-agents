import { hasContextualMedicalTreatment, isDirectLegalDocumentMutation } from './mutation-classification.ts';
import { CLINICAL_SIGNAL_INSIDE_CLARIFICATION_PATTERN, DIRECT_MEDICAL_DOMAIN_PATTERN, ENGLISH_OPERATIONAL_TREATMENT_CLARIFICATION_PATTERN, FRENCH_OPERATIONAL_TREATMENT_CLARIFICATION_PATTERN, GENUINE_LEGAL_DELIVERABLE_PATTERN, NON_MEDICAL_CLARIFICATION_SUFFIX_PATTERN, NO_MEDICAL_SOURCE_AFTER_CLARIFICATION_PATTERN, OPERATIONAL_CONTRACT_LIFECYCLE_ACTION_PATTERN, OPERATIONAL_CONTRACT_LIFECYCLE_SUBJECT_PATTERN, OPERATIONAL_CONTRACT_LIFECYCLE_WORD_PATTERN, STANDALONE_OPERATIONAL_HEALTH_QUALIFIER_PATTERN, TECHNICAL_HEALTH_PHRASE_PATTERN, TECHNICAL_LIST_HEALTH_PATTERN } from './patterns.ts';

/**
 * A product incident can legitimately contain business nouns such as
 * “contrat”, “signature” and “e-doc” without asking the agent to interpret or
 * draft a legal instrument. Keep this deliberately conjunctive: both a
 * concrete technical substrate and an operational lifecycle action are
 * required, while any explicit legal/drafting signal wins.
 */
export function isOperationalTechnicalContractLifecycleObjective(text: string): boolean {
  const normalized = text.normalize('NFC');
  return OPERATIONAL_CONTRACT_LIFECYCLE_WORD_PATTERN.test(normalized)
    && OPERATIONAL_CONTRACT_LIFECYCLE_SUBJECT_PATTERN.test(normalized)
    && OPERATIONAL_CONTRACT_LIFECYCLE_ACTION_PATTERN.test(normalized)
    && !GENUINE_LEGAL_DELIVERABLE_PATTERN.test(normalized)
    && !isDirectLegalDocumentMutation(normalized);
}

function neutralizeExplicitOperationalTreatmentClarification(text: string): {
  text: string;
  matched: boolean;
} {
  const pattern = FRENCH_OPERATIONAL_TREATMENT_CLARIFICATION_PATTERN.test(text)
    ? FRENCH_OPERATIONAL_TREATMENT_CLARIFICATION_PATTERN
    : ENGLISH_OPERATIONAL_TREATMENT_CLARIFICATION_PATTERN.test(text)
      ? ENGLISH_OPERATIONAL_TREATMENT_CLARIFICATION_PATTERN
      : undefined;
  if (!pattern) return { text, matched: false };
  const matchedClarification = pattern.exec(text)?.[0];
  if (!matchedClarification) return { text, matched: false };
  const operationalClaim = matchedClarification.replace(NON_MEDICAL_CLARIFICATION_SUFFIX_PATTERN, ' ');
  if (DIRECT_MEDICAL_DOMAIN_PATTERN.test(operationalClaim)
    || CLINICAL_SIGNAL_INSIDE_CLARIFICATION_PATTERN.test(operationalClaim)
    || hasContextualMedicalTreatment(operationalClaim)) {
    return { text, matched: false };
  }
  const remainingText = text
    .replace(pattern, ' ')
    .replace(NO_MEDICAL_SOURCE_AFTER_CLARIFICATION_PATTERN, ' ');
  // A valid clarification only neutralizes its own operational statement. It
  // must never hide a separate clinical instruction that follows it.
  if (hasContextualMedicalTreatment(remainingText)) {
    return { text, matched: false };
  }
  return {
    text: remainingText,
    matched: true,
  };
}

/** Remove only the bounded clarification and its matching medical-source
 * negation. Callers must still classify every remaining instruction. */
export function stripExplicitNonMedicalOperationalTreatmentClarification(text: string): string | undefined {
  const neutralized = neutralizeExplicitOperationalTreatmentClarification(text.normalize('NFC'));
  return neutralized.matched ? neutralized.text : undefined;
}

export function normalizedMedicalEvidenceText(text: string): {
  text: string;
  explicitOperationalClarification: boolean;
} {
  const operationalClarification = neutralizeExplicitOperationalTreatmentClarification(text);
  const technicalHealthText = operationalClarification.text
    .replace(TECHNICAL_HEALTH_PHRASE_PATTERN, ' ')
    .replace(TECHNICAL_LIST_HEALTH_PATTERN, '$1 ');
  return {
    text: neutralizeOperationalVerificationHealth(technicalHealthText),
    explicitOperationalClarification: operationalClarification.matched,
  };
}

function neutralizeOperationalVerificationHealth(text: string): string {
  return text.replace(
    /(?:health|sant[ée]s?)/giu,
    (health, offset: number, source: string) => {
      const before = source.slice(Math.max(0, offset - 256), offset);
      const after = source.slice(offset + health.length, offset + health.length + 96);
      const sameClauseBefore = before.split(/[.!?;\n]/u).at(-1) ?? '';
      const sameClauseAfter = after.split(/[.!?;\n]/u)[0] ?? '';
      // Product nouns such as “health records/application” and their French
      // equivalents remain medical even inside a detailed deployment request.
      if (/(?:applications?|dossiers?)\s+(?:de\s+|d[’'])$/iu.test(before)
        || /^\s+(?:applications?|records?)(?![\p{L}\p{M}\p{N}_])/iu.test(after)) {
        return health;
      }
      const boundedVerification = /(?:v[ée]rifi\w*|verif\w*|valid\w*|check\w*)\b[^.!?;\n]{0,224}$/iu.test(before);
      const operationalNeighbor = /^\s*(?:,|et|and|puis|then)\s+(?:(?:(?:la|le|les|the)\s+)|l[’'])?(?:r[ée]visions?|revisions?|statuts?|statuses?|tests?|checks?|endpoints?|https|html|interfaces?|login|dashboard)(?![\p{L}\p{M}\p{N}_])/iu.test(after);
      const standaloneOperationalQualifier = STANDALONE_OPERATIONAL_HEALTH_QUALIFIER_PATTERN.test(after);
      // `interface` and `health` are both ambiguous human-domain words. Only
      // erase the latter when the same proposition also carries a positive,
      // unmistakably software/operations anchor. A growing blacklist of
      // hospital qualifiers would otherwise keep producing false negatives.
      const hasOperationalAnchor = /\b(?:r[ée]visions?\s+(?:d[ée]ploy[ée]es?|en\s+ex[ée]cution)|deployed\s+revisions?|runtime\s+revisions?|revisions?\s+(?:at\s+runtime|in\s+production)|d[ée]ploi\w*|deploy\w*|services?|bridges?|ponts?|workers?|daemons?|repositories|repos?|conteneurs?|containers?|apis?|endpoints?|https?|auth(?:entification)?|login|monitoring|web|html)\b/iu.test(
        `${sameClauseBefore} ${sameClauseAfter}`,
      );
      // “interface” is operational only while it remains unqualified. A
      // clinical/patient/telemedicine interface is itself medical evidence and
      // must not erase the preceding health signal merely because it appears
      // in a deployment-style verification list.
      const medicallyQualifiedNeighbor = /^\s*(?:,|et|and|puis|then)[^.!?;\n]{0,96}\b(?:clinique|clinical|m[ée]dical(?:e|es|s)?|medical|patients?|soins?|care|t[ée]l[ée]m[ée]decine|telemedicine|sant[ée]|health\s+records?)\b/iu.test(after);
      return boundedVerification && (operationalNeighbor || standaloneOperationalQualifier)
        && hasOperationalAnchor
        && !medicallyQualifiedNeighbor ? ' ' : health;
    },
  );
}

/** Whether the user explicitly corrected the narrow operational meaning while
 * leaving no independent clinical signal in the same message. This predicate
 * is suitable for migrating a stale persisted medical objective; it does not
 * itself prove that the earlier objective was non-medical. */
export function isExplicitNonMedicalOperationalTreatmentClarification(text: string): boolean {
  const normalized = normalizedMedicalEvidenceText(text.normalize('NFC'));
  return normalized.explicitOperationalClarification
    && !DIRECT_MEDICAL_DOMAIN_PATTERN.test(normalized.text)
    && !hasContextualMedicalTreatment(normalized.text);
}
