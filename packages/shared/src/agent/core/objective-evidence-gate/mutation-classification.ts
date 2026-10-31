import { hasAuthoritativeMutationPattern } from './mutation-negations.ts';
import { CLINICAL_CONDITION_PATTERN, CLINICAL_TREATMENT_DOSAGE_PATTERN, CLINICAL_TREATMENT_MODALITY_PATTERN, CLINICAL_TREATMENT_PRESCRIPTION_PATTERN, CLINICAL_TREATMENT_QUALIFIER_PATTERN, DIRECT_CLINICAL_DOSAGE_MANAGEMENT_PATTERN, DIRECT_CLINICAL_MANAGEMENT_PATTERN, DIRECT_CLINICAL_MEDICATION_TRANSITION_PATTERN, DIRECT_CLINICAL_MUTATION_ACTION_PATTERN, DIRECT_CLINICAL_NAMED_PERSON_ACTION_PATTERN, DIRECT_CLINICAL_PATIENT_ADMINISTRATION_PATTERN, DIRECT_CLINICAL_PATIENT_CARE_PATTERN, DIRECT_CLINICAL_PATIENT_MEDICATION_MANAGEMENT_PATTERN, DIRECT_CLINICAL_PRESCRIPTION_MANAGEMENT_PATTERN, DIRECT_CLINICAL_PRESCRIPTION_PATTERN, DIRECT_CLINICAL_PROCEDURE_PATTERN, DIRECT_COMMITTING_DOCUMENT_MUTATION_PATTERN, DIRECT_CONTRACT_OR_AGREEMENT_MUTATION_PATTERN, DIRECT_QUALIFIED_LEGAL_DOCUMENT_MUTATION_PATTERN, DIRECT_REFERENTIAL_LEGAL_MUTATION_PATTERN, DIRECT_TARGET_FIRST_COMMITTING_DOCUMENT_MUTATION_PATTERN, DIRECT_TARGET_FIRST_COMMITTING_DOCUMENT_PASSIVE_PATTERN, DIRECT_TARGET_FIRST_LEGAL_MUTATION_PATTERN, DIRECT_TARGET_FIRST_LEGAL_PASSIVE_MUTATION_PATTERN, EXPLICIT_TREATMENT_SUBJECT_TAIL_PATTERN, MEDICAL_TREATMENT_OCCURRENCE_PATTERN, MEDICAL_TREATMENT_PATTERN, TECHNICAL_CONTRACT_PATTERN, UNIVERSALLY_NEGATED_LEGAL_EFFECT_PATTERN } from './patterns.ts';

export function isDirectLegalDocumentMutation(text: string): boolean {
  const normalized = text.normalize('NFC')
    .replace(UNIVERSALLY_NEGATED_LEGAL_EFFECT_PATTERN, ' ')
    .replace(TECHNICAL_CONTRACT_PATTERN, ' ');
  return [
    DIRECT_CONTRACT_OR_AGREEMENT_MUTATION_PATTERN,
    DIRECT_QUALIFIED_LEGAL_DOCUMENT_MUTATION_PATTERN,
    DIRECT_COMMITTING_DOCUMENT_MUTATION_PATTERN,
    DIRECT_TARGET_FIRST_LEGAL_MUTATION_PATTERN,
    DIRECT_REFERENTIAL_LEGAL_MUTATION_PATTERN,
    DIRECT_TARGET_FIRST_COMMITTING_DOCUMENT_MUTATION_PATTERN,
    DIRECT_TARGET_FIRST_LEGAL_PASSIVE_MUTATION_PATTERN,
    DIRECT_TARGET_FIRST_COMMITTING_DOCUMENT_PASSIVE_PATTERN,
  ].some(pattern => hasAuthoritativeMutationPattern(normalized, pattern));
}

