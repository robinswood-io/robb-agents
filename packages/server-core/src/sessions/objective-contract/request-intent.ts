import { classifyObjectiveMutationRisk } from "@craft-agent/shared/config";
import { hasNonAuthoritativeStructuredLead } from './instruction-clause-syntax.ts';
import { AMENDMENT_REQUEST_PREFIX } from './intent-vocabulary.ts';
import { foldForIntent } from './types.ts';

// The shared risk classifier owns authority, negation, quotation and reported-
// speech semantics. These extra artifact-building verbs are objective work too,
// but are intentionally absent from the safety classifier's core mutation set.
// Canonicalizing only direct request-shaped occurrences lets both paths share
// the same authority rules without treating nouns such as "the build" as work.
const REQUESTED_ACTION_NOUN_AFTER_ANALYSIS = String.raw`\s*[,;:]?\s+(?:et|puis)\s+(?:(?:(?:une|des|les|la|le|son|sa|leur|leurs)\s+)|l['’]\s*)?(?:optimi?sation|corrections?|modifications?|changements?|d[ée]ploiement|installation|impl[ée]mentation|implanta(?:tion|iotn))s?\b`;

const REALYSE_MUTATION_TARGET = String.raw`\s+(?:(?:(?:un|une|le|la|ce|cet|cette|du|de\s+la|des)\s+|l['’]\s*)?(?:(?:nouvel|nouvelle|nouveau)\s+)?(?:analyse|alanlyse|audit|diagnostic|revue)s?\b${REQUESTED_ACTION_NOUN_AFTER_ANALYSIS})`;

const FRENCH_ACTION_NOUN_TARGET = String.raw`\s+(?:(?:(?:un|une|le|la|les|des|ce|cet|cette|ces|son|sa|leur|leurs)\s+)|l['’]\s*)?(?:(?:totales?|compl[èe]tes?|m[ée]thodiques?|n[ée]cessaires?|requis(?:e)?s?)\s+)*(?:optimi?sation|corrections?|modifications?|changements?|d[ée]ploiements?|installations?|impl[ée]mentations?|implanta(?:tions?|iotns?))\b`;

const ENGLISH_ACTION_NOUN_TARGET = String.raw`\s+(?:(?:an?|the|this|these|those|some|all)\s+)?(?:(?:necessary|required|requested|needed)\s+)?(?:fix(?:es)?|corrections?|modifications?|changes?|implementations?|installations?|deployments?|optimi[sz]ations?)\b`;

const ENGLISH_ANALYSIS_MUTATION_TARGET = String.raw`\s+(?:(?:an?|the|this|new)\s+)?(?:analysis|audit|diagnostic|review)\b\s*[,;:]?\s+(?:and|then)${ENGLISH_ACTION_NOUN_TARGET}`;

const SUPPORT_VERB_MUTATION_SOURCE = String.raw`(?:(?:fai(?:s|tes|re|sons)|effectu(?:e|er|ez|ons)|apport(?:e|er|ez|ons))(?=(?:${FRENCH_ACTION_NOUN_TARGET}|${REALYSE_MUTATION_TARGET}))|(?:met(?:s|tez|tons|tre)?\s+en\s+(?:[œo]uvre|oeuvre)|proc[èe]d(?:e|er|ez|ons)\s+[àa])(?=${FRENCH_ACTION_NOUN_TARGET})|(?:make|makes|made|making|perform(?:s|ed|ing)?|carry\s+out|run|runs|ran|running)(?=(?:${ENGLISH_ACTION_NOUN_TARGET}|${ENGLISH_ANALYSIS_MUTATION_TARGET}))|do(?![^.!?\n]{0,200}\?)(?=${ENGLISH_ACTION_NOUN_TARGET}))`;

const NON_MUTATING_REALISATION_TARGET = String.raw`\s+(?:(?:(?:un|une|le|la|ce|cet|cette|du|de\s+la|des)\s+|l['’]\s*)?(?:(?:nouvel|nouvelle|nouveau)\s+)?(?:analyse|audit|diagnostic|revue)s?\b(?!${REQUESTED_ACTION_NOUN_AFTER_ANALYSIS})|(?:(?:un|le|ce)\s+)?plan\s+(?:de|des)\s+corrections?\b)`;

