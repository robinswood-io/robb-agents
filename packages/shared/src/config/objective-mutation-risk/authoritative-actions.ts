import { detectHighStakesEvidenceDomain, DIRECT_CLINICAL_PATIENT_CARE_ACTION_SOURCE, DIRECT_CLINICAL_PROCEDURE_ACTION_SOURCE, DIRECT_CLINICAL_TREATMENT_ACTION_SOURCE } from "../../agent/core/objective-evidence-gate.ts";
import { ANY_ENGLISH_CLINICAL_ACTION_PATTERN, BARE_ENGLISH_CLINICAL_ACTION_PATTERN, CONTEXTUAL_MEDICAL_MUTATION_PATTERN, DIRECT_CLINICAL_PATIENT_CARE_MUTATION_PATTERN, DIRECT_CLINICAL_PRESCRIPTION_MUTATION_PATTERN, DIRECT_CLINICAL_PROCEDURE_MUTATION_PATTERN, DIRECT_RBAC_MUTATION_PATTERN, ENGLISH_OBJECT_STATE_QUESTION_PATTERN, EXPLICIT_OPERATIONAL_TREATMENT_COMPLEMENT_PATTERN, FRENCH_INFINITIVE_STATE_PREDICATE_SOURCE, FRENCH_OBJECT_STATE_QUESTION_PATTERN, FRENCH_REACTIVATION_PATTERN, LOCALLY_BOUND_CLINICAL_NAMED_PERSON_PATTERN, LOCALLY_BOUND_CLINICAL_PATIENT_ADMINISTRATION_PATTERN, LOCALLY_BOUND_CLINICAL_PATIENT_PATTERN, LOCALLY_BOUND_CLINICAL_PROCEDURE_PATTERN, LOCALLY_BOUND_CLINICAL_TRANSITION_PATTERN, LOCALLY_BOUND_MEDICAL_TARGET_PATTERN, MODAL_PASSIVE_MUTATION_PATTERN, MUTATION_VERB_SOURCE, STRUCTURED_SOURCE_TRANSFER_PATTERN, hasLocallyBoundOperationalTreatmentTarget } from './patterns.ts';