export function hasContextualMedicalTreatment(text: string): boolean {
  if (DIRECT_CLINICAL_NAMED_PERSON_ACTION_PATTERN.test(text)
    || DIRECT_CLINICAL_MEDICATION_TRANSITION_PATTERN.test(text)) return true;
  const folded = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (DIRECT_CLINICAL_DOSAGE_MANAGEMENT_PATTERN.test(folded)
    || DIRECT_CLINICAL_PRESCRIPTION_MANAGEMENT_PATTERN.test(folded)
    || DIRECT_CLINICAL_PRESCRIPTION_PATTERN.test(folded)
    || DIRECT_CLINICAL_PATIENT_MEDICATION_MANAGEMENT_PATTERN.test(folded)
    || DIRECT_CLINICAL_PATIENT_CARE_PATTERN.test(folded)
    || /\b(?:giv(?:e|es|ing|en)|gave|donn(?:er|e(?:s|z)?|ons?|e(?:e|es|s)?))\b/i.test(folded)
      && DIRECT_CLINICAL_PATIENT_ADMINISTRATION_PATTERN.test(folded)) {
    return true;
  }
  const clauses = folded.split(/[.!?;\n]+/);
  return clauses.some((clause, clauseIndex) => {
    const directClinicalTarget = DIRECT_CLINICAL_MANAGEMENT_PATTERN.exec(clause);
    if (directClinicalTarget) {
      const tail = clause.slice((directClinicalTarget.index ?? 0) + directClinicalTarget[0].length);
      // Clinical nouns do not turn an inventory/batch/pipeline operation into
      // a medical objective merely by appearing next to it.
      if (!/^\s+(?:inventor(?:y|ies)|stocks?|lots?|batch(?:es)?|pipelines?|apis?|data|donn[ée]es?|files?|fichiers?)\b/i.test(tail)) {
        return true;
      }
    }
    const directClinicalProcedure = DIRECT_CLINICAL_PROCEDURE_PATTERN.exec(clause);
    if (directClinicalProcedure) {
      const tail = clause.slice((directClinicalProcedure.index ?? 0) + directClinicalProcedure[0].length);
      if (!/^\s+(?:inventor(?:y|ies)|stocks?|lots?|batch(?:es)?|pipelines?|apis?|data|donn[ée]es?|files?|fichiers?|updates?|mises?\s+[àa]\s+jour)\b/i.test(tail)) {
        return true;
      }
    }
    if (!MEDICAL_TREATMENT_PATTERN.test(clause)) return false;
    for (const match of clause.matchAll(MEDICAL_TREATMENT_OCCURRENCE_PATTERN)) {
      const treatmentStart = match.index;
      const treatmentEnd = treatmentStart + match[0].length;
      const treatmentTail = clause.slice(treatmentEnd);
      const hasExplicitSubjectTail = EXPLICIT_TREATMENT_SUBJECT_TAIL_PATTERN.test(treatmentTail);
      const nearbyContext = clause.slice(
        Math.max(0, treatmentStart - 96),
        treatmentEnd + 96,
      );
      if (CLINICAL_TREATMENT_MODALITY_PATTERN.test(nearbyContext)) return true;
      if (CLINICAL_CONDITION_PATTERN.test(nearbyContext)) return true;

      // A diagnosis or other closed clinical subject may appear in the
      // immediately adjacent sentence of the same request, but it must not
      // retarget an explicit business/material complement in this clause.
      if (!hasExplicitSubjectTail) {
        const adjacentClinicalContext = [
          clauses[clauseIndex - 1] ?? '',
          clauses[clauseIndex + 1] ?? '',
        ].join(' ');
        if (CLINICAL_CONDITION_PATTERN.test(adjacentClinicalContext)) return true;
      }

      // Prescription/dosage/pharmaceutical vocabulary is clinical only when
      // it forms a closed treatment phrase. If “traitement” has an explicit
      // business/material subject, those words cannot promote it by themselves.
      if (!hasExplicitSubjectTail && (
        CLINICAL_TREATMENT_DOSAGE_PATTERN.test(clause)
        || CLINICAL_TREATMENT_QUALIFIER_PATTERN.test(nearbyContext)
        || CLINICAL_TREATMENT_PRESCRIPTION_PATTERN.test(nearbyContext)
      )) return true;
    }
    return false;
  });
}

export function hasAuthoritativeDirectClinicalMutation(text: string): boolean {
  return hasAuthoritativeMutationPattern(text, DIRECT_CLINICAL_MUTATION_ACTION_PATTERN, 'clinical');
}