// A contentful continuation is not the same thing as the bare acknowledgments
// handled by isBareObjectiveContinuation. Keep this grammar nominal and
// closed: it recognizes an explicit request to continue development,
// improvement or optimization, but not an analysis *of* possible changes.
const CONTINUED_FRENCH_ANALYSIS_AND_ACTION = String.raw`(?:(?:(?:l['’]|une?|la)\s*)?(?:analyse|alanlyse)s?\s+(?:et|puis)\s+(?:(?:l['’]|une?|la|les)\s*)?(?:optimi?[sz]ations?|corrections?))`;

const CONTINUED_ENGLISH_ANALYSIS_AND_ACTION = String.raw`(?:(?:(?:the|an?)\s+)?analysis\s+(?:and|then)\s+(?:(?:the|an?)\s+)?(?:optimi[sz]ations?|fix(?:es)?|corrections?))`;

const CONTINUED_ARTIFACT_MUTATION_SOURCE = String.raw`(?:(?:(?:ok(?:ay)?|oui|yes|d['’]accord|merci|thanks)\s+)?(?:poursui(?:s|t|vez|vre)|continu(?:e|er|ez|ons?))\s+(?:(?:(?:le|la|les|du|de\s+la|l['’])\s*)?(?:d[ée]veloppements?|am[ée]liorations?|optimi?[sz]ations?)|${CONTINUED_FRENCH_ANALYSIS_AND_ACTION})|(?:(?:ok(?:ay)?|oui|yes|thanks)\s+)?(?:continue|keep)\s+(?:(?:to|on)\s+)?(?:(?:(?:the|this|these|those|its)\s+)?(?:develop(?:ment|ing)?|improv(?:e|ing|ements?)|optimi[sz](?:e|ing|ations?))|${CONTINUED_ENGLISH_ANALYSIS_AND_ACTION}))`;

const OBJECTIVE_ARTIFACT_MUTATION_SOURCE = String.raw`(?:${SUPPORT_VERB_MUTATION_SOURCE}|${CONTINUED_ARTIFACT_MUTATION_SOURCE}|build(?!\s+(?:failed|fails|failure|status|log)\b)|implement(?:s|ed|ing)?|correct(?:s|ed|ing)?|develop(?:s|ed|ing)?|improv(?:e|es|ed|ing)|generate(?:s|d|ing)?|produce(?:s|d|ing)?|construct(?:s|ed|ing)?|refactor(?:s|ed|ing)?|optimis(?:e|es|ed|ing|er|ez|ons?)|optimiz(?:e|es|ed|ing)|r[ée]alis(?:e|er|ez|ons?)(?!${NON_MUTATING_REALISATION_TARGET})|r[ée]alys(?:e|er|ez|ons?)(?=${REALYSE_MUTATION_TARGET})|produi(?:s|t|re|sez|sons?)|constru(?:is|it|ire|isez|isons)|g[ée]n[ée]r(?:e|er|ez|ons?)|d[ée]velopp(?:e|er|ez|ons?)|am[ée]lior(?:e|es|er|ez|ons?)|refactoris(?:e|er|ez|ons?))`;

const OBJECTIVE_ARTIFACT_MUTATION_REQUEST = new RegExp(
  `(${AMENDMENT_REQUEST_PREFIX})(${OBJECTIVE_ARTIFACT_MUTATION_SOURCE})(?![\\p{L}\\p{N}_])`,
  'giu',
);