function isNonAuthoritativeMutation(text: string, index: number, length: number): boolean {
  const before = text.slice(Math.max(0, index - 140), index);
  const after = text.slice(index + length, index + length + 48);
  const mutation = text.slice(index, index + length).toLocaleLowerCase();
  const frenchReactivation = /^r[ée]activ(?:er|e(?:z)?|ons?)$/iu.test(mutation);
  const localClauseStart = Math.max(
    text.lastIndexOf('.', index - 1),
    text.lastIndexOf('!', index - 1),
    text.lastIndexOf('?', index - 1),
    text.lastIndexOf(';', index - 1),
    text.lastIndexOf('\n', index - 1),
  );
  const localClauseTail = text.slice(index + length).search(/[.!?;\n]/u);
  const localClauseEnd = localClauseTail < 0
    ? text.length
    : index + length + localClauseTail;
  const localClause = text.slice(localClauseStart + 1, localClauseEnd);
  // “Ne t’arrête que si un secret manque” constrains the agent's own stopping
  // condition; it neither rotates nor modifies that secret. Keep this narrow
  // to self-directed stop wording so “arrête le service” and explicit secret
  // mutations continue through the normal high-risk path.
  const conditionalSelfStop = /^(?:stop|arr[êe]t(?:er|e(?:z)?|ons?))$/iu.test(mutation)
    && /(?:\bne\s+(?:t['’]\s*|vous\s+)?arr[êe]t(?:e|ez)\s+que\s+si|\b(?:do\s+not|don['’]t)\s+stop\s+(?:working|your\s+work)\s+unless|\bonly\s+stop\s+(?:working|your\s+work)\s+if)\b/iu.test(localClause);
  const conditionalTargetStop = /^stop$/iu.test(mutation)
    && /\b(?:do\s+not|don['’]t)\s+stop\b[^.!?;\n]{0,80}\bunless\b/iu.test(localClause)
    && !conditionalSelfStop;
  const conditionalImperativeBefore = /(?:(?:\band\s*,?\s*)?\bif\s+(?:not|(?:it|that)\s+(?:does\s+not|doesn['’]t))|\botherwise|(?:\bet\s*,?\s*)?(?:\bsinon|\bsi\s+ce\s+n['’]est\s+pas\s+le\s+cas|\bs['’]il\s+ne(?:\s+[\p{L}\p{N}'’_-]+){0,6}\s+pas))\s*[,;:]?\s*(?:(?:please|(?:can|could)\s+you|merci\s+de|peux-tu|pouvez-vous)\s+)?(?:(?:l['’]|les?\s+|la\s+))?$/iu.test(before);
  const sequentialImperativeBefore = /(?:\b(?:and\s+)?then|\bpuis|\bensuite)\s*[,;:]?\s*(?:(?:please|(?:can|could|would)\s+you|merci\s+de|peux-tu|pouvez-vous)\s+)?(?:(?:l['’]|les?\s+|la\s+))?$/iu.test(before);
  const objectStateQuestion = (
    ENGLISH_OBJECT_STATE_QUESTION_PATTERN.test(text.trim())
      || FRENCH_OBJECT_STATE_QUESTION_PATTERN.test(text.trim())
  ) && !conditionalImperativeBefore && !sequentialImperativeBefore;
  const negatedBefore = /(?:\bdo\s+not|\bdon['’]t|\bnever|\b(?:must|should)(?:\s+not|n['’]t)|\b(?:is|are|was|were)\s+not\s+to|\bcannot|\bcan['’]t|\bwill\s+not|\bwon['’]t|\bwithout|\bsans|\bnul\s+besoin\s+de|\bne(?:\s+[\p{L}\p{N}'’_-]+){0,3}\s+(?:pas|jamais|plus))\b(?:\s+[\p{L}\p{N}'’_-]+){0,5}\s*$/iu.test(before);
  const frenchWrappedNegation = /(?:\bne|\bn['’])(?:\s+[\p{L}\p{N}'’_-]+){0,4}\s*$/iu.test(before)
    && /^\s+(?:pas|jamais|plus|rien|aucun(?:e)?)\b/iu.test(after)
    // A named exception is affirmative work ("ne crée aucun fichier sauf le
    // rapport") and must not be erased with the surrounding prohibition.
    && !/^\s+aucun(?:e)?\b[^.!?;\n]{0,120}\bsauf\s+(?:le|la|les|un|une|des|l['’])/iu.test(after);
  const frenchNegationInsideMutation = /(?:\bne|\bn['’])\s*$/iu.test(before)
    && /^(?:[\p{L}\p{N}'’_-]+)(?:\s+[\p{L}\p{N}'’_-]+){0,3}\s+(?:pas|jamais|plus|rien)\b/iu.test(mutation);
  const hypotheticalBefore = /(?:\bwhether\s+to|\bdecide\s+whether\s+to|\bhow\s+to|\b(?:explain|describe|review|analyse|analyze).{0,80}\bif\s+(?:we|i|you|they)\b|\bwhat\s+(?:happens|would\s+happen)\s+if\s+(?:we|i|you|they)\b|\bshould\s+(?:we|i|you)(?:\s+[\p{L}\p{N}'’_-]+){0,6}|\bsi\s+(?:on|nous|je|tu|vous|ils?|elles?)\s+(?:doi(?:s|t|vent)|dev(?:ons|ez|ions)|devrait|devrions|faut)(?:\s+[\p{L}\p{N}'’_-]+){0,6}|\bdev(?:ons|ez)-nous(?:\s+[\p{L}\p{N}'’_-]+){0,6}|\b(?:review|inspect|audit|analyse|analyze).{0,80}\bplan\s+to(?:\s+[\p{L}\p{N}'’_-]+){0,6})\s*$/iu.test(before)
    || /(?:\b(?:explique|d[ée]cris|analyse)\b.{0,80}\bce\s+qui\s+(?:se\s+passe|arriv(?:e|erait))\s+si\s+(?:on|nous|je|tu|vous|ils?|elles?)|(?:^|[^\p{L}\p{N}_])(?:que\s+se\s+passe-t-il|qu['’]arriverait-il)\s+si\s+(?:on|nous|je|tu|vous|ils?|elles?)|\b(?:analyse|analyze|audite?|audit|inspecte?|inspect|examine|explique|explain|review|v[ée]rifie|revois)\b.{0,80}\b(?:comment|how\s+to)\s*|\b(?:analyse|audite|inspecte|examine|v[ée]rifie|revois)\b.{0,80}\bplan\s+(?:pour|de))\s*$/iu.test(before);
  const analyticalIndirectMutationBefore = /(?:^|[.!?;\n])\s*(?:(?:please|kindly)\s+|merci\s+d['’]?\s*)?(?:analy[sz]e|analys(?:e|er|ez|ons)|review|explain|evaluate|assess|[ée]valu(?:e|er|ez|ons))\b[^.!?;\n]{0,120}\b(?:whether\s+to|how\s+to|comment|s['’]il\s+faut)\s*$/iu.test(before);
  const negatedAnalyticalIndirectMutationBefore = /(?:^|[.!?;\n])\s*(?:(?:do\s+not|don['’]t|never)\s+(?:analy[sz]e|review|explain|evaluate|assess)|(?:ne\s+|n['’]\s*)(?:analys(?:e|er|ez|ons)|revois|expliqu(?:e|er|ez|ons)|[ée]valu(?:e|er|ez|ons))\s+(?:pas|jamais))\b[^.!?;\n]{0,120}\b(?:whether\s+to|how\s+to|comment|s['’]il\s+faut)\s*$/iu.test(before);
  const frenchDecisionQuestionBefore = /(?:(?:est-ce\s+que\s+)?(?:je|nous|on)\s+(?:dois|devrais|puis|pourrais|devons|devrions|pouvons|pourrions)|(?:dois|devrais|puis|pourrais)-je|(?:devons|devrions|pouvons|pourrions)-nous|(?:doit|devrait|peut|pourrait)-on)\s*$/iu.test(before)
    && /\?\s*$/u.test(text.trim());
  const reportedSpeechBefore = /(?:\b(?:the|this|that|a)\s+)?(?:plan|document|report|text|message|instruction|requirement|guide|polic(?:y|ies)|procedures?|protocols?)s?\s+(?:that\s+)?(?:says?|said|states?|mentions?|recommends?|proposes?|suggests?|requires?|mandates?|directs?)\s*[:：-]?\s*(?:(?:that\s+)?(?:we|you|they|i|admins?|administrators?|nurses?|doctors?|staff)\s+(?:(?:should|must|need(?:s)?\s+to|can|could|would)\s+|to\s+)|(?:that\s+)?(?:the\s+)?(?:admins?|administrators?|nurses?|doctors?|staff)\s+to\s+|(?:that\s+)?|to\s+|then\s+)?$/iu.test(before)
    || /(?:\b(?:le|ce|cet|cette|un|une|la)\s+)?(?:plan|document|documentation|rapport|texte|message|consigne|instruction|exigence|guide|politique|proc[ée]dure|protocole|r[èe]gle)s?\s+(?:qui\s+)?(?:dit|indique|mentionne|recommande|propose|sugg[èe]re|pr[ée]voit|exige|impose|ordonne)\s*[:：-]?\s*(?:(?:que\s+)?(?:nous|vous|ils?|elles?|on|je|tu|les?\s+(?:admins?|administrat(?:eur|rice)s?|infirmi(?:er|[èe]re)s?|m[ée]decins?|responsables?))\s+(?:devr(?:ait|ions|iez|aient)|doi(?:s|t|vent)|peu(?:x|t|vent)|pourr(?:ais|ait|ions|iez|aient))\s+|qu['’]il\s+faut\s+|(?:ensuite\s+)?(?:de\s+|d['’]\s*)|ensuite\s+)?$/iu.test(before)
    || /(?:\b(?:le|la|un|une)\s+)?(?:m[ée]decin|docteur|docteure|clinicien|clinicienne)s?\s+(?:(?:recommande|conseille|propose|sugg[èe]re)\s+(?:(?:que\s+)?(?:nous|vous|ils?|elles?|on|je|tu)\s+(?:devr(?:ait|ions|iez|aient)|doi(?:s|t|vent)|peu(?:x|t|vent)|pourr(?:ais|ait|ions|iez|aient))\s+|qu['’]il\s+faut\s+|de\s+|d['’]\s*)|(?:dit|indique|d[ée]clare|mentionne)\s*[:：-]?\s*(?:(?:que\s+)?(?:nous|vous|ils?|elles?|on|je|tu)\s+(?:devr(?:ait|ions|iez|aient)|doi(?:s|t|vent)|peu(?:x|t|vent)|pourr(?:ais|ait|ions|iez|aient))\s+|qu['’]il\s+faut\s+)?)$/iu.test(before)
    || /(?:\b(?:the|a)\s+)?(?:doctor|physician|clinician)s?\s+(?:(?:recommends?|advises?|proposes?|suggests?)\s+(?:(?:that\s+)?(?:we|you|they|i)\s+(?:(?:should|must|need(?:s)?\s+to|can|could|would)\s+)?|(?:to\s+)?)|(?:says?|states?|declares?|mentions?)\s*[:：-]?\s*(?:(?:that\s+)?(?:we|you|they|i)\s+(?:should|must|need(?:s)?\s+to|can|could|would)\s+|to\s+)?)$/iu.test(before)
    || /(?:\baccording\s+to\s+(?:the\s+)?(?:doctor|physician|clinician)|\bselon\s+(?:le|la|un|une)\s+(?:m[ée]decin|docteur|docteure|clinicien|clinicienne))\b[^.!?;\n]{0,100}(?:\b(?:we|you|they|i)\s+(?:should|must|need(?:s)?\s+to)|\b(?:nous|vous|ils?|elles?|on|je|tu)\s+(?:devr(?:ait|ions|iez|aient)|doi(?:s|t|vent))|\bil\s+faut)\s*$/iu.test(before);
  const governedByReportedStatement = /(?:^|[.!?;\n])\s*(?:(?:(?:the|this|that|a)\s+)?(?:plan|document|report|text|message|instruction|requirement|guide|polic(?:y|ies)|procedures?|protocols?)s?\s+(?:that\s+)?(?:says?|said|states?|mentions?|recommends?|proposes?|suggests?|requires?|mandates?|directs?)|(?:(?:le|ce|cet|cette|un|une|la)\s+)?(?:plan|document|documentation|rapport|texte|message|consigne|instruction|exigence|guide|politique|proc[ée]dure|protocole|r[èe]gle)s?\s+(?:qui\s+)?(?:dit|indique|mentionne|recommande|propose|sugg[èe]re|pr[ée]voit|exige|impose|ordonne))\b[^.!?;\n]{0,160}$/iu.test(before);
  const inspectedInstructionBefore = /\b(?:review|analyse|analyze|inspect|audit|explain)\s+(?:(?:this|that|these|those|the|an?)\s+)?(?:instructions?|prompts?|commands?|requests?|guidelines?|guides?)\s*[:：]\s*[^.!?;\n]{0,96}$/iu.test(before)
    || /\b(?:analyse|audite?|inspecte?|examine|explique|revois)\s+(?:(?:ce|cet|cette|ces|le|la|les|un|une)\s+)?(?:instructions?|consignes?|commandes?|requ[êe]tes?|directives?|guides?)\s*[:：]\s*[^.!?;\n]{0,96}$/iu.test(before);
  const documentaryHowTo = /(?:^|[.!?;\n])\s*(?:(?:(?:could|can|would)\s+you|(?:peux|pourrais)-tu|(?:pouvez|pourriez)-vous)\s+)?(?:document(?:e|ez|er)|d[ée]cri(?:s|vez|re)|expliqu(?:e|ez|er)|r[ée]dig(?:e|ez|er)|write|draft|document|describe|explain)\b[^.!?;\n]{0,100}\b(?:comment|how\s+to|la\s+mani[èe]re\s+(?:de\s+|d['’]\s*)|l['’]option\s+de)\s*$/iu.test(before);
  const governedPlanningOrDesign = /(?:^|[.!?;\n])\s*(?:(?:draft|write|create|show|review|explain|r[ée]dig(?:e|ez|er)|cr[ée](?:e|ez|er)|affich(?:e|ez|er)|montre|analyse|expliqu(?:e|ez|er))\b[^.!?;\n]{0,120}\b(?:plans?\s+(?:to|pour)|mockups?\s+(?:of|for)|maquettes?\s+(?:du|de\s+la|des)|boutons?\s+(?:pour|de|du)|options?\s+(?:to|de)|whether\s+(?:we\s+)?should|s['’]il\s+faut)\s*|(?:je\s+veux\s+savoir|i\s+want\s+to\s+know)\b[^.!?;\n]{0,80}\b(?:s['’]il\s+faut|whether\s+(?:we\s+)?should)\s*)$/iu.test(before);
  const governedMockupButton = /(?:^|[.!?;\n])\s*(?:show|create|cr[ée](?:e|ez|er)|affich(?:e|ez|er)|montre)\b[^.!?;\n]{0,120}\b(?:mockups?|maquettes?)\b[^.!?;\n]{0,80}\b(?:buttons?|boutons?)\b/iu.test(`${before} ${after}`);
  const quotePairs: Array<readonly [string, string]> = [
    ['"', '"'],
    ['“', '”'],
    ['«', '»'],
    ['`', '`'],
  ];
  const insideQuotedSpan = quotePairs.some(([open, close]) => {
    const opening = text.lastIndexOf(open, index - 1);
    if (opening < 0) return false;
    const closingBefore = text.lastIndexOf(close, index - 1);
    const closingAfter = text.indexOf(close, index + length);
    return (open === close ? text.slice(0, index).split(open).length % 2 === 0 : opening > closingBefore)
      && closingAfter >= index + length;
  });
  // Sensitive English mutations use the bare verb for an imperative. Past,
  // progressive and third-person forms describe observed work unless they are
  // explicitly governed by an imperative lead (for example "start
  // administering"). This prevents status prose from creating new authority.
  const inflectedSensitiveEnglishAction = (
    ANY_ENGLISH_CLINICAL_ACTION_PATTERN.test(mutation)
    && !BARE_ENGLISH_CLINICAL_ACTION_PATTERN.test(mutation)
  ) || /^(?:(?:assign|invit|demot|disabl|enabl|activat|deactivat|suspend|includ|exclud|transfer|convert|provid|allow|authoriz|promot|grant|revok|remov|appoint|elevat|nam|add)(?:s|es|ed|d|ing)|chang(?:es|ed|ing)|den(?:ies|ied|ying)|permits|permitted|permitting|gives|giving|given|gave|makes|making|made)$/iu.test(mutation);
  const frenchImperativeContext = /^suspends$/iu.test(mutation)
    && /^\s+(?:(?:le|la|les|un|une)\s+|l['’]\s*)/iu.test(after);
  const inflectedActionRequestLead = /\b(?:start|continue|keep|begin|please|then)\s*$/iu.test(before);
  const narratedSensitiveAction = inflectedSensitiveEnglishAction
    && !inflectedActionRequestLead && !frenchImperativeContext;
  const explicitSubjectBefore = before.split(/[.!?;\n]/u).at(-1)?.trim() ?? '';
  const frenchThirdPersonSensitiveAction = /^(?:attribue|assigne|ajoute|donne|accorde|octroie|r[ée]voque|retire|supprime|active|d[ée]sactive|suspend|autorise|interdit|refuse|permet|transf[èe]re|invite|r[ée]trograde|inclue|exclue|change|convertit|met|nomme|promeut|d[ée]signe|[ée]l[èe]ve|rend|adapte|ajuste|prescrit|r[ée]duit|diminue|baisse|passe|augmente|commence|initie|titre|double|divise|remplace|substitue|s[èe]vre|interrompt|reprend|red[ée]marre|renouvelle|transitionne|cesse|arr[êe]te|administre|injecte|perfuse|donne|ordonne|vaccine|immunise|inocule|intube|extube|transfuse|biopsie|pose|effectue|r[ée]alise|pratique|op[èe]re|planifie|programme|fait)$/iu.test(mutation)
    || /ent$/iu.test(mutation) && (
      new RegExp(`^(?:${DIRECT_CLINICAL_TREATMENT_ACTION_SOURCE}|${DIRECT_CLINICAL_PROCEDURE_ACTION_SOURCE}|${DIRECT_CLINICAL_PATIENT_CARE_ACTION_SOURCE})$`, 'iu').test(mutation)
    );
  const englishRoleOrPronounSubject = /^(?:(?:the|a|an)\s+(?:doctor|physician|clinician|nurse|surgeon|manager|administrator|operator|technician)|(?:he|she|they))$/iu.test(explicitSubjectBefore);
  const frenchNominalOrPronounSubject = frenchThirdPersonSensitiveAction
    && /^(?:(?:le|la|l['’]|un|une|ce|cet|cette)\s+[\p{L}\p{M}'’_-]+(?:\s+[\p{L}\p{M}'’_-]+){0,2}|il|elle|ils|elles)$/iu.test(explicitSubjectBefore);
  const namedFrenchSubject = frenchThirdPersonSensitiveAction
    && /^(?!(?:Puis|Ensuite|Maintenant|Veuillez|Merci|Enfin|Alors|Please|Kindly|Then|Now)$)[A-ZÀ-ÖØ-Þ][\p{L}\p{M}'’_-]+(?:\s+[A-ZÀ-ÖØ-Þ][\p{L}\p{M}'’_-]+)?$/u.test(explicitSubjectBefore);
  const namedEnglishSubject = /^(?:set|put)$/iu.test(mutation)
    && /^(?!(?:Please|Then|Now|Kindly)$)[A-Z][\p{L}\p{M}'’_-]+(?:\s+[A-Z][\p{L}\p{M}'’_-]+)?$/u.test(explicitSubjectBefore);
  const passiveSensitiveEnglishAction = /^(?:set|put)$/iu.test(mutation)
    && /\b(?:is|are|was|were|has\s+been|have\s+been|had\s+been)\s*$/iu.test(before);
  const passiveSensitiveFrenchAction = /\b(?:est|sont|[ée]tait|[ée]taient|a|ont|avait|avaient|sera|seront)\s+(?:[ée]t[ée]\s+)?$/iu.test(before)
    && /(?:[ée](?:e|es|s)?|u(?:e|es|s)?|it|is|t|fait)$/iu.test(mutation);
  const narratedFrenchSubject = englishRoleOrPronounSubject
    || frenchNominalOrPronounSubject || namedFrenchSubject || namedEnglishSubject;
  const nominalReadOnlyObject = /^(?:fix|change|update|review|release|rollback)$/u.test(mutation)
    && /\b(?:audit|inspect|review|analyse|analyze|explain|summari[sz]e|verify|check|read)\s+(?:(?:the|this|that|a|an)\s+)?(?:[\p{L}\p{N}'’_-]+\s+){0,4}$/iu.test(before);
  const contextualMedicalMutation = /^(?:adjust|prescribe|reduce|start|give|gave|adapt(?:er|e(?:s|z)?|ons?)|prescri(?:re|s|t|vez|vons)|r[ée]dui(?:re|s|t|sez|sons)|commenc(?:er|e(?:s|z)?|ons?)|donn(?:er|e(?:s|z)?|ons?))$/iu.test(mutation);
  // Mutation candidates are already from a closed action vocabulary. Apply
  // the subject-description guard to every French infinitive in that set, not
  // only the medical/reactivation compatibility additions.
  const frenchInfinitive = /(?:er|ir|re)$/iu.test(mutation);
  const localClauseBefore = before.split(/[.!?;\n]/u).at(-1)?.trim() ?? '';
  const bareInfinitiveTaskLead = /^(?:(?:[-*+•]|\d+[.)])\s*|(?:action|[àa]\s+faire|t[âa]che)\s*:\s*)?$/iu.test(localClauseBefore);
  const interrogativeOrProposalBefore = /(?:\b(?:faut-il|devrait-on|peut-on|doit-on)|\b(?:il\s+faudrait|on\s+pourrait|nous\s+pourrions)|\b(?:we|i|you|they)\s+(?:could|might))\s*$/iu.test(before);
  const bareMutationQuestion = /^\s*$/u.test(before)
    && /\?\s*$/u.test(text.slice(index + length).split(/[.!;\n]/u, 1)[0] ?? '');
  const infinitiveSubjectDescription = frenchInfinitive && bareInfinitiveTaskLead
    && new RegExp(
      // Do not mistake a later independent clause such as "c'est ta mission"
      // for the predicate whose grammatical subject is the infinitive.
      String.raw`^\s+[^.!?;\n]{0,120}(?<!c['’])(?<!c )(?<![\p{L}\p{N}_])${FRENCH_INFINITIVE_STATE_PREDICATE_SOURCE}(?![\p{L}\p{N}_])`,
      'iu',
    ).test(after);
  const englishInfinitiveTopic = /(?:^|[.!?;\n])\s*(?:to|the\s+(?:option|proposal|idea|plan)\s+to)\s*$/iu.test(before)
    && /^\s+[^.!?;\n]{0,160}\b(?:is|are|was|were|will\s+be|remains?|seems?|becomes?|requires?|implies?|means?)\b/iu.test(after);
  // `réactiver` was added for a concrete imperative missed in production.
  // Keep that recovery request-shaped: purpose/questions, analysis prompts and
  // infinitive subject statements describe the action but do not authorize it.
  const nonRequestReactivation = frenchReactivation && (
    /(?:^|[.!?;:]\s*)(?:pour|afin\s+de)\s*$/iu.test(before)
    || /\b(?:analyse|analyser|audite?|inspecte?|examine|explique|v[ée]rifie|revois)\b.{0,80}\bcomment\s*$/iu.test(before)
  );
  return (negatedBefore && !conditionalTargetStop)
    || frenchWrappedNegation || frenchNegationInsideMutation || hypotheticalBefore
    || analyticalIndirectMutationBefore || negatedAnalyticalIndirectMutationBefore
    || frenchDecisionQuestionBefore
    || reportedSpeechBefore || governedByReportedStatement || inspectedInstructionBefore
    || documentaryHowTo || governedPlanningOrDesign || governedMockupButton || insideQuotedSpan
    || nominalReadOnlyObject || objectStateQuestion || interrogativeOrProposalBefore
    || bareMutationQuestion || infinitiveSubjectDescription || englishInfinitiveTopic
    || nonRequestReactivation || conditionalSelfStop || narratedSensitiveAction
    || passiveSensitiveEnglishAction
    || passiveSensitiveFrenchAction
    || narratedFrenchSubject;
}

function isAuthoritativeModalPassive(text: string, index: number, length: number): boolean {
  const clauseStart = Math.max(
    text.lastIndexOf('.', index - 1),
    text.lastIndexOf('!', index - 1),
    text.lastIndexOf('?', index - 1),
    text.lastIndexOf(';', index - 1),
    text.lastIndexOf('\n', index - 1),
  );
  const before = text.slice(clauseStart + 1, index);
  const after = text.slice(index + length);
  if (/\?\s*$/u.test(after.split(/[.!;\n]/u, 1)[0] ?? '')) return false;
  if (/(?:\bne|\bn['’])\s*$/iu.test(before)) return false;
  if (/^\s*(?:(?:example|exemple|documentation|docs?|guide|policy|politique|fixture|test|sample|extrait|quote|citation)\s*:|(?:(?:the|this|that|le|la|ce|cet|cette)\s+)?(?:documentation|document|guide|policy|politique|report|rapport|message|text|texte)\b[^.!?;\n]{0,120}\b(?:says?|states?|mentions?|indique|dit|mentionne)\b)/iu.test(before)) {
    return false;
  }
  const quotePairs: Array<readonly [string, string]> = [['"', '"'], ['“', '”'], ['«', '»'], ['`', '`']];
  return !quotePairs.some(([open, close]) => {
    const opening = text.lastIndexOf(open, index - 1);
    const closingBefore = text.lastIndexOf(close, index - 1);
    const closingAfter = text.indexOf(close, index + length);
    return opening >= 0
      && (open === close ? text.slice(0, index).split(open).length % 2 === 0 : opening > closingBefore)
      && closingAfter >= index + length;
  });
}

function isAuthoritativeFrenchReactivation(
  text: string,
  index: number,
  mutation: string,
): boolean {
  const clauseStart = Math.max(
    text.lastIndexOf('\n', index - 1),
    text.lastIndexOf('.', index - 1),
    text.lastIndexOf('!', index - 1),
    text.lastIndexOf(';', index - 1),
  );
  const before = text.slice(clauseStart + 1, index).trim();
  const after = text.slice(index + mutation.length);
  const priorContext = text.slice(0, clauseStart + 1)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').toLowerCase();
  const priorAuthorityContext = priorContext.replace(/(?:^|\n)\s*\d+[.)]\s*$/u, '');
  const nonAuthoritativePriorContext = /(?:^|[.!?;\n])\s*(?:exemple|example|citation|quote|sujet|subject|question|hypothese|option|proposition|scenario|consigne\s+citee|texte\s+a\s+analyser|plan\s+(?:propose|proposed))\s*:?\s*$/.test(priorAuthorityContext)
    || /(?:^|[.!?;\n])\s*(?:(?:le|la)\s+)?(?:rapport|report|document|documentation|texte|text|message)\b.{0,100}\b(?:dit|says?|indique|mentions?|recommande|recommends?)\s*:?\s*$/.test(priorAuthorityContext)
    || /(?:^|[.!?;\n])\s*analyse\b.{0,100}\b(?:instruction|option|si|whether)\b.{0,40}:?\s*$/.test(priorAuthorityContext);
  if (nonAuthoritativePriorContext) return false;
  const politeLead = String.raw`(?:ok|oui|d['’]accord|vas-y|allez-y|merci)`;
  const temporal = String.raw`(?:maintenant|d[ée]sormais|tout\s+de\s+suite)`;
  const requestFiller = String.raw`(?:${temporal}|stp|svp|s['’]\s*il\s+te\s+pla[iî]t|s['’]\s*il\s+vous\s+pla[iî]t)`;
  const requestBody = String.raw`(?:tu\s+(?:dois|peux|vas)|vous\s+(?:devez|pouvez|allez)|(?:peux|pourrais)-tu|(?:pouvez|pourriez)-vous|est-ce\s+que\s+(?:tu\s+peux|vous\s+pouvez)|merci\s+de|je\s+(?:te|vous)\s+demande(?:\s+${requestFiller})?\s+de|je\s+(?:veux|souhaite|voudrais)\s+que\s+(?:tu|vous)|j['’]\s*ai\s+besoin\s+que\s+(?:tu|vous)|il\s+faut(?:\s+${requestFiller})?(?:\s+que\s+(?:tu|vous))?|veuillez|puis|ensuite)`;
  const structuredRequestPrefix = new RegExp(
    `^(?:(?:${politeLead})\\s*[,;:]?\\s*)?(?:(?:${temporal})\\s+)?(?:${requestBody})(?:\\s+(?:${requestFiller}))?$`,
    'iu',
  );
  const standaloneRequestLead = new RegExp(
    `^(?:${politeLead}|${temporal})\\s*[,;:]?$`,
    'iu',
  );
  if (structuredRequestPrefix.test(before) || standaloneRequestLead.test(before)) return true;
  const directTaskPrefix = /^(?:[-*+•]|(?:action|[àa]\s+faire|t[âa]che)\s*:)$/iu.test(before)
    && text.slice(0, clauseStart + 1).trim().length === 0;
  const directDevLoginTarget = /^[^.!?;\n]{0,96}(?:dev(?:eloppement)?\s+login|login\s+(?:de\s+)?d[ée]v(?:eloppement)?)(?![\p{L}\p{N}_])/iu.test(after);
  const directStructuredTask = /^\s*(?:action|[àa]\s+faire|t[âa]che)\s*:\s*(?:\r?\n)\s*(?:[-*+•]|\d+[.)])?\s*$/iu.test(text.slice(0, index));
  if ((directTaskPrefix || directStructuredTask) && directDevLoginTarget) return true;
  if (before) return false;

  const infinitive = /er$/iu.test(mutation);
  if (!infinitive) {
    return !/^\s*-(?:t-)?(?:il|elle|on|ils|elles)\b/iu.test(after);
  }
  // A bare infinitive is a common French task-list imperative. Questions,
  // alternatives and modal/state assertions are not.
  return !/\?/u.test(after.split(/[.!;\n]/u, 1)[0] ?? '')
    && !/^\s+[^.!?;\n]{0,120}\b(?:ou\s+non|est|serait|semble(?:rait)?|para[iî]t(?:rait)?|peut|pourrait|devrait)\b/iu.test(after);
}

export function authoritativeMutationMatches(
  text: string,
  structuredSensitive = false,
): Array<{ index: number; length: number }> {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${MUTATION_VERB_SOURCE}(?![\\p{L}\\p{N}_])`, 'giu');
  const contextualMedicalMutation = detectHighStakesEvidenceDomain(text) === 'medical';
  const contextualMedicalMatches = contextualMedicalMutation
    ? [...text.matchAll(CONTEXTUAL_MEDICAL_MUTATION_PATTERN)].filter(match => (
      typeof match.index === 'number'
      && (() => {
        const afterMutation = text.slice(match.index + match[0].length);
        const localTarget = LOCALLY_BOUND_MEDICAL_TARGET_PATTERN.exec(afterMutation);
        if (!localTarget) {
          return LOCALLY_BOUND_CLINICAL_PATIENT_ADMINISTRATION_PATTERN.test(afterMutation)
            || LOCALLY_BOUND_CLINICAL_TRANSITION_PATTERN.test(afterMutation);
        }
        const afterTarget = afterMutation.slice(localTarget[0].length);
        // A medical word elsewhere in the request cannot promote an explicitly
        // operational treatment object in this clause (batch/API/data, etc.).
        return !EXPLICIT_OPERATIONAL_TREATMENT_COMPLEMENT_PATTERN.test(afterTarget);
      })()
    ))
    : [];
  const contextualOperationalMatches = [...text.matchAll(CONTEXTUAL_MEDICAL_MUTATION_PATTERN)].filter(match => (
    typeof match.index === 'number'
    && hasLocallyBoundOperationalTreatmentTarget(text.slice(match.index + match[0].length))
  ));
  const directClinicalProcedureMatches = contextualMedicalMutation
    ? [...text.matchAll(DIRECT_CLINICAL_PROCEDURE_MUTATION_PATTERN)].filter(match => (
      typeof match.index === 'number'
      && (LOCALLY_BOUND_CLINICAL_PROCEDURE_PATTERN.test(
        text.slice(match.index + match[0].length),
      ) || LOCALLY_BOUND_CLINICAL_NAMED_PERSON_PATTERN.test(
        text.slice(match.index + match[0].length),
      ))
    ))
    : [];
  const directClinicalPatientCareMatches = contextualMedicalMutation
    ? [...text.matchAll(DIRECT_CLINICAL_PATIENT_CARE_MUTATION_PATTERN)].filter(match => (
      typeof match.index === 'number'
      && (LOCALLY_BOUND_CLINICAL_PATIENT_PATTERN.test(
        text.slice(match.index + match[0].length),
      ) || LOCALLY_BOUND_CLINICAL_NAMED_PERSON_PATTERN.test(
        text.slice(match.index + match[0].length),
      ))
    ))
    : [];
  const candidates = [
    ...text.matchAll(pattern),
    ...text.matchAll(DIRECT_CLINICAL_PRESCRIPTION_MUTATION_PATTERN),
    ...contextualMedicalMatches,
    ...contextualOperationalMatches,
    ...directClinicalProcedureMatches,
    ...directClinicalPatientCareMatches,
    ...text.matchAll(DIRECT_RBAC_MUTATION_PATTERN),
    ...[...text.matchAll(MODAL_PASSIVE_MUTATION_PATTERN)].filter(match => (
      typeof match.index === 'number'
      && isAuthoritativeModalPassive(text, match.index, match[0].length)
    )),
    ...[...text.matchAll(FRENCH_REACTIVATION_PATTERN)].filter(match => (
      typeof match.index === 'number'
      && isAuthoritativeFrenchReactivation(text, match.index, match[0])
    )),
    ...(structuredSensitive ? text.matchAll(STRUCTURED_SOURCE_TRANSFER_PATTERN) : []),
  ];
  const unique = new Map<number, { index: number; length: number }>();
  for (const match of candidates) {
    const index = match.index ?? -1;
    if (index < 0 || isNonAuthoritativeMutation(text, index, match[0].length)) continue;
    const previous = unique.get(index);
    if (!previous || match[0].length > previous.length) {
      unique.set(index, { index, length: match[0].length });
    }
  }
  return [...unique.values()].sort((left, right) => left.index - right.index);
}
