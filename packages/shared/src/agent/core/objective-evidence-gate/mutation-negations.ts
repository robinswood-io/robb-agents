import { ANY_ENGLISH_CLINICAL_ACTION_PATTERN, BARE_ENGLISH_CLINICAL_ACTION_PATTERN, DIRECT_CLINICAL_LOCAL_MEDICATION_PATTERN, DIRECT_CLINICAL_LOCAL_NAMED_PERSON_PATTERN, DIRECT_CLINICAL_LOCAL_PROCEDURE_PATTERN, DIRECT_CLINICAL_LOCAL_TRANSITION_PATTERN, DIRECT_CLINICAL_PATIENT_ADMINISTRATION_PATTERN, DIRECT_CLINICAL_PATIENT_CARE_ACTION_PATTERN, DIRECT_CLINICAL_PATIENT_PROCEDURE_PATTERN, DIRECT_CLINICAL_PROCEDURE_ACTION_ONLY_PATTERN, DIRECT_CLINICAL_TREATMENT_ACTION_PATTERN } from './patterns.ts';

/** The legacy evidence-domain helper predates the host authority classifier.
 * Keep its new clinical verbs request-shaped so a negation, question, quote or
 * reported recommendation cannot manufacture mutation authority. */
export function hasAuthoritativeMutationPattern(
  text: string,
  pattern: RegExp,
  family?: 'clinical',
): boolean {
  const matcher = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  for (const match of text.matchAll(matcher)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const before = text.slice(Math.max(0, index - 180), index);
    const after = text.slice(index + match[0].length, index + match[0].length + 180);
    const negated = /(?:\bdo\s+not|\bdon['’]t|\bnever|\b(?:must|should)(?:\s+not|n['’]t)(?:\s+be)?|\b(?:is|are|was|were)\s+not\s+to(?:\s+be)?|\bwithout|\bsans|\bne\s+pas|\bne\s+jamais|\bn['’]\s*)\s*$/iu.test(before)
      || /(?:\bne|\bn['’])(?:\s+[\p{L}\p{N}'’_-]+){0,4}\s*$/iu.test(before)
        && /^\s+(?:pas|jamais|plus)\b/iu.test(after);
    const directSecondPersonRequest = /(?:\b(?:could|can|would|will)\s+you|\b(?:peux|pourrais)-tu|\b(?:pouvez|pourriez)-vous)\s*$/iu.test(before);
    const informationalQuestionLead = /\bhow\s+(?:(?:do|does|did|can|could|would|should|may|might)\s+(?:i|we|you|one|they|he|she|someone)|to)\s*$/iu.test(before);
    const frenchDecisionQuestionLead = /(?:est-ce\s+que\s+)?(?:je|nous|on)\s+(?:dois|devrais|puis|pourrais|devons|devrions|pouvons|pourrions)\s*$/iu.test(before);
    const question = /\?\s*$/u.test(text.trim()) && (
      informationalQuestionLead
      || frenchDecisionQuestionLead
      || !directSecondPersonRequest && (
        /(?:\b(?:should|could|would|can)\s+[^.!?;\n]{1,120}|\b(?:when|whether)\b[^.!?;\n]{0,120}|\b(?:comment|pourquoi|quand|si|faut-il|devrait-on|peut-on|doit-on|dois-je|devrais-je|puis-je|pourrais-je|pouvons-nous|devrions-nous)\b[^.!?;\n]{0,120})\s*$/iu.test(before)
        || before.trim().length === 0
      )
    );
    const reported = /(?:\b(?:report|document|doctor|physician|clinician|polic(?:y|ies)|procedures?|protocols?)s?\b[^.!?;\n]{0,120}\b(?:says?|states?|recommends?|suggests?|mentions?|requires?|mandates?|directs?)\s*(?::|to|that)?\s*(?:(?:the\s+)?(?:admins?|administrators?|nurses?|doctors?|staff)\s+to\s+)?|\b(?:rapport|document|m[ée]decin|docteur|clinicien|politique|proc[ée]dure|protocole|r[èe]gle)s?\b[^.!?;\n]{0,120}\b(?:dit|indique|recommande|sugg[èe]re|mentionne|exige|impose|ordonne|pr[ée]voit)\s*(?::|de|d['’]|que)?\s*)$/iu.test(before);
    const governedByReportedStatement = /(?:^|[.!?;\n])\s*(?:(?:(?:the|this|that|a)\s+)?(?:plan|document|report|text|message|instruction|requirement|guide|polic(?:y|ies)|procedures?|protocols?)s?\s+(?:that\s+)?(?:says?|said|states?|mentions?|recommends?|proposes?|suggests?|requires?|mandates?|directs?)|(?:(?:le|ce|cet|cette|un|une|la)\s+)?(?:plan|document|documentation|rapport|texte|message|consigne|instruction|exigence|guide|politique|proc[ée]dure|protocole|r[èe]gle)s?\s+(?:qui\s+)?(?:dit|indique|mentionne|recommande|propose|sugg[èe]re|pr[ée]voit|exige|impose|ordonne))\b[^.!?;\n]{0,180}$/iu.test(before);
    const documentaryHowTo = /(?:^|[.!?;\n])\s*(?:(?:(?:could|can|would)\s+you|(?:peux|pourrais)-tu|(?:pouvez|pourriez)-vous)\s+)?(?:document(?:e|ez|er)|d[ée]cri(?:s|vez|re)|expliqu(?:e|ez|er)|r[ée]dig(?:e|ez|er)|write|draft|document|describe|explain)\b[^.!?;\n]{0,100}\b(?:comment|how\s+to|la\s+mani[èe]re\s+(?:de\s+|d['’]\s*)|l['’]option\s+de)\s*$/iu.test(before);
    const governedPlanningOrDesign = /(?:^|[.!?;\n])\s*(?:(?:draft|write|create|show|review|explain|r[ée]dig(?:e|ez|er)|cr[ée](?:e|ez|er)|affich(?:e|ez|er)|montre|analyse|expliqu(?:e|ez|er))\b[^.!?;\n]{0,120}\b(?:plans?\s+(?:to|pour)|mockups?\s+(?:of|for)|maquettes?\s+(?:du|de\s+la|des)|boutons?\s+(?:pour|de|du)|options?\s+(?:to|de)|whether\s+(?:we\s+)?should|s['’]il\s+faut)\s*|(?:je\s+veux\s+savoir|i\s+want\s+to\s+know)\b[^.!?;\n]{0,80}\b(?:s['’]il\s+faut|whether\s+(?:we\s+)?should)\s*)$/iu.test(before);
    const governedMockupButton = /(?:^|[.!?;\n])\s*(?:show|create|cr[ée](?:e|ez|er)|affich(?:e|ez|er)|montre)\b[^.!?;\n]{0,120}\b(?:mockups?|maquettes?)\b[^.!?;\n]{0,80}\b(?:buttons?|boutons?)\b/iu.test(`${before} ${after}`);
    const politeDocumentaryHowTo = /(?:^|[.!?;\n])\s*(?:please|kindly)\s+(?:document|describe|explain)\b[^.!?;\n]{0,100}\bhow\s+to\s*$/iu.test(before);
    const analyticalIndirectMutation = /(?:^|[.!?;\n])\s*(?:(?:please|kindly)\s+|merci\s+d['’]?\s*)?(?:analy[sz]e|analys(?:e|er|ez|ons)|review|explain|evaluate|assess|[ée]valu(?:e|er|ez|ons))\b[^.!?;\n]{0,120}\b(?:whether\s+to|how\s+to|comment|s['’]il\s+faut)\s*$/iu.test(before);
    const negatedAnalyticalIndirectMutation = /(?:^|[.!?;\n])\s*(?:(?:do\s+not|don['’]t|never)\s+(?:analy[sz]e|review|explain|evaluate|assess)|(?:ne\s+|n['’]\s*)(?:analys(?:e|er|ez|ons)|revois|expliqu(?:e|er|ez|ons)|[ée]valu(?:e|er|ez|ons))\s+(?:pas|jamais))\b[^.!?;\n]{0,120}\b(?:whether\s+to|how\s+to|comment|s['’]il\s+faut)\s*$/iu.test(before);
    const quotePairs: Array<readonly [string, string]> = [['"', '"'], ['“', '”'], ['«', '»'], ['`', '`']];
    const quoted = quotePairs.some(([open, close]) => {
      const opening = text.lastIndexOf(open, index - 1);
      if (opening < 0) return false;
      const closingBefore = text.lastIndexOf(close, index - 1);
      const closingAfter = text.indexOf(close, index + match[0].length);
      return (open === close ? text.slice(0, index).split(open).length % 2 === 0 : opening > closingBefore)
        && closingAfter >= index + match[0].length;
    });
    const action = match[0];
    const inflectedSensitiveEnglishAction = (
      ANY_ENGLISH_CLINICAL_ACTION_PATTERN.test(action)
      && !BARE_ENGLISH_CLINICAL_ACTION_PATTERN.test(action)
    ) || /^(?:(?:assign|invit|demot|disabl|enabl|activat|deactivat|suspend|includ|exclud|transfer|convert|provid|allow|authoriz|promot|grant|revok|remov|appoint|elevat|nam|add)(?:s|es|ed|d|ing)|chang(?:es|ed|ing)|den(?:ies|ied|ying)|permits|permitted|permitting|gives|giving|given|gave|makes|making|made)$/iu.test(action);
    const frenchImperativeContext = /^suspends$/iu.test(action)
      && /^\s+(?:(?:le|la|les|un|une)\s+|l['’]\s*)/iu.test(after);
    const inflectedActionRequestLead = /\b(?:start|continue|keep|begin|please|then)\s*$/iu.test(before);
    const explicitSubjectBefore = before.split(/[.!?;\n]/u).at(-1)?.trim() ?? '';
    const frenchThirdPersonSensitiveAction = /^(?:attribue|assigne|ajoute|donne|accorde|octroie|r[ée]voque|retire|supprime|active|d[ée]sactive|suspend|autorise|interdit|refuse|permet|transf[èe]re|invite|r[ée]trograde|inclue|exclue|change|convertit|met|nomme|promeut|d[ée]signe|[ée]l[èe]ve|rend|adapte|ajuste|prescrit|r[ée]duit|diminue|baisse|passe|augmente|commence|initie|titre|double|divise|remplace|substitue|s[èe]vre|interrompt|reprend|red[ée]marre|renouvelle|transitionne|cesse|arr[êe]te|administre|injecte|perfuse|donne|ordonne|vaccine|immunise|inocule|intube|extube|transfuse|biopsie|pose|effectue|r[ée]alise|pratique|op[èe]re|planifie|programme|fait)$/iu.test(action)
      || /ent$/iu.test(action) && (
        DIRECT_CLINICAL_TREATMENT_ACTION_PATTERN.test(action)
        || DIRECT_CLINICAL_PROCEDURE_ACTION_ONLY_PATTERN.test(action)
        || DIRECT_CLINICAL_PATIENT_CARE_ACTION_PATTERN.test(action)
      );
    const englishRoleOrPronounSubject = /^(?:(?:the|a|an)\s+(?:doctor|physician|clinician|nurse|surgeon|manager|administrator|operator|technician)|(?:he|she|they))$/iu.test(explicitSubjectBefore);
    const frenchNominalOrPronounSubject = frenchThirdPersonSensitiveAction
      && /^(?:(?:le|la|l['’]|un|une|ce|cet|cette)\s+[\p{L}\p{M}'’_-]+(?:\s+[\p{L}\p{M}'’_-]+){0,2}|il|elle|ils|elles)$/iu.test(explicitSubjectBefore);
    const namedFrenchSubject = frenchThirdPersonSensitiveAction
      && /^(?!(?:Puis|Ensuite|Maintenant|Veuillez|Merci|Enfin|Alors|Please|Kindly|Then|Now)$)[A-ZÀ-ÖØ-Þ][\p{L}\p{M}'’_-]+(?:\s+[A-ZÀ-ÖØ-Þ][\p{L}\p{M}'’_-]+)?$/u.test(explicitSubjectBefore);
    const namedEnglishSubject = /^(?:set|put)$/iu.test(action)
      && /^(?!(?:Please|Then|Now|Kindly)$)[A-Z][\p{L}\p{M}'’_-]+(?:\s+[A-Z][\p{L}\p{M}'’_-]+)?$/u.test(explicitSubjectBefore);
    const passiveSensitiveEnglishAction = /^(?:set|put)$/iu.test(action)
      && /\b(?:is|are|was|were|has\s+been|have\s+been|had\s+been)\s*$/iu.test(before);
    const passiveSensitiveFrenchAction = /\b(?:est|sont|[ée]tait|[ée]taient|a|ont|avait|avaient|sera|seront)\s+(?:[ée]t[ée]\s+)?$/iu.test(before)
      && /(?:[ée](?:e|es|s)?|u(?:e|es|s)?|it|is|t|fait)$/iu.test(action);
    const narratedExplicitSubject = englishRoleOrPronounSubject
      || frenchNominalOrPronounSubject || namedFrenchSubject || namedEnglishSubject;
    const directMedicationManagement = DIRECT_CLINICAL_TREATMENT_ACTION_PATTERN.test(action);
    const directClinicalProcedure = DIRECT_CLINICAL_PROCEDURE_ACTION_ONLY_PATTERN.test(action);
    const directPatientCare = DIRECT_CLINICAL_PATIENT_CARE_ACTION_PATTERN.test(action);
    const writesDocumentOnly = /^(?:write|draft|create|r[ée]dig\w*|[ée]cri\w*|cr[ée](?:e|ez|er))$/iu.test(action)
      && /^\s+(?:(?:the|a|an|le|la|les|un|une)\s+)?(?:guide|report|document|documentation|article|plan|mockup|rapport|compte\s+rendu|maquette)\b/iu.test(after);
    if (inflectedSensitiveEnglishAction && !inflectedActionRequestLead && !frenchImperativeContext) continue;
    if (family === 'clinical'
      && directMedicationManagement
      && !DIRECT_CLINICAL_LOCAL_MEDICATION_PATTERN.test(after)
      && !DIRECT_CLINICAL_LOCAL_TRANSITION_PATTERN.test(after)
      && !DIRECT_CLINICAL_PATIENT_ADMINISTRATION_PATTERN.test(after)) continue;
    if (family === 'clinical'
      && directClinicalProcedure
      && !DIRECT_CLINICAL_LOCAL_PROCEDURE_PATTERN.test(after)
      && !DIRECT_CLINICAL_LOCAL_NAMED_PERSON_PATTERN.test(after)) continue;
    if (family === 'clinical'
      && directPatientCare
      && !DIRECT_CLINICAL_PATIENT_PROCEDURE_PATTERN.test(after)
      && !DIRECT_CLINICAL_LOCAL_NAMED_PERSON_PATTERN.test(after)) continue;
    if (!negated && !question && !reported && !governedByReportedStatement
      && !quoted && !documentaryHowTo && !politeDocumentaryHowTo
      && !governedPlanningOrDesign && !analyticalIndirectMutation
      && !negatedAnalyticalIndirectMutation && !governedMockupButton
      && !narratedExplicitSubject
      && !writesDocumentOnly
      && !passiveSensitiveEnglishAction && !passiveSensitiveFrenchAction) return true;
  }
  return false;
}