const DIRECT_FRENCH_CLINICAL_PROCEDURE_REQUEST = /^r[ée]alis(?:er|e(?:s|z)?|ons?)\s+(?:(?:une?)\s+)?(?:[\p{L}\p{M}'’_-]{3,}(?:ectomie|otomie|plastie|scopie|stomie)|biopsie)\b/iu;

// French users commonly type the noun "envoi" for the imperative "envoie".
// Recover only a direct request at the beginning of the human turn before
// applying the shared authority classifier. In particular, text following a
// label or quotation marker ("Exemple : envoi ...") is not authority.
const DIRECT_MISSPELLED_SEND_REQUEST_PREFIX = String.raw`^\s*(?:(?:\d+[.)]|[-*+])\s*)?(?:(?:maintenant|aussi|now|also)\s+)?(?:(?:merci de|please|tu dois|tu peux|vous devez|vous pouvez|peux-tu|pouvez-vous|can you|could you|je veux(?: que tu)?|je souhaite(?: que tu)?|il faut(?: que tu)?|j['’]ai besoin de)\s+)?`;

const MISSPELLED_SEND_IMPERATIVE_REQUEST = new RegExp(
  `(${DIRECT_MISSPELLED_SEND_REQUEST_PREFIX})envoi(?=\\s+(?:(?:l[’']\\s*)|(?:(?:le|la|les|un|une|ce|cet|cette)\\s+))?(?:e[- ]?mails?|emails?|mails?|messages?|invitations?)\\b)`,
  'iu',
);

export function canonicalizeMisspelledSendImperative(text: string): string {
  return text.replace(
    MISSPELLED_SEND_IMPERATIVE_REQUEST,
    (_match: string, prefix: string) => `${prefix}envoie`,
  );
}

/**
 * A user can delegate execution by asking the agent to handle an incoming
 * invoice-email request instead of repeating the nested request as a direct
 * imperative ("send the invoice"). Keep this recovery deliberately closed to
 * an invoice PDF resend: the turn must start with a direct handling verb and
 * the embedded request itself must ask for the resend. Merely quoting,
 * analysing, or describing an email remains observational.
 */
export function isDirectInvoiceEmailFulfillmentRequest(text: string): boolean {
  if (!text.trim() || text.length > 4_000) return false;
  const normalized = foldForIntent(text).replace(/-/g, ' ').replace(/\s+/g, ' ');
  const directHandling = /^(?:(?:merci de|please)\s+)?(?:traite|traitez|traiter|prends?\s+en\s+charge|prenez\s+en\s+charge|prendre\s+en\s+charge|occupe\s+toi\s+de|occupez\s+vous\s+de|handle|process|fulfil|fulfill)\b/.test(normalized);
  const embeddedResendRequest = /\b(?:(?:qui\s+)?(?:demande|demandant)\s+(?:de\s+|le\s+)?(?:renvoi|renvoie|renvoyer|reexpedition|reexpedie|reexpedier)|(?:asks?|asking|request(?:s|ed|ing)?)\s+(?:you\s+)?(?:to\s+)?(?:resend|send\s+(?:it\s+)?again))\b/.test(normalized);
  const invoicePdfEmail = /\b(?:facture|invoice)\b/.test(normalized)
    && /\bpdf\b/.test(normalized)
    && /\b(?:e\s+mail|email|mail)\b/.test(normalized);
  const explicitRevocation = /\b(?:(?:ne|n)\s+(?:(?:la|le|les|lui)\s+)?(?:renvoie|reexpedie|envoie|transmets)\b[^.!?;]{0,80}\b(?:pas|plus|rien|jamais)|(?:do\s+not|dont|never)\s+(?:resend|send|forward)|sans\s+(?:renvoi|renvoyer|envoi|envoyer)|without\s+(?:resending|sending|forwarding))\b/.test(normalized);
  return directHandling && embeddedResendRequest && invoicePdfEmail && !explicitRevocation;
}

/** A documentation phase followed by the user's explicit desire to create an
 * automated form is still an implementation objective. Bind this nominal
 * wording to the requested form plus its list/SharePoint persistence so
 * general prose about "la création" does not become write authority. */
export function isDirectAutomatedFormCreationRequest(text: string): boolean {
  if (!text.trim() || text.length > 4_000 || hasNonAuthoritativeStructuredLead(text)) return false;
  const normalized = foldForIntent(text).replace(/-/g, ' ').replace(/\s+/g, ' ');
  const desiredCreation = /(?:^|\b(?:puis|ensuite|then|and\s+then)\s+)(?:(?:je|nous)\s+(?:souhaite|souhaitons|veux|voulons)|i\s+(?:want|need|would\s+like)|we\s+(?:want|need|would\s+like))\s+(?:(?:la|une|the|a)\s+)?(?:creation|mise\s+en\s+place|building)\s+(?:dun|dune|d\s+un|d\s+une|of\s+an?|for\s+an?)\s+(?:(?:formulaire|form)\b[^.!?;]{0,80}\bautomatise|automated\s+form)\b/.test(normalized);
  const storesData = /\b(?:donnees|data)\b[^.!?;]{0,160}\b(?:doivent|devront|must|will)\b[^.!?;]{0,120}\b(?:stockees?|stocke|stocker|stored|store|saved|save)\b/.test(normalized);
  const namesList = /\b(?:liste|liset|list)\b/.test(normalized);
  const namesSharePointRh = /\bsharepoint\b[^.!?;]{0,80}\brh\b|\brh\b[^.!?;]{0,80}\bsharepoint\b/.test(normalized);
  return desiredCreation && storesData && namesList && namesSharePointRh;
}

// Compatibility recovery for the persisted development-login objective shape that
// predates `réactiver` in the shared mutation vocabulary. Keep the target
// closed to a development login so an absent legacy flag cannot generally be
// upgraded just because the classifier later learns another verb.
export const DEV_LOGIN_REACTIVATION_REQUEST = new RegExp(
  `r[ée]activ(?:er|e(?:s|z)?|ons?)(?![\\p{L}\\p{N}_])(?=[^.!?;\\n]{0,96}(?:dev(?:eloppement)?\\s+login|login\\s+(?:de\\s+)?d[ée]v(?:eloppement)?)(?![\\p{L}\\p{N}_]))`,
  'iu',
);

/** Recover the exact legacy implementation hand-off
 * before the French action-noun classifier accepted `leur implantation` and
 * its observed adjacent-letter typo. This is a closed migration shape, not a
 * generic reclassification of legacy observational objectives. */
export function isLegacyPlanImplementationRequest(text: string): boolean {
  const normalized = foldForIntent(text).replace(/-/g, ' ').replace(/\s+/g, ' ');
  return /^procede a leur implanta(?:tion|iotn) totale et methodique selon le plan$/.test(normalized);
}

export const ACTION_STATE_QUESTION_PATTERN = /^(?:do|does)\s+(?:(?:the|these|those)\s+)?(?:fix(?:es)?|corrections?|modifications?|changes?|implementations?|installations?|deployments?|optimi[sz]ations?)\s+(?:(?:still|already|currently)\s+)?(?:apply|work|exist|remain|look\s+(?:correct|valid|right)|seem\s+(?:correct|valid|right)|(?:need|require)\s+to\s+be\s+(?:applied|made|done))\s*\?$/i;

function isReportedSpeechArtifactMatch(text: string, offset: number, prefix: string): boolean {
  if (!/:\s*$/.test(prefix)) return false;
  const preceding = text.slice(Math.max(0, offset - 256), offset)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const reportingVerb = /\b(?:says?|said|states?|stated|indicates?|indicated|reports?|reported|mentions?|mentioned|recommends?|recommended|reads?|dit|disent|indique(?:nt)?|mentionne(?:nt)?|recommande(?:nt)?|rapporte(?:nt)?|stipule(?:nt)?)\s*$/.test(preceding);
  const structuredLabel = /(?:^|[.!?;\n])\s*(?:analysis|analyse|recommendation|recommandation|example(?:\s+instruction)?|exemple(?:\s+d['’]?\s*instruction)?|citation|quote|subject|sujet|question|hypothesis|hypothese|option|proposal|proposition|scenario|instruction|consigne)\s*$/.test(preceding);
  // A request to inspect quoted/meta instructions does not grant those
  // instructions authority. Keep this deliberately anchored to the complete
  // clause immediately before the colon: an ensuing `then implement ...`
  // remains an independently executable instruction.
  const metaInspection = /(?:^|[.!?;\n])\s*(?:(?:please|merci\s+de)\s+)?(?:analyse|analyze|review|audit|inspect|explain|examine|read|analyse[rz]?|audite[rz]?|inspecte[rz]?|examine[rz]?|explique[rz]?|(?:revois|revoyez|revoir)|(?:lis|lisez|lire))\s+(?:(?:this|that|the|these|those|following|cette?|ces|la|le|les|une?|des)\s+)?(?:instructions?|consignes?|prompts?|requests?|demandes?|tasks?|taches?|texts?|textes?|messages?|guides?|documentation|examples?|exemples?)\s*$/.test(preceding);
  return reportingVerb || structuredLabel || metaInspection;
}

export function canonicalizeObjectiveArtifactMutations(text: string): string {
  const canonicalImperatives = canonicalizeMisspelledSendImperative(text);
  const canonicalArtifacts = canonicalImperatives.replace(
    OBJECTIVE_ARTIFACT_MUTATION_REQUEST,
    (match: string, prefix: string, _source: string, offset: number) => {
      if (isReportedSpeechArtifactMatch(canonicalImperatives, offset, prefix)) return match;
      const actionOffset = offset + prefix.length;
      if (DIRECT_FRENCH_CLINICAL_PROCEDURE_REQUEST.test(canonicalImperatives.slice(actionOffset))) {
        return match;
      }
      return `${prefix}create`;
    },
  );
  // Preserve the complete human text for target/risk analysis while making
  // the direct top-level delegation visible to the shared mutation classifier.
  if (isDirectInvoiceEmailFulfillmentRequest(text)) {
    return `Send the requested invoice PDF by email.\n${canonicalArtifacts}`;
  }
  if (isDirectAutomatedFormCreationRequest(text)) {
    return `Create the requested automated form and persist its data.\n${canonicalArtifacts}`;
  }
  return canonicalArtifacts;
}

export function hasDirectObjectiveArtifactMutation(text: string): boolean {
  const matcher = new RegExp(
    OBJECTIVE_ARTIFACT_MUTATION_REQUEST.source,
    OBJECTIVE_ARTIFACT_MUTATION_REQUEST.flags,
  );
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    if (!isReportedSpeechArtifactMatch(text, match.index, match[1] ?? '')) return true;
  }
  return false;
}

const ANALYTICAL_DECISION_CLAUSE_PATTERN = /^(?:(?:analyse|analysez|analyze|review|evalue|evaluez|evaluate|verifie|verifiez|verify|check)\s+(?:si|if|whether)|(?:faut-il|doit-on|devrait-on|faudrait-il|est-ce\s+qu(?:il|on)|should\s+we|would\s+it|do\s+we\s+need\s+to|is\s+it\s+(?:necessary|better|advisable)\s+to))\b/;

/** Asking whether an action is needed remains analysis even when a subordinate
 * clause says it "must" happen. A later independent imperative owns its own
 * authority, while commas inside the analytical question do not. */
export function isAnalyticalDecisionDiscussion(text: string): boolean {
  const normalized = foldForIntent(text);
  if (!ANALYTICAL_DECISION_CLAUSE_PATTERN.test(normalized)) return false;
  const clauseRequestsMutation = (clause: string): boolean => {
    const canonicalClause = canonicalizeObjectiveArtifactMutations(clause.trim());
    return canonicalClause.length > 0 && classifyObjectiveMutationRisk(canonicalClause, {
      authorityText: canonicalClause,
    }).mutationRequested;
  };
  const sentenceFollowUps = text
    .split(/[.!?;\n]+/u)
    .map(clause => clause.trim())
    .filter(Boolean)
    .slice(1);
  const conditionalFollowUp = /:\s*(?:(?:si\s+oui)|(?:if\s+so))\b([\s\S]*)$/iu.exec(text)?.[0];
  // A comma + explicit sequence can introduce a direct imperative, but a
  // question such as "whether we should fix, then deploy?" keeps both verbs
  // subordinate to the analytical decision.
  const sequencedFollowUp = !/\?\s*$/u.test(text)
    ? /,\s*(?:puis|ensuite|then|and\s+then)\b([\s\S]*)$/iu.exec(text)?.[0]
    : undefined;
  const laterIndependentMutation = [
    ...sentenceFollowUps,
    conditionalFollowUp,
    sequencedFollowUp,
  ].some(clause => typeof clause === 'string' && clauseRequestsMutation(clause));
  return !laterIndependentMutation;
}

/** A causal conclusion can be the user's decision, not another request to
 * analyse whether access should be granted. Keep this deliberately narrow:
 * it requires an affirmative first-person plural decision, an access-grant
 * verb and an access object in the same sentence. */
export const ACCESS_GRANT_DECISION_PATTERN = /^(?:donc|alors|ainsi|par consequent)\s+(?:(?:maintenant|finalement)\s+)?(?:on\s+peut|nous\s+pouvons)\s+(?:(?:maintenant|finalement)\s+)?(?:(?:lui|leur|vous|te|nous)\s+)?(?:ouvrir|retablir|restaurer|accorder|donner)\s+(?:(?:un|le|les|des)\s+)?(?:lacces|acces|droits?\s+dacces)\b/u;
