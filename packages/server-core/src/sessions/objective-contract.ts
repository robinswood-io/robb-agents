import { hasShellOutputRedirection } from '@craft-agent/shared/agent/bash-validator';
import { createHash } from 'node:crypto';
import type { Message } from '@craft-agent/core/types';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import { classifyToolNameMutationSemantics, detectHighStakesEvidenceDomain, isConcreteOperationalSoftwareRestatement, isExplicitNonMedicalOperationalTreatmentClarification, isOperationalTechnicalContractLifecycleObjective, isProvablyReadOnlyShellCommand, normalizeToolLeafName, parseStructuredGmailSendResumeSegment, stripExplicitNonMedicalOperationalTreatmentClarification } from '@craft-agent/shared/agent';
import { classifyObjectiveMutationRisk, isContextDependentDirectTurn } from '@craft-agent/shared/config';
import { FINAL_RESPONSE_GUIDANCE, PROGRESS_GUIDANCE } from '@craft-agent/shared/prompts';
import { requiresStructuredObjectiveOutcome } from './objective-completion-policy.ts';
import { nativeQuestionCompletionRefs } from './native-question-completion.ts';
import { businessProcedurePrompt } from './business-procedures.ts';
import { DELEGATION_LIMITS } from './delegation-budget.ts';
import { YOLO_AUTONOMY_GUIDANCE } from '@craft-agent/shared/agent';

const MULTI_STEP_PATTERN = /\b(?:puis|ensuite|et\s+(?:v[ée]rifie|teste|corrige|impl[ée]mente|d[ée]ploie)|tous\s+les\s+points|l['’]ensemble\s+de\s+ces\s+points|de\s+bout\s+en\s+bout|end[- ]to[- ]end|multi[- ]?[ée]tapes?)\b/i;
const OBSERVATION_REQUEST_PATTERN = /\b(?:inspect\w*|audit\w*|v[ée]rifi\w*|contr[oô]l\w*|check|verify)\b/i;
// An amendment can contain exclusions and historical descriptions. Only a
// positive request adds work; words inside "ne modifie rien" are not a write.
const AMENDMENT_REQUEST_PREFIX = String.raw`(?:^|[.!?;:\n,]|\b(?:et|puis|ensuite|mais|and|then|but)\s+)\s*(?:(?:\d+[.)]|[-*+])\s*)?(?:(?:maintenant|aussi|now|also)\s+)?(?:(?:merci de|please|tu dois|tu peux|vous devez|vous pouvez|peux-tu|pouvez-vous|can you|could you|je veux(?: que tu)?|je souhaite(?: que tu)?|il faut(?: que tu)?|j['’]ai besoin de)\s+)?`;
const AMENDMENT_OBSERVATION_REQUEST = new RegExp(AMENDMENT_REQUEST_PREFIX + String.raw`(?:inspect(?:e|er|ez)?|audit(?:e|er|ez)?|verifi(?:e|er|ez)|control(?:e|er|ez)|check|verify)\b`, 'i');
// A new artifact may be a correction inside the current mission. Only a direct
// declaration or instruction changing the mission can discard its contract.
// Anchoring also excludes mentions such as "ne change pas de sujet".
const EXPLICIT_NEW_OBJECTIVE_PATTERNS = [
  /^(?:(?:je\s+(?:veux|souhaite)|jai)\s+)?(?:(?:un|une)\s+)?(?:nouvel(?:le)?|nouveau|autre|different(?:e)?)\s+(?:objectif|mission|tache|demande|sujet|projet)\b/i,
  /^(?:(?:i\s+(?:want|have|need))\s+)?(?:a\s+)?(?:new|another|different)\s+(?:objective|mission|task|request|topic|project)\b/i,
  /^(?:changeons|changez?|passons?)\s+(?:de\s+|d)(?:sujet|objectif|mission|tache)\b/i,
  /^passons?\s+(?:a|sur)\s+(?:(?:un|une)\s+)?(?:nouvel(?:le)?|nouveau|autre)\s+(?:objectif|mission|tache|sujet|projet)\b/i,
  /^(?:switch|move)\s+to\s+(?:a\s+)?(?:new|another|different)\s+(?:objective|mission|task|topic|project)\b/i,
  /^(?:abandonne|annule|oublie|arrete|stoppe)\s+(?:(?:cet?|cette|la|le|notre)\s+|l)?(?:objectif|mission|tache|demande|travail)\b/i,
  /^(?:abandon|cancel|forget|stop)\s+(?:(?:this|the|current|previous)\s+)*(?:objective|mission|task|request)\b/i,
];
const CONTINUATION_FILLER_PATTERN = /^(?:(?:bah|ben|bon|alors|donc|non|ok|okay|oui|yes|daccord|vas\s+y|allez\s+y)\s+)*(?:et\s+)?(.+)$/i;
const CONTINUATION_REFERENCE_PATTERN = /(?:\b(?:encore|aussi|precedent|precedente|above|again|remaining|restant\w*)\b|\b(?:la\s+suite|le\s+reste)\b)/i;
const CONTINUATION_REOPEN_PATTERN = /(?:\b(?:pas|not)\s+(?:termine|fini|fait|complet|verified|done|finished|exhausti(?:f|ve))\b|\b(?:il\s+manque|tu\s+nas\s+pas|tu\s+as\s+(?:oublie|omis|zappe|saute)|ca\s+ne\s+(?:marche|fonctionne)\s+pas|keep\s+going|carry\s+on|ou\s+sont\s+(?:les|l)|where\s+are\s+the)\b|\b(?:avec\s+precision|plus\s+de\s+precision|plus\s+precisement|sois\s+plus\s+precis|soyez\s+plus\s+precis|precise(?:z)?|detaille(?:z)?|plus\s+de\s+details?|approfondi[sz]?|incomplet|incomplete|insuffisant|insuffisante|exhausti(?:f|ve)|inexhausti(?:f|ve)|creuse(?:z)?|va\s+plus\s+loin|allez\s+plus\s+loin|dig\s+deeper)\b|\b(?:ce\s+n\s*est\s+pas|c\s*est\s+(?:pas\s+)?)\s*(?:complet|suffisant|assez|precis|incomplet|insuffisant|exhausti(?:f|ve))\b|\b(?:trop\s+(?:court|bref|breve|sommaire|superficiel(?:le)?|succinct(?:e)?|leger|legere)|too\s+(?:shallow|brief|short|superficial))\b|\b(?:more\s+precis\w*|be\s+more\s+precise|more\s+details?|in-?depth|incomplete|insufficient|not\s+enough|not\s+complete|not\s+exhaustive|missing\s+\w+)\b)/i;
const PRECISION_OR_COMPLETENESS_CHALLENGE_PATTERN = /(?:(?:^|[\s,;:.!?-])(?:avec\s+pr[ée]cision|plus\s+de\s+pr[ée]cision|plus\s+pr[ée]cis[ée]ment|sois\s+plus\s+pr[ée]cis|soyez\s+plus\s+pr[ée]cis|pr[ée]cise(?:z)?|d[ée]taille(?:z)?|plus\s+de\s+d[ée]tails?|approfondi[sz]?|incomplet|incompl[èe]te|insuffisant|insuffisante|exhausti(?:f|ve)s?|inexhausti(?:f|ve)s?|creuse(?:z)?|va\s+plus\s+loin|allez\s+plus\s+loin)(?:\b|[\s,;:.!?-]|$)|(?:ce\s+n['’]est\s+pas|c['’]est\s+(?:pas\s+)?)\s*(?:complet|suffisant|assez|pr[ée]cis|incomplet|insuffisant|exhausti(?:f|ve)s?)(?:\b|[\s,;:.!?-]|$)|(?:pas\s+(?:assez\s+)?|non\s+)(?:exhausti(?:f|ve)s?|complet|pr[ée]cis|suffisant)(?:\b|[\s,;:.!?-]|$)|(?:trop\s+(?:court|bref|br[èe]ve|sommaire|superficiel(?:le)?|succinct(?:e)?|l[ée]ger|l[ée]g[èe]re)|too\s+(?:shallow|brief|short|superficial))(?:\b|[\s,;:.!?-]|$)|(?:il\s+(?:n['’]y\s+a\s+pas|manque)|tu\s+(?:n['’]as\s+pas|as\s+oubli[ée]|as\s+omis|as\s+zapp[ée]|as\s+saut[ée])|(?:o[ùu]|ou)\s+sont\s+(?:les|l['’]))(?:\b|[\s,;:.!?-]|$)|(?:more\s+precis\w*|be\s+more\s+precise|more\s+details?|in-?depth|incomplete|insufficient|not\s+enough|not\s+complete|not\s+exhaustive|dig\s+deeper|where\s+are\s+the|missing\s+\w+)\b)/i;

export function isPrecisionOrCompletenessChallenge(text: string): boolean {
  if (hasNonAuthoritativeStructuredLead(text)) return false;
  const normalized = text.trim();
  if (normalized.length > 500) return false;
  return PRECISION_OR_COMPLETENESS_CHALLENGE_PATTERN.test(normalized);
}
const CONTINUATION_VERBS = [
  'avance', 'continue', 'continuer', 'poursuis', 'poursuit', 'poursuivre',
  'reprend', 'reprends', 'reprendre',
] as const;

/** A terse correction of the execution channel steers an active or incomplete
 * accepted mission. It is deliberately insufficient to reopen a verified
 * mission: doing so would recover the old target and mutation authority from a
 * channel-only sentence and could repeat an already verified side effect. */
function isExecutionChannelCorrection(text: string): boolean {
  if (hasNonAuthoritativeStructuredLead(text)) return false;
  if (!text.trim() || text.length > 600) return false;

  // Preserve punctuation as an instruction boundary. Looking for unrelated
  // words across the whole turn (for example “non”, “avec”, “UI” and “API”)
  // turns documentation or comparison requests into authority for an old
  // terminal objective. Each positive side must instead be a direct bounded
  // channel instruction.
  const clauses = text.split(/[.!?;,\n]+/u).map(foldForIntent).filter(Boolean);
  if (clauses.length === 0 || clauses.length > 4) return false;
  const interactiveChannel = String.raw`(?:(?:l\s*)|(?:le|la|the)\s+)?(?:navigateur|browser|interface|ui)(?:\s+(?:web|graphique|interactive|ui))?`;
  const structuredChannel = String.raw`(?:(?:l\s*|the\s+)?api(?:\s+connector)?|(?:la\s+|the\s+)?source|(?:le\s+|the\s+)?(?:connecteur|connector)|mcp|ssh|(?:le\s+|the\s+)?(?:serveur|server))`;
  // A directly addressed operating rule is an API-first correction even when
  // it does not repeat the browser prohibition. Keep the wording and channel
  // closed: prose about a rule, examples, and any trailing operation fail the
  // whole-clause match and cannot recover an exhausted objective.
  const explicitStructuredChannelRule = new RegExp(
    String.raw`^(?:tu\s+as|vous\s+avez)\s+pour\s+regle\s+(?:de\s+passer\s+par|(?:de\s+|d\s*)utiliser)\s+${structuredChannel}$`,
  );
  const inlineInteractiveRejectionSource = String.raw`(?:plutot\s+que|au\s+lieu\s+de|rather\s+than|instead\s+of|pas\s+via|pas\s+par|not\s+via|not\s+through|not|(?:et\s+)?(?:non|pas))\s+${interactiveChannel}`;
  // Preserve the production correction that explains why the browser is
  // forbidden for the existing mail objective. This is a closed purpose
  // phrase, not a general suffix that could append fresh work or a new target.
  const boundedMailPurpose = String.raw`(?:\s+(?:pour|afin\s+de|to)\s+(?:envoyer|send)\s+(?:(?:des?|les?|the)\s+)?(?:e[- ]?mails?|emails?|mails?|messages?))?`;
  const structuredDirective = new RegExp(
    String.raw`^(?:(?:non|no|mais|but|et|and|alors|then)\s+)?(?:` +
      String.raw`(?:(?:tu|vous)\s+(?:dois|devez)\s+(?:utiliser|passer\s+par)|(?:tu\s+as|vous\s+avez)\s+(?:l\s*)?obligation\s+(?:d\s*)?(?:utiliser|passer\s+par)|il\s+faut\s+(?:utiliser|passer\s+par)|you\s+must\s+use)` +
      String.raw`|(?:utilise|utilisez|use|passe|passez)(?:\s+par)?)\s+` +
      String.raw`(?:(?:uniquement|exclusivement|only)\s+)?(?:via\s+)?${structuredChannel}` +
      String.raw`(?:\s+(?:et|and)\s+${structuredChannel})*` +
      String.raw`(?:\s+${inlineInteractiveRejectionSource})?$`,
  );
  const interactiveRejection = new RegExp(
    String.raw`^(?:(?:non|no|mais|but|et|and|alors|then)\s+)?(?:(?:tu|vous|you)\s+)?(?:` +
      String.raw`n(?:a|as)\s+pas\s+le\s+droit\s+dutiliser|ne\s+dois\s+pas\s+utiliser|ne\s+devez\s+pas\s+utiliser|nutilise\s+pas|nutilisez\s+pas` +
      String.raw`|do\s+not\s+use|dont\s+use|must\s+not\s+use|cannot\s+use|cant\s+use|interdit\s+dutiliser)\s+${interactiveChannel}${boundedMailPurpose}$` +
      String.raw`|^(?:(?:mais|but|et|and)\s+)?(?:pas|not)\s+${interactiveChannel}$`,
  );
  const inlineInteractiveRejection = new RegExp(
    String.raw`\b${inlineInteractiveRejectionSource}$`,
  );

  const requiresStructuredChannel = clauses.some(clause => structuredDirective.test(clause));
  const hasExplicitStructuredChannelRule = clauses.some(clause => explicitStructuredChannelRule.test(clause));
  const rejectsInteractiveChannel = clauses.some(clause => interactiveRejection.test(clause)
    || structuredDirective.test(clause) && inlineInteractiveRejection.test(clause));
  const fillerOnly = /^(?:non|no|mais|but|et|and|alors|then)$/u;
  const containsOnlyChannelDirectives = clauses.every(clause => fillerOnly.test(clause)
    || structuredDirective.test(clause) || explicitStructuredChannelRule.test(clause)
    || interactiveRejection.test(clause));
  return containsOnlyChannelDirectives
    && (requiresStructuredChannel && rejectsInteractiveChannel || hasExplicitStructuredChannelRule);
}

const OBSERVATION_TARGET_KEY_PATTERN = /^(?:action|cmd|command|file|file_path|filename|id|key|operation|path|pattern|q|query|ref_id|resource|search|search_query|sessionId|target|threadId|uri|url)$/i;
const MUTATION_TRANSFORM_KEY_PATTERN = /^(?:body|content|data|diff|edits|new_string|newText|old_string|oldText|patch|payload|replacement|text|value)$/i;
const PASSIVE_NO_PROGRESS_TOOL_PATTERN = /(?:^|[_:\-.])(?:wait|sleep|reload|refresh)(?:$|[_:\-.])/i;
const PASSIVE_NO_PROGRESS_ACTION_PATTERN = /^(?:wait|sleep|poll|reload|refresh)(?:\b|_)/i;
const NON_EXECUTED_CHECKPOINT_PATTERN = /(?:\bcost guard(?: checkpoint)?\s*:|\bwas not started\b|\btool-call (?:budget|checkpoint)\b.{0,120}\b(?:blocked|not (?:started|executed))\b)/i;
const NON_SUBSTANTIVE_TOOL_RESULT_PATTERN = /^(?:\[?auto[- ]?completed\]?|completed automatically|tool completed|completed|done|ok|success)$/i;
const GENERIC_EXECUTE_TOOL_PATTERN = /(?:^|[_:\-.])(?:exec|execute)(?:$|[_:\-.])/i;
const SESSION_COORDINATION_TOOL_PATTERN = /^(?:mcp__session__|session__|functions\.)?(?:send_agent_message|request_user_input|get_session_info)$/;
const PLAN_TRACKING_TOOL_PATTERN = /^(?:functions\.|mcp__session__|session__)?(?:update_plan|TodoWrite|todo_write)$/;
// This exact first-party operation is a non-executing dry run despite the
// mutation verb in its name. Keep the exception closed to the connector tool
// already admitted as a read by the shared permission classifier; lookalike
// providers and compound preflight-and-send names remain mutations/unknowns.
const OBJECTIVE_NON_EXECUTING_PREFLIGHT_TOOLS = new Set([
  'mcp__google-contacts__gmail_send_preflight',
]);
const MUTATION_HTTP_METHOD_PATTERN = /^(?:DELETE|PATCH|POST|PUT)$/i;
const POSITIVE_MUTATION_HTTP_METHOD_PATTERN = /^(?:DELETE|PATCH|PUT)$/i;
const POSITIVE_HTTP_POST_TARGET_TOKENS = new Set([
  'accept', 'activate', 'add', 'approve', 'archive', 'assign', 'attach',
  'cancel', 'change', 'clone', 'close', 'commit', 'configure', 'copy',
  'create', 'deactivate', 'delete', 'deploy', 'disable', 'disconnect',
  'duplicate', 'forward', 'grant', 'insert', 'install', 'invite', 'link',
  'lock', 'mark', 'merge', 'modify', 'move', 'pay', 'pin', 'publish',
  'purchase', 'purge', 'provision', 'remove', 'rename', 'replace', 'reply',
  'reset', 'restart', 'restore', 'revoke', 'rotate', 'save', 'schedule',
  'send', 'set', 'share', 'sign', 'start', 'stop', 'submit', 'transfer',
  'trigger', 'update', 'upload', 'upsert', 'write',
]);
const MUTATION_SQL_PATTERN = /^\s*(?:ALTER|CALL|COPY|CREATE|DELETE|DO|DROP|EXEC(?:UTE)?|GRANT|INSERT|MERGE|REPLACE|REVOKE|TRUNCATE|UPDATE|UPSERT|VACUUM)\b/i;
const MAX_CANONICAL_INPUT_CHARS = 4_096;
const MAX_RESULT_DIGEST_CHARS = 16_384;
const MAX_TRANSFORM_DIGEST_CHARS = 16_384;

export const OBJECTIVE_OUTCOME_CONTINUE_EXAMPLE =
  '<!-- robb_objective_outcome {"state":"continue","criteria":[],"remainingWork":["describe the next concrete step"],"blocker":null} -->';

export interface ObjectiveTransitionInput {
  existing?: ActiveSessionObjective;
  messageId: string;
  text: string;
  lifetimeCostUsd?: number;
  lifetimeTokens?: number;
  nowMs?: number;
  delegatedRole?: 'worker' | 'reviewer';
}

function foldForIntent(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

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

function canonicalizeMisspelledSendImperative(text: string): string {
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
function isDirectInvoiceEmailFulfillmentRequest(text: string): boolean {
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
function isDirectAutomatedFormCreationRequest(text: string): boolean {
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
const DEV_LOGIN_REACTIVATION_REQUEST = new RegExp(
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
const ACTION_STATE_QUESTION_PATTERN = /^(?:do|does)\s+(?:(?:the|these|those)\s+)?(?:fix(?:es)?|corrections?|modifications?|changes?|implementations?|installations?|deployments?|optimi[sz]ations?)\s+(?:(?:still|already|currently)\s+)?(?:apply|work|exist|remain|look\s+(?:correct|valid|right)|seem\s+(?:correct|valid|right)|(?:need|require)\s+to\s+be\s+(?:applied|made|done))\s*\?$/i;

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

function canonicalizeObjectiveArtifactMutations(text: string): string {
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

function hasDirectObjectiveArtifactMutation(text: string): boolean {
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
function isAnalyticalDecisionDiscussion(text: string): boolean {
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
const ACCESS_GRANT_DECISION_PATTERN = /^(?:donc|alors|ainsi|par consequent)\s+(?:(?:maintenant|finalement)\s+)?(?:on\s+peut|nous\s+pouvons)\s+(?:(?:maintenant|finalement)\s+)?(?:(?:lui|leur|vous|te|nous)\s+)?(?:ouvrir|retablir|restaurer|accorder|donner)\s+(?:(?:un|le|les|des)\s+)?(?:lacces|acces|droits?\s+dacces)\b/u;

function awaitsFutureExecutionAuthority(candidate: string): boolean {
  if (/^(?:en\s+principe|in\s+principle)\b/u.test(candidate)) return true;
  const conditionalLead = /^(?:(?:seulement\s+|uniquement\s+|only\s+)?(?:si|if)\b|(?:des\s+que|des\s+obtention\b|une\s+fois(?:\s+que)?|as\s+soon\s+as|once)\b|(?:a\s+condition\s+(?:que|davoir)|sous\s+reserve\b|pourvu\s+que|provided\s+that|subject\s+to\b)|(?:(?:uniquement|seulement)\s+avec|only\s+with|pas\s+avant|not\s+before)\b|(?:a\s+reception\s+de|upon\s+receipt\s+of|pending\s+receipt\b)|(?:apres|en\s+attente\s+de|after|pending)\b|(?:quand|lorsque|when)\b)/u.test(candidate);
  if (!conditionalLead) return false;
  const directlyVerifiable = /^(?:(?:si|if)\s+(?:necessaire|needed)\b|(?:si|if)\s+cela\b[^.!?;]{0,40}\bdebloque\b|(?:si|if)\s+(?:tout\s+est\s+bon|everything\s+is\s+(?:ready|good|ok))\b)/u.test(candidate);
  const volitionalDecision = /\b(?:souhait\w*|veut|veulent|want\w*|demand\w*|request\w*|estim\w*|jug\w*|decid\w*|convien\w*|accord|aval|feu\s+vert|go[- ]?ahead|oppos\w*|objection)\b/u.test(candidate);
  const validationDecision = /\b(?:confirm\w*|valid\w*|appr(?:ouv|ob)\w*|autoris\w*|accept\w*)\b/u.test(candidate);
  const passiveValidator = /\b(?:est|sont|a\s+ete|ont\s+ete|is|are|was|were|has\s+been|have\s+been)\s+(?:confirm\w*|valid\w*|appr(?:ouv|ob)\w*)\s+(?:par|by)\s+(?:(?:le|la|les|the)\s+)?([^.!?;,]{1,60})/u.exec(candidate)?.[1];
  const passiveHumanValidator = passiveValidator !== undefined
    && !/^(?:pipeline|job|script|tests?|systeme|automatisation|ci|github\s+actions)\b/u.test(passiveValidator.trim());
  const validationAsObservableState = /\b(?:est|sont|a\s+ete|ont\s+ete|is|are|was|were|has\s+been|have\s+been)\s+(?:confirm\w*|valid\w*|appr(?:ouv|ob)\w*)\b/u.test(candidate);
  const explicitTechnicalValidator = /\bautomatiq\w*\b/u.test(candidate)
    || /\b(?:par|by)\s+(?:(?:le|la|les|the)\s+)?(?:pipeline|job|script|tests?|systeme|automatisation|ci|github\s+actions)\b/u.test(candidate)
    || /^(?:(?:si|if)\s+|(?:des\s+que|une\s+fois\s+que|as\s+soon\s+as|once|quand|lorsque|when)\s+)(?:(?:le|la|les|the)\s+)?(?:pipeline|job|script|tests?|systeme|automatisation|ci|github\s+actions)\s+(?:(?:a|has)\s+)?(?:confirm\w*|valid\w*|appr(?:ouv|ob)\w*)\b/u.test(candidate);
  const opinionActor = /^(?:(?:si|if)\s+|(?:des\s+que|une\s+fois\s+que|as\s+soon\s+as|once|quand|lorsque|when)\s+)(?:(?:le|la|les|the)\s+)?([^.!?;,]{1,60}?)\s+(?:dit|says?|repond|responds?|trouve|finds?|considere|considers?)\b/u.exec(candidate)?.[1];
  const humanOpinion = opinionActor !== undefined
    && !/^(?:pipeline|job|script|tests?|systeme|automatisation|ci|github\s+actions|service|[ld]?api|endpoint)\b/u.test(opinionActor.trim());
  // Confirmation/validation verbs are human authority by default, regardless
  // of a person's name or role. Only an explicit automated technical actor can
  // turn them into an observable condition.
  if (volitionalDecision || humanOpinion || passiveHumanValidator
    || validationDecision && !validationAsObservableState && !explicitTechnicalValidator) return true;
  const technicalSubject = /\b(?:script|tests?|controle|verification|build|job|pipeline|ci|github\s+actions|service|[ld]?api|endpoint|chemins?|fichier|dossier|permissions?|configuration|procedure|revision|version|hash|checksum|certificat|commit|branche|conteneur|route|ports?|reponse\s+http|deploiement|synchronisation|migration|processus|systeme|automatisation)\b/u.test(candidate);
  const observableTechnicalState = /\b(?:automatiq\w*|fini\w*|termin\w*|reussi\w*|passe\w*|vert|green|ok|bon|ready|correct\w*|valid\w*|appr(?:ouv|ob)\w*|execut\w*|deploy\w*|disponible|actif|sain|ouvert\w*|accessibl\w*|conform\w*|contien\w*|vaut|retourn\w*|repond\w*|correspond\w*|existe\w*|absent\w*)\b/u.test(candidate);
  // A conditional access sentence is not immediate execution authority unless
  // its condition is explicitly host-verifiable. Unknown or human conditions
  // remain non-authoritative without trying to enumerate every way to say yes.
  return !(directlyVerifiable || technicalSubject && observableTechnicalState);
}

function accessGrantDecisionDisposition(
  text: string,
): 'affirmative' | 'non_authoritative' | undefined {
  const containsAccessDecisionLine = text.split(/\r?\n/u)
    .some(line => ACCESS_GRANT_DECISION_PATTERN.test(foldForIntent(line.trim())));
  if (containsAccessDecisionLine && (
    hasNonAuthoritativeStructuredLead(text)
    || /```[\s\S]*?```/u.test(text)
    || /^\s*>/mu.test(text)
  )) return 'non_authoritative';

  const clauses = text.match(/[^.!?;\n]+[.!?;]?/gu) ?? [];
  let sawAffirmativeDecision = false;
  for (const [clauseIndex, rawClause] of clauses.entries()) {
    const clause = foldForIntent(rawClause);
    const decision = ACCESS_GRANT_DECISION_PATTERN.exec(clause);
    if (decision) {
      const tail = clause.slice(decision[0].length).trim();
      const normalizedTail = tail
        .replace(/^[,\s]+/u, '')
        .replace(/^(?:mais|toutefois|cependant|pourtant|but|however)\s+/u, '')
        .trim();
      const confirmationTail = normalizedTail.replace(/-/gu, ' ');
      const asksForConfirmation = /\?\s*$/u.test(rawClause)
        || /\b(?:nest[- ]ce pas|ou pas|non|right|cest bien ca|c est bien ca)\s*[.!]?\s*$/u.test(clause)
        || /\b(?:ou bien\s+)?(?:faut[- ]il|doit[- ]on|devons[- ]nous|est[- ]ce)\b/u.test(tail)
        || /^(?:(?:tu|vous)\s+confirm\w*|confirm\w*\s+moi|(?:tu|vous)\s+(?:en\s+)?(?:es|etes)\s+sur(?:e|s|es)?|vraiment|daccord|on\s+est\s+daccord|correct|certain(?:e|s|es)?|sure|really|agreed|right)\s*[.!]?$/u.test(confirmationTail);
      const awaitsFutureAuthority = awaitsFutureExecutionAuthority(normalizedTail);
      const revokesExecution = matchesExecutionAuthorityRevocation(normalizedTail)
        || /\b(?:mais|but|however)\s+(?:(?:ne|n)\s+)?(?:le\s+)?(?:fais|faites|faire|execute|executez|executer|ouvre|ouvrez|ouvrir)\b[^.!?;]{0,60}\b(?:pas|plus|jamais)\b/u.test(tail)
        || /\b(?:sans|without)\s+(?:(?:le|l)\s+)?(?:faire|executer|ouvrir|doing|executing|opening)\b/u.test(tail);
      const priorRevokesExecution = clauses.slice(0, clauseIndex).some(priorRawClause => {
        const priorClause = foldForIntent(priorRawClause).replace(/-/gu, ' ').trim();
        return matchesExecutionAuthorityRevocation(priorClause)
          || /^(?:(?:analyse|analysez|analyze|review)\b[^.!?;]{0,100}\b(?:seulement|uniquement|only)|(?:analyse|analysez|analyze|review)\b[^.!?;]{0,100}\b(?:sans\s+agir|without\s+acting))\b/u.test(priorClause)
          || /^(?:ne\s+(?:fais|faites|faire|effectue|effectuez|execut(?:e|ez|er))\b[^.!?;]{0,50}\b(?:aucune|rien)|(?:do\s+not|dont)\s+(?:change|modify|write|execute)\s+anything)\b/u.test(priorClause)
          || /^(?:nouvre|ne\s+ouvre)\b[^.!?;]{0,60}\b(?:rien|pas|plus|jamais)\b/u.test(priorClause);
      });
      if (asksForConfirmation || awaitsFutureAuthority || revokesExecution || priorRevokesExecution) return 'non_authoritative';
      sawAffirmativeDecision = true;
      continue;
    }
    if (sawAffirmativeDecision) {
      const laterClause = clause
        .replace(/-/gu, ' ')
        .replace(/^(?:mais|toutefois|cependant|pourtant|but|however)\s+/u, '')
        .trim();
      const normalizedLaterConfirmation = laterClause.replace(/-/gu, ' ');
      const laterQuestion = (
        /\?\s*$/u.test(rawClause) && (
          /\b(?:faire|ouvrir|acces|droits?|attendre|confirm\w*|recommand\w*)\b/u.test(laterClause)
            && /^(?:(?:faut il|doit on|devons nous|est ce|cest ce)\b|(?:peux tu|pouvez vous|tu|vous)\b[^.!?;]{0,60}\bconfirm\w*)/u.test(laterClause)
          || /^(?:(?:tu|vous)\s+(?:en\s+)?(?:es|etes)\s+sur(?:e|s|es)?|vraiment|daccord|on\s+est\s+daccord|correct|certain(?:e|s|es)?|sure|really|agreed|right)$/u.test(laterClause)
        )) || /^(?:(?:tu|vous)\s+confirm\w*|confirm\w*\s+moi|(?:tu|vous)\s+(?:en\s+)?(?:es|etes)\s+sur(?:e|s|es)?|vraiment|daccord|on\s+est\s+daccord|correct|certain(?:e|s|es)?|sure|really|agreed|right)\s*[.!]?$/u.test(normalizedLaterConfirmation);
      const laterRevocation = matchesExecutionAuthorityRevocation(laterClause)
        || /^(?:ne\s+le\s+fais|nouvre|ne\s+ouvre|ne\s+louvre)\b[^.!?;]{0,60}\b(?:pas|plus|jamais|rien)\b/u.test(laterClause);
      if (laterQuestion || awaitsFutureExecutionAuthority(laterClause) || laterRevocation) {
        return 'non_authoritative';
      }
    }
  }
  return sawAffirmativeDecision ? 'affirmative' : undefined;
}

function independentNonAccessMutationRequested(text: string): boolean {
  const clauses = text.match(/[^.!?;\n]+[.!?;]?/gu) ?? [];
  return clauses.some(rawClause => {
    if (ACCESS_GRANT_DECISION_PATTERN.test(foldForIntent(rawClause))) return false;
    const canonicalClause = canonicalizeObjectiveArtifactMutations(rawClause.trim());
    return canonicalClause.length > 0 && classifyObjectiveMutationRisk(canonicalClause, {
      authorityText: canonicalClause,
    }).mutationRequested;
  });
}

function classifyObjectiveRequest(text: string, riskContext?: string) {
  // Questions about whether an existing change still applies are observations,
  // even though generic routing vocabulary also contains "apply"/"correct".
  // Consume the whole question so appended instructions retain normal parsing.
  const canonicalAuthority = ACTION_STATE_QUESTION_PATTERN.test(text.trim())
    ? 'Inspect whether the referenced change is still applicable.'
    : canonicalizeObjectiveArtifactMutations(text);
  const contextualText = riskContext?.trim()
    ? `${canonicalAuthority}\n${riskContext}`
    : canonicalAuthority;
  const classification = classifyObjectiveMutationRisk(contextualText, { authorityText: canonicalAuthority });
  // Access-authority punctuation and confirmation wording must be interpreted
  // from the authenticated human text. Artifact canonicalization deliberately
  // maps English `correct` to `create`, which would otherwise turn the
  // conversational tail "correct." into a mutation command.
  const accessGrantDecision = accessGrantDecisionDisposition(text);
  if (accessGrantDecision !== undefined) {
    return {
      ...classification,
      mutationRequested: accessGrantDecision === 'affirmative'
        || independentNonAccessMutationRequested(text),
    };
  }
  return isAnalyticalDecisionDiscussion(canonicalAuthority)
    ? { ...classification, mutationRequested: false }
    : classification;
}

/** Resolve only the evidence subject of an authoritative mutation. Domain
 * words alone (for example in a negated/read-only amendment) cannot replace a
 * persisted gate, while the host classifier's full mutation vocabulary covers
 * fix/rotate/configure and other verbs beyond the legacy evidence parser. */
export function classifyAuthorizedObjectiveEvidenceDomain(text: string) {
  return classifyObjectiveRequest(text).mutationRequested
    ? detectHighStakesEvidenceDomain(text)
    : undefined;
}

function boundedObjectiveRiskText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars / 2);
  return `${text.slice(0, headChars)}\n${text.slice(-(maxChars - headChars))}`;
}

function objectiveRiskContext(objective: ActiveSessionObjective): string {
  const root = boundedObjectiveRiskText(objectiveAmendmentAuthorityText(objective.originalText ?? ''), 8_192);
  const amendments = objectiveAuthorityAmendments(objective);
  const latestSensitiveId = [...amendments].reverse().find(amendment => (
    classifyObjectiveRequest(objectiveAmendmentAuthorityText(amendment.text)).sensitiveDomain
  ))?.messageId;
  const retainedAmendments = amendments.filter((amendment, index) => (
    index >= amendments.length - 4 || amendment.messageId === latestSensitiveId
  )).map(amendment => boundedObjectiveRiskText(objectiveAmendmentAuthorityText(amendment.text), 2_048));
  return [root, ...retainedAmendments].filter(Boolean).join('\n');
}

function isObjectiveMutationRequested(text: string): boolean {
  return classifyObjectiveRequest(text).mutationRequested;
}

function isChatResponseOnlyEdit(text: string): boolean {
  const normalized = foldForIntent(text).replace(/\s*[.!?]+$/, '');
  if (/^(?:(?:please|merci de|tu peux|vous pouvez)\s+)?(?:correct|fix|modify|edit|corrige|modifie|edite|redige|ecris)\s+(?:(?:only|just|uniquement|seulement|simplement)\s+)?(?:(?:(?:the|le|la)\s+)?(?:wording|style|spelling|orthographe|formulation|fautes?\s+(?:de|dorthographe))\s+(?:of|de)\s+)?(?:(?:the|your|my|our|ton|ta|votre|ma|notre|la)\s+)?(?:answer|response|reponse)(?:\s+(?:here|in (?:this|the) chat|ici|dans (?:ce|le) chat))?$/.test(normalized)) return true;

  // An inline rewrite is a response deliverable, not an external artifact
  // mutation. Keep the exception closed to a literal colon-delimited payload:
  // files, documents, URLs, paths and appended operational instructions retain
  // normal mutation authority and verification requirements.
  const accentFolded = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, "'");
  const inline = /^\s*(?:(?:please|merci de)\s+)?(?:ameliore(?:z)?|improve)\s+(?:(?:le|ce|the|this)\s+)?(?:texte|text)\s*:\s*(\S[\s\S]*?)\s*$/iu.exec(accentFolded);
  if (!inline) return false;
  const payload = inline[1]!.trim();
  if (/^(?:(?:dans|sur|de|du|in|on|of)\s+)?(?:(?:le|la|un|une|the|a)\s+)?(?:fichier|file|document|doc|site|page|url|chemin|path|source|repo|repository|externe|external)\b/iu.test(payload)) return false;
  if (/(?:https?:\/\/|file:\/\/|www\.)/iu.test(payload)
    || /(?:^|[\s("'`])(?:~\/|\.{1,2}\/|\/(?!\/)|[a-z]:[\\/])/iu.test(payload)
    || /\b[\w-]+\.(?:txt|md|docx?|rtf|html?|json|ya?ml|tsx?|jsx?|py|css)\b/iu.test(payload)) return false;
  return !classifyObjectiveRequest(payload).mutationRequested
    && !OBSERVATION_REQUEST_PATTERN.test(payload);
}

/** A presentation preference changes the reply, not the target being verified. */
function isResponsePresentationOnlyAmendment(text: string): boolean {
  if (classifyObjectiveRequest(text).mutationRequested || OBSERVATION_REQUEST_PATTERN.test(text)) return false;
  const normalized = foldForIntent(text);
  // Consume the whole instruction. A former permissive `.*presentation.*`
  // shape let “Réponds brièvement et renvoie le mail” retain the terminal
  // lock despite containing a new action.
  const responseWithPresentation = /^(?:(?:please|merci de|tu peux|vous pouvez)\s+)?(?:reponds?|repondez|answer|respond|reply)\s+(?:(?:plus|more)\s+)?(?:bref|brievement|concis|court|simple|clairement|detaille|francais|anglais|english|french|markdown|json|en\s+(?:liste|puces?|tableau)|in\s+(?:a\s+)?(?:list|bullets?|table)|en\s+(?:une\s+)?phrase|in\s+(?:one\s+)?sentence)(?:\s+(?:dans|pour|in|for)\s+(?:(?:le|la|the|your|ton|ta|votre)\s+)?(?:message\s+final|final\s+(?:answer|response|message)|reponse))?$/.test(normalized);
  const targetedPresentation = /^(?:(?:please|merci de)\s+)?(?:keep|make|rends?|rendez|garde|gardez)\s+(?:(?:the|your|ton|ta|votre|le|la)\s+)?(?:final\s+)?(?:answer|response|message|reponse|message final)\s+(?:more\s+|plus\s+)?(?:brief|short|simple|clear|concise|direct|bref|court|simple|clair|concis|direct)$/.test(normalized);
  const standaloneTone = /^(?:(?:please|merci de)\s+)?(?:utilise|utilisez|adopte|adoptez|garde|gardez|use|adopt|keep)\s+(?:(?:un|une|a)\s+)?(?:ton|tone|style)\s+(?:plus\s+|more\s+)?(?:bref|court|simple|clair|concis|direct|brief|short|simple|clear|concise|direct)$/.test(normalized);
  const continuationLanguage = /^(?:continue|continuer|poursuis|poursuivez|respond|reply|answer)\s+(?:uniquement\s+|only\s+)?(?:en|in)\s+(?:francais|anglais|english|french)$/.test(normalized);
  return responseWithPresentation || targetedPresentation || standaloneTone
    || continuationLanguage || isChatResponseOnlyEdit(text);
}

/** Cost routing accepts a broad continuation prefix; contract amendments must
 * consume the whole request before treating it as a content-free resume. */
function isBareObjectiveContinuation(text: string): boolean {
  if (!isContextDependentDirectTurn(text)) return false;
  const folded = foldForIntent(text).replace(/-/g, ' ').replace(/\s+/g, ' ');
  return /^(?:(?:ok|oui|yes|daccord)\s+)?(?:(?:go|vas y|allez y|continue|poursui(?:s|t|vre)|reprend(?:s|re)?|avance)(?:\s+(?:le travail|la suite|le reste|la mission|cet objectif|ce chantier))?|(?:fais|faites) le)(?:\s+(?:stp|svp|sil te plait|sil vous plait))?$/.test(folded);
}

function amendmentEvidenceRequests(text: string, delegatedRole?: 'worker' | 'reviewer') {
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const readOnly = delegatedRole === 'reviewer' || isExplicitReadOnlyReview(text);
  const questionOnly = isExplicitQuestionAnswerOnlyRequest(text);
  // French restrictive "ne ... que" and a named exception are affirmative
  // work with a narrower target. A conditional "sauf si" remains excluded.
  const affirmative = normalized
    .replace(/\bne\s+(modifie|corrige|cree|verifie|inspecte)\s+que\b/gi, '$1')
    .replace(/\bne\s+(cree|modifie|corrige)\s+(?:aucun(?:e)?\s+(?:fichier|document|rapport)|rien)\s+sauf\s+(?=(?:le|la|les|un|une|des)\s)/gi, '$1 ');
  const execution = isObjectiveMutationRequested(affirmative) && !isChatResponseOnlyEdit(affirmative);
  return {
    execution: !readOnly && !questionOnly && execution,
    observation: !questionOnly && (readOnly || AMENDMENT_OBSERVATION_REQUEST.test(affirmative)),
  };
}

function independentInstructionClauses(text: string): string[] {
  return text.split(/[.!?;\n]+/u).map(clause => clause.trim()).filter(Boolean);
}

/** A structured quotation/topic header owns the following line. Its payload
 * is data to discuss, not a fresh instruction that can grant or revoke the
 * active objective merely because sentence splitting detached it. */
function hasNonAuthoritativeStructuredLead(text: string): boolean {
  const normalized = text.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').toLowerCase();
  return /^\s*(?:(?:exemple(?:\s+d(?:instruction|option|invite|ordre))?|example(?:\s+of\s+(?:an?\s+)?(?:instruction|option|prompt|order))?|citation|quote|sujet|subject|question|hypothese|option|proposition|scenario|consigne\s+citee|texte\s+a\s+analyser|plan\s+(?:propose|proposed))|(?:(?:le|la)\s+)?(?:rapport|report|document|documentation|texte|text|message)\b.{0,100}\b(?:dit|says?|indique|mentions?|recommande|recommends?)|analyse\b.{0,100}\b(?:instruction|option|texte|text|si|whether))\s*:\s*(?:\r?\n)+/u.test(normalized);
}

function withoutClauseConnector(text: string): string {
  return text.replace(/^\s*(?:finalement|mais|puis|ensuite|et|but|finally|then|and)\s+/iu, '').trim();
}

function matchesExecutionAuthorityRevocation(candidate: string): boolean {
  const reactivationRevoked = /^(?:(?:arrete|cesse)\s+de\s+reactiver|(?:stoppe|annule)\s+(?:la\s+)?reactivation|n(?:essaie|essaye)\s+pas\s+de\s+reactiver|il\s+ne\s+faut\s+plus\s+reactiver|(?:laisse\s+tomber\s+|finalement\s+)?ne\s+(?:(?:le|la)\s+)?reactive\s+(?:pas|plus)|pas\s+de\s+reactivation|reactivation\s+annulee)\b/.test(candidate);
  const repairRevoked = /^(?:ne\s+(?:solutionne|resous|regle|repare|corrige|relance)\b[^.!?;]{0,80}\b(?:pas|plus|rien)|(?:arrete|cesse)\s+de\s+(?:solutionner|resoudre|reparer|corriger|relancer)\b)/.test(candidate);
  const sendRevoked = /^(?:(?:arrete|cesse)\s+d?envoyer|(?:stoppe|annule)\s+(?:l?envoi|lenvoi)|(?:laisse\s+tomber\s+|finalement\s+)?(?:ne\s+envoie|nenvoie)\s+(?:pas|plus|rien)|pas\s+d?envoi|envoi\s+annule)\b/.test(candidate);
  const mutationProhibition = /^(?:(?:n(?:e|effectue)|neffectue|ne\s+(?:fais|realise|execute))\s+(?:surtout\s+)?(?:aucune|plus\s+aucune)\s+(?:mutation|modification|ecriture|execution|operation|action)(?:s|\s+distante?s?)?|(?:aucune|plus\s+aucune|pas\s+de)\s+(?:mutation|modification|ecriture|execution|operation|action)(?:s|\s+distante?s?)?|ne\s+(?:(?:modifie|change|ecris|pousse|installe|configure)(?:\s+et\s+ne\s+)?)+.{0,80}\b(?:pas|plus|rien)|(?:do\s+not|dont)\s+(?:(?:modify|change|write|push|install|configure)(?:\s+(?:or|and)\s+)?)+(?:\s+anything)?|(?:no|without)\s+(?:remote\s+)?(?:mutations?|modifications?|writes?|changes?))\b/.test(candidate);
  // A safety precondition constrains *how* the already-requested mutation is
  // executed; it does not revoke that mutation. Without this distinction,
  // ordinary instructions such as "aucune modification sans verifier les
  // tests" erase inherited execution authority and strand the objective.
  const conditionalTechnicalGuard = /\b(?:sans|avant(?:\s+de)?|jusqua|until|before|unless|without)\b[^.!?;\n]{0,100}\b(?:verifi|test|control|check|review|sauvegard|backup|snapshot)\w*/.test(candidate);
  const namesHumanAuthority = /\b(?:approval|approbation|authorization|autorisation|consent|sign[ -]?off|green\s+light|accord|feu\s+vert)\b/.test(candidate)
    || /\b(?:my|our|ma|mon|notre)\s+(?:review|approval|validation|authorization|autorisation|accord|controle|sign[ -]?off)\b/.test(candidate)
    || /\b(?:human|user|humain|humaine|utilisateur|utilisatrice|explicit|explicite)\s+(?:review|check|control|controle|validation|approval|approbation|authorization|autorisation)\b/.test(candidate)
    || /\b(?:review|check|control|controle|validation)\s+(?:human|user|humain|humaine|utilisateur|utilisatrice|explicit|explicite|de\s+ma\s+part)\b/.test(candidate);
  const conditionalMutationSafetyGuard = conditionalTechnicalGuard && !namesHumanAuthority;
  const scopedMutationRevoked = mutationProhibition && !conditionalMutationSafetyGuard;
  const localMutationRevoked = !conditionalMutationSafetyGuard && (
    /^(?:ne\s+(?:modifie|change|edite|ecris|corrige|execute)\s+(?:plus\s+)?(?:rien|aucun(?:e)?\s+(?:fichier|chose|modification))|(?:aucune|plus aucune)\s+(?:autre\s+)?(?:modification|correction|ecriture|execution))\b/.test(candidate)
    || /^(?:(?:do not|dont)\s+(?:modify|change|edit|write|fix|execute)\s+(?:anything|anything else|any more)|no\s+more\s+(?:changes|edits|writes|modifications))\b/.test(candidate)
  );
  return /^(?:(?:arrete|stoppe|stop|cesse)(?: maintenant)?(?:$|\s+(?:tout|ca|cela|le travail|les modifications?|de (?:modifier|changer|editer|ecrire|corriger|executer)|ne (?:modifie|change|edite|ecris|corrige|execute)))|(?:stop|cancel|cease)(?: now)?(?:$|\s+(?:everything|this|that|the work|all changes|changing|editing|writing|fixing|executing|do not (?:modify|change|edit|write|fix|execute)|dont (?:modify|change|edit|write|fix|execute))))/.test(candidate)
    || /^(?:laisse\s+tomber|annule)(?:\s+maintenant)?$/.test(candidate)
    || /^(?:(?:finalement\s+)?non|non\s+ne\s+le\s+fais\s+pas|oublie|attends|pas\s+maintenant|nen\s+fais\s+rien)$/.test(candidate)
    || /^(?:il\s+ne\s+faut\s+(?:pas|plus|jamais)\s+(?:(?:le|la|les)\s+)?(?:faire|executer|ouvrir)|(?:ne\s+(?:(?:lui|leur)\s+)?ouvre|nouvre)\b[^.!?;]{0,60}\b(?:pas|plus|jamais|rien)|attends?\b[^.!?;]{0,40}\b(?:ma|mon|notre|la|une)\s+(?:confirmation|validation|autorisation|reponse))\b/.test(candidate)
    || localMutationRevoked
    || /^(?:ne\s+(?:reactiv(?:e|er|ez|ons)\s+(?:surtout\s+)?pas|(?:surtout\s+)?pas\s+reactiv(?:er|e|ez|ons))|(?:do not|dont)\s+reactivate)\b/.test(candidate)
    || /^(?:(?:passe|reste|travaille)\s+(?:maintenant|desormais)?\s*(?:en\s+)?lecture seule|(?:switch to|stay|work)\s+(?:in\s+)?read only(?:\s+mode)?(?:\s+now)?)\b/.test(candidate)
    || reactivationRevoked || sendRevoked || repairRevoked || scopedMutationRevoked;
}

/** A comma is an instruction boundary only for the two authority transitions
 * we can prove locally: an explicit revocation followed by a direct request,
 * or any prior clause followed by an explicit revocation. Treating every comma
 * as a boundary turns examples, reported speech and analysis into authority. */
function boundedInstructionClauses(
  text: string,
  delegatedRole?: 'worker' | 'reviewer',
): string[] {
  const clauses = independentInstructionClauses(text);
  const lastClause = clauses.at(-1);
  if (!lastClause?.includes(',')) return clauses;
  const comma = lastClause.lastIndexOf(',');
  const prefix = lastClause.slice(0, comma).trim();
  const rawTail = lastClause.slice(comma + 1).trim();
  const tail = withoutClauseConnector(rawTail);
  if (!prefix || !tail) return clauses;
  const normalizedPrefix = foldForIntent(prefix).replace(/-/g, ' ').replace(/\s+/g, ' ');
  const normalizedTail = foldForIntent(tail).replace(/-/g, ' ').replace(/\s+/g, ' ');
  const explicitTailTransition = /^(?:finalement|mais|puis|ensuite|but|finally|then)\b/iu.test(rawTail);
  const nonAuthoritativePrefix = /^(?:(?:le\s+)?(?:rapport|report|document|texte|text|message)\s+(?:dit|says?|indique|mentions?|cite)|exemple|example|citation|quote|sujet|subject|la\s+phrase\s+est)\b/.test(normalizedPrefix)
    || isAnalyticalDecisionDiscussion(prefix);
  // A short, closed conversational lead-in can introduce a direct stop after
  // a comma. Do not generalize this to arbitrary prose: that would let a
  // report, example or analysis revoke (or grant) persisted authority.
  const directRevocationLead = /^(?:finalement|non|ok|daccord|bon|s(?:il|il)\s+te\s+plait|sil\s+vous\s+plait|maintenant|en\s+fait|oui|attends)$/.test(normalizedPrefix);
  const tailRevokes = (explicitTailTransition || directRevocationLead) && !nonAuthoritativePrefix
    && matchesExecutionAuthorityRevocation(normalizedTail);
  const revokedThenDirectRequest = matchesExecutionAuthorityRevocation(normalizedPrefix)
    && amendmentEvidenceRequests(tail, delegatedRole).execution;
  if (!tailRevokes && !revokedThenDirectRequest) return clauses;
  return [...clauses.slice(0, -1), prefix, tail];
}

function latestClauseRequestsExecution(
  text: string,
  delegatedRole?: 'worker' | 'reviewer',
): boolean {
  if (hasNonAuthoritativeStructuredLead(text)) return false;
  if (accessGrantDecisionDisposition(text) === 'non_authoritative'
    && !independentNonAccessMutationRequested(text)) return false;
  const clauses = boundedInstructionClauses(text, delegatedRole);
  if (clauses.length < 2) return false;
  const prior = foldForIntent(withoutClauseConnector(clauses.at(-2)!))
    .replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  return matchesExecutionAuthorityRevocation(prior)
    && amendmentEvidenceRequests(withoutClauseConnector(clauses.at(-1)!), delegatedRole).execution;
}

/** A direct human amendment can revoke inherited mutation authority without
 * discarding the objective, so a later explicit correction can resume it.
 * Keep this deliberately narrow: reported speech and ordinary status updates
 * do not change authority, while a mixed instruction with a new positive
 * mutation is resolved by that positive instruction in the caller. */
function explicitlyRevokesExecutionAuthority(text: string): boolean {
  if (hasNonAuthoritativeStructuredLead(text)) return false;
  // The terminal "no external action / no file / no other task" clause of a
  // fully bounded question/answer exchange scopes that conversational check;
  // it is not a global revocation of an already active objective. Keep this
  // structural: an ordinary standalone prohibition must still revoke, while
  // extra work inserted into the exchange remains visible to the normal
  // mutation classifier instead of being erased by the contradictory limit.
  if (hasBoundedQuestionAnswerEnvelope(text)) return false;
  const normalized = foldForIntent(text).replace(/-/g, ' ').replace(/\s+/g, ' ');
  const independentClauses = boundedInstructionClauses(text);
  if (accessGrantDecisionDisposition(text) === 'non_authoritative'
    && !independentNonAccessMutationRequested(text)) {
    const revokedBeforeAccess = independentClauses.some(rawClause => {
      const clause = foldForIntent(withoutClauseConnector(rawClause))
        .replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
      return matchesExecutionAuthorityRevocation(clause)
        || /^(?:(?:analyse|analysez|analyze|review)\b[^.!?;]{0,100}\b(?:seulement|uniquement|only)|(?:analyse|analysez|analyze|review)\b[^.!?;]{0,100}\b(?:sans\s+agir|without\s+acting))\b/u.test(clause)
        || /^(?:ne\s+(?:fais|faites|faire|effectue|effectuez|execut(?:e|ez|er))\b[^.!?;]{0,50}\b(?:aucune|rien)|(?:do\s+not|dont)\s+(?:change|modify|write|execute)\s+anything)\b/u.test(clause)
        || /^(?:nouvre|ne\s+ouvre)\b[^.!?;]{0,60}\b(?:rien|pas|plus|jamais)\b/u.test(clause);
    });
    if (revokedBeforeAccess) return true;
  }
  const lastIndependentClause = independentClauses.at(-1);
  if (independentClauses.length > 1 && lastIndependentClause
    && amendmentEvidenceRequests(withoutClauseConnector(lastIndependentClause)).execution
    && !matchesExecutionAuthorityRevocation(
      foldForIntent(withoutClauseConnector(lastIndependentClause)).replace(/-/g, ' ').replace(/\s+/g, ' '),
    )) return false;
  const normalizedLastClause = lastIndependentClause
    ? foldForIntent(withoutClauseConnector(lastIndependentClause)).replace(/-/g, ' ').replace(/\s+/g, ' ').trim()
    : undefined;
  const revoked = matchesExecutionAuthorityRevocation(normalized)
    || !!normalizedLastClause && matchesExecutionAuthorityRevocation(normalizedLastClause);
  if (!revoked) return false;
  const positiveTail = /\b(?:mais|puis|ensuite|but|then)\s+(.+)$/.exec(normalized)?.[1];
  return !positiveTail || !isObjectiveMutationRequested(positiveTail);
}

function editDistanceWithin(left: string, right: string, limit: number): boolean {
  if (Math.abs(left.length - right.length) > limit) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const value = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return false;
    previous = current;
  }
  return (previous[right.length] ?? limit + 1) <= limit;
}

function looksLikeContinuation(text: string): boolean {
  if (isContextDependentDirectTurn(text)) return true;
  if (isExecutionChannelCorrection(text)) return true;
  if (isTerseContextualRepairAmendment(text)) return true;
  if (isPrecisionOrCompletenessChallenge(text)) return true;
  const folded = foldForIntent(text);
  const withoutFiller = folded.match(CONTINUATION_FILLER_PATTERN)?.[1] ?? folded;
  const [firstWord = ''] = withoutFiller.split(/\s+/);
  const typoTolerance = firstWord.length >= 5 ? 2 : 1;
  return CONTINUATION_REFERENCE_PATTERN.test(withoutFiller)
    || CONTINUATION_REOPEN_PATTERN.test(withoutFiller)
    || /^(?:(?:a toi de|merci de|veuillez)\s+)?(?:fai(?:s|tes)\s+(?:la|les|ces)\s+corrections?|corrig(?:e|ez)\s+(?:le|la|les|ca|cela)|plan\s+approuve\s*,?\s*(?:veuillez\s+)?execute(?:r|z)?)\b/.test(withoutFiller)
    || CONTINUATION_VERBS.some(verb => editDistanceWithin(firstWord, verb, typoTolerance));
}

/** A bare repair verb has no self-contained target. It can safely amend an
 * active or explicitly incomplete objective, but it cannot establish that a
 * verified objective was actually incomplete. Reusing a completed root here
 * would silently recover all of its old target and mutation authority from a
 * phrase such as "Résout". */
function isTerseContextualRepairAmendment(text: string): boolean {
  if (hasNonAuthoritativeStructuredLead(text) || text.length > 120) return false;
  const normalized = foldForIntent(text).replace(/-/g, ' ').replace(/\s+/g, ' ');
  const bareRepair = /^(?:(?:ok|oui|yes|daccord)\s+)?(?:resou(?:s|t|dre)|regle|fix)(?:\s+(?:ca|cela|ceci|it|this))?$/;
  if (bareRepair.test(normalized)) return true;

  // Recover the exact production-shaped contextual repair: a deictic repair
  // followed only by a short failure diagnosis and the already-assigned
  // private-IP location. This deliberately cannot consume another imperative
  // ("puis déploie", "et supprime") or introduce an autonomous target.
  const privateIpDiagnosticRepair = /^(?:(?:ok|oui|yes|daccord)\s+)?repare\s+(?:ca|cela|ceci)\s+(?:(?:devrait\s+(?:marche(?:r)?|fonctionne(?:r)?)|(?:ne\s+)?(?:marche|fonctionne)\s+pas|(?:echoue|bloque)))(?:\s+(?:(?:car|puisque|parce\s+que)\s+)?(?:on\s+est|nous\s+sommes)\s+bien\s+(?:sur|via)\s+(?:l\s*)?(?:adresse\s+)?ip\s+privee\s+(?:attribuee|assignee|attritree))?$/;
  return privateIpDiagnosticRepair.test(normalized);
}

/**
 * Older builds could accidentally replace a real objective root with one of
 * these context-only corrections. They are valid amendments, but never a
 * self-contained source of target or mutation authority.
 */
export function isLegacyContextualObjectiveRoot(text: string): boolean {
  return isExecutionChannelCorrection(text)
    || isTerseContextualRepairAmendment(text)
    || isLegacyPlanImplementationRequest(text);
}

function retainedObjectiveEvidenceDomain(objective: ActiveSessionObjective) {
  if (objective.evidenceDomain) return objective.evidenceDomain;
  // Legacy objectives did not persist their evidence subject. Prefer an
  // authoritative mutation segment, then recover a read-only subject that a
  // later deictic correction ("fix the findings") can legitimately retain.
  for (const text of [
    ...objectiveAuthorityAmendments(objective).map(amendment => objectiveAmendmentAuthorityText(amendment.text)).reverse(),
    objectiveAmendmentAuthorityText(objective.originalText ?? ''),
  ]) {
    const domain = classifyAuthorizedObjectiveEvidenceDomain(text);
    if (domain) return domain;
  }
  for (const text of [
    ...objectiveAuthorityAmendments(objective).map(amendment => objectiveAmendmentAuthorityText(amendment.text)).reverse(),
    objectiveAmendmentAuthorityText(objective.originalText ?? ''),
  ]) {
    const domain = detectHighStakesEvidenceDomain(text);
    if (domain) return domain;
  }
  return undefined;
}

function objectiveAmendmentAuthorityText(text: string): string {
  // Amendments from an active SDK turn may include the host contract appended
  // after the user's text. Its defensive examples mention security, legal and
  // medical policy but are not part of the accepted human objective.
  const hostContractIndex = text.search(/\n\s*<host_objective_contract\b/iu);
  const withoutHostContract = hostContractIndex >= 0 ? text.slice(0, hostContractIndex) : text;
  // A closed email body is quoted payload data. Questions, credential names or
  // action verbs inside it must not change objective risk, mutation authority or
  // evidence gates. Only the same fully authenticated structured Gmail envelope
  // accepted by the execution gate may receive that treatment; bare or malformed
  // BODY markers remain visible to policy classification (fail closed).
  if (!parseStructuredGmailSendResumeSegment(withoutHostContract)) return withoutHostContract;
  const beginCount = withoutHostContract.match(/(?:^|\r?\n)BODY_BEGIN(?=\r?\n|$)/gu)?.length ?? 0;
  const endCount = withoutHostContract.match(/(?:^|\r?\n)BODY_END(?=\r?\n|$)/gu)?.length ?? 0;
  if (beginCount !== 1 || endCount !== 1) return withoutHostContract;
  const block = /(^|\r?\n)BODY_BEGIN\r?\n[\s\S]*?\r?\nBODY_END(?=\r?\n|$)/u;
  if (!block.test(withoutHostContract)) return withoutHostContract;
  return withoutHostContract.replace(
    block,
    '$1BODY_BEGIN\n[exact payload body omitted from objective policy classification]\nBODY_END',
  );
}

/**
 * A terminal reconciliation is durable prompt context, not fresh authority.
 * Keep its constraints visible to the agent while excluding its quoted
 * receipts, payload and tool names from every authority/evidence projection.
 * Re-evaluate the text as well as the marker so the exclusion survives a
 * later ordinary continuation that no longer owns the current marker.
 */
function objectiveAuthorityAmendments(objective: ActiveSessionObjective) {
  return (objective.amendments ?? []).filter(amendment => (
    amendment.messageId !== objective.terminalReconciliation?.messageId
      && !isExplicitReadOnlyClosureRequest(amendment.text)
  ));
}

/** Allow a stale medical tier to fall only after either a narrow explicit
 * correction or a fully restated concrete software mission, and only when
 * every human-authored objective segment remains non-clinical under the
 * current classifiers. The operational restatement path repairs historical
 * classifier state; it grants no tool or target authority of its own. */
function canCorrectLegacyMedicalFalsePositive(
  objective: ActiveSessionObjective,
  currentText: string,
  currentTextIsAmendment: boolean,
): boolean {
  if (objective.evidenceDomain !== 'medical') return false;
  const historicalSegments = [
    objectiveAmendmentAuthorityText(objective.originalText ?? ''),
    ...objectiveAuthorityAmendments(objective).map(amendment => objectiveAmendmentAuthorityText(amendment.text)),
  ].filter(text => text.trim().length > 0);
  const clarificationSeen = currentTextIsAmendment
    && isExplicitNonMedicalOperationalTreatmentClarification(currentText)
    || historicalSegments.some(isExplicitNonMedicalOperationalTreatmentClarification);
  const operationalRestatementSeen = currentTextIsAmendment
    && isConcreteOperationalSoftwareRestatement(objectiveAmendmentAuthorityText(currentText))
    || [...historicalSegments].reverse().some(isConcreteOperationalSoftwareRestatement);
  if (!clarificationSeen && !operationalRestatementSeen) return false;

  return historicalSegments.every(text => {
    const remainingText = stripExplicitNonMedicalOperationalTreatmentClarification(text) ?? text;
    return (classifyObjectiveRequest(remainingText).highRisk === false
      // A genuinely clinical root can be observational and therefore standard;
      // it must still never be reinterpreted by a later contradictory claim.
      && detectHighStakesEvidenceDomain(remainingText) !== 'medical')
      // A detailed software recovery list may use bare “santé” as one of its
      // operational checks. The shared predicate neutralizes only that
      // ambiguous noun and still rejects every independent clinical signal.
      || isConcreteOperationalSoftwareRestatement(remainingText);
  });
}

/** Migrate a persisted legal source gate only when the newest substantive
 * human instruction fully restates an operational contract/signature incident
 * over a concrete technical substrate. A terse continuation cannot invent
 * this correction, and any real legal/drafting signal keeps the old gate. */
function canCorrectLegacyTechnicalLegalFalsePositive(
  objective: ActiveSessionObjective,
  currentText: string,
  currentTextIsAmendment: boolean,
): boolean {
  if (objective.evidenceDomain !== 'legal') return false;
  const historicalSegments = [
    objectiveAmendmentAuthorityText(objective.originalText ?? ''),
    ...objectiveAuthorityAmendments(objective).map(amendment => objectiveAmendmentAuthorityText(amendment.text)),
  ].filter(text => text.trim().length > 0);
  if (!historicalSegments.every(text => (
    classifyObjectiveRequest(text).highRisk === false
      && detectHighStakesEvidenceDomain(text) !== 'legal'
    || (isOperationalTechnicalContractLifecycleObjective(text)
        || isConcreteOperationalSoftwareRestatement(text))
      && classifyAuthorizedObjectiveEvidenceDomain(text) === undefined
      && detectHighStakesEvidenceDomain(text) === undefined
  ))) return false;
  const candidates = currentTextIsAmendment
    ? [objectiveAmendmentAuthorityText(currentText)]
    : objectiveAuthorityAmendments(objective)
      .map(amendment => objectiveAmendmentAuthorityText(amendment.text))
      .reverse();
  const correction = candidates.find(isOperationalTechnicalContractLifecycleObjective);
  if (!correction) return false;
  return classifyObjectiveRequest(correction).highRisk === false
    && detectHighStakesEvidenceDomain(correction) === undefined;
}

function reclassifiedHighStakesClarification(
  objective: ActiveSessionObjective,
  currentText: string,
  currentTextIsAmendment: boolean,
): { evidenceDomain?: ReturnType<typeof detectHighStakesEvidenceDomain> } | undefined {
  const historicalClarifications = objectiveAuthorityAmendments(objective)
    .map(amendment => objectiveAmendmentAuthorityText(amendment.text))
    .reverse();
  const currentClarification = currentTextIsAmendment
    && stripExplicitNonMedicalOperationalTreatmentClarification(currentText) !== undefined;
  // A fresh substantive instruction owns its domain. Historical clarification
  // reclassification is only needed while resuming persisted state, or when
  // the current amendment is itself another bounded clarification.
  const candidates = currentTextIsAmendment
    ? (currentClarification ? [currentText, ...historicalClarifications] : [])
    : historicalClarifications;
  for (const text of candidates) {
    const remainingText = stripExplicitNonMedicalOperationalTreatmentClarification(text);
    if (remainingText === undefined) continue;
    const classification = classifyObjectiveRequest(remainingText);
    if (!classification.highRisk) continue;
    return {
      evidenceDomain: classifyAuthorizedObjectiveEvidenceDomain(remainingText)
        ?? detectHighStakesEvidenceDomain(remainingText),
    };
  }
  return undefined;
}

/** Re-evaluate persisted execution authority after a bounded classifier fix.
 * This runs only on a non-substantive continuation, never in preference to a
 * fresh amendment, and cannot revive work whose execution authority was
 * explicitly revoked. */
function reclassifiedPersistedHighStakesObjective(
  objective: ActiveSessionObjective,
): { evidenceDomain?: ReturnType<typeof detectHighStakesEvidenceDomain> } | undefined {
  if (!objectiveRequiresExecutionEvidence(objective)) return undefined;
  for (const text of [
    ...objectiveAuthorityAmendments(objective)
      .map(amendment => objectiveAmendmentAuthorityText(amendment.text))
      .reverse(),
    objectiveAmendmentAuthorityText(objective.originalText ?? ''),
  ]) {
    const classification = classifyObjectiveRequest(text);
    if (!classification.highRisk) continue;
    return {
      evidenceDomain: classifyAuthorizedObjectiveEvidenceDomain(text)
        ?? detectHighStakesEvidenceDomain(text),
    };
  }
  return undefined;
}

/** A later deictic correction may target a genuinely requested read-only
 * audit, but never a domain merely quoted or mentioned by an intervening
 * report. This keeps "analyse les permissions … en lecture seule" useful
 * without letting "le rapport mentionne les permissions" retarget authority. */
function latestExplicitAuditEvidenceDomain(objective: ActiveSessionObjective) {
  const segments = [
    ...objectiveAuthorityAmendments(objective).map(amendment => objectiveAmendmentAuthorityText(amendment.text)).reverse(),
    objectiveAmendmentAuthorityText(objective.originalText ?? ''),
  ];
  for (const text of segments) {
    // Bind the audited subject to the same bounded clause as the observation
    // verb. A later conditional blocker clause mentioning a secret is not the
    // subject of an earlier generic “verify the result” instruction.
    for (const clause of independentInstructionClauses(text)) {
      const folded = foldForIntent(clause);
      const explicitAudit = /\b(?:analys(?:e|er|ez)|analy[sz]e|audit(?:e|er|ez)?|inspect(?:e|er|ez)?|review|revoi[st]|verifi(?:e|er|ez))\b/.test(folded);
      const explicitReadOnly = /\b(?:lecture seule|read only|sans (?:le |la |les )?(?:modifier|modification|corriger|correction)|without (?:any )?(?:change|changing|modification)|ne modifi(?:e|er|ez) (?:rien|pas))\b/.test(folded);
      const reportedMention = /\b(?:rapport|report|document|texte|message|compte rendu)\b[^.!?\n]{0,160}\b(?:mentionne|mentions?|indique|reports?|says?|cite)\b/.test(folded);
      const mutationRequested = classifyObjectiveRequest(clause).mutationRequested;
      if (!explicitAudit || reportedMention || mutationRequested && !explicitReadOnly) continue;
      const domain = detectHighStakesEvidenceDomain(clause);
      if (domain) return domain;
    }
  }
  // A real earlier mutation can also own the referent of a terse correction.
  // Do not fall back to a bare detected domain: conditional blocker wording
  // such as “stop only if a secret is missing” is not an audited subject and
  // must not turn later generic fixes into credential mutations.
  for (const text of segments) {
    if (!classifyObjectiveRequest(text).highRisk) continue;
    const domain = classifyAuthorizedObjectiveEvidenceDomain(text);
    if (domain) return domain;
  }
  return undefined;
}

function startsExplicitNewObjective(text: string): boolean {
  const folded = foldForIntent(text).replace(/^(?:(?:bon|alors|donc|ok|okay|oui|yes|maintenant|now|please)\s+)+/, '');
  return EXPLICIT_NEW_OBJECTIVE_PATTERNS.some(pattern => pattern.test(folded));
}

function isObjectiveStatusOnly(text: string): boolean {
  const normalized = foldForIntent(text).replace(/-/g, ' ').replace(/\s+/g, ' ');
  return /^(?:ou en (?:es tu|sommes nous)|(?:quel(?:le)?s? (?:est|sont) )?(?:(?:le|la|les) )?(?:statut|avancement)|(?:(?:peux tu|pouvez vous|pourrais tu|pourriez vous) )?(?:(?:me|nous) )?(?:donner|donne|donnez|faire|fais|faites) (?:(?:moi|nous) )?(?:un|le) (?:point davancement|point de situation|statut)|(?:can|could|would) you (?:give|send) (?:me|us) (?:a )?(?:status|progress) update|(?:give|send) (?:me|us) (?:a )?(?:status|progress) update|what(?:s| is) the (?:status|progress)|where are we|how is it going|status|progress|merci|thanks)$/.test(normalized);
}

/** Recognize an explicit review scope, never a read-only target being deployed. */
export function isExplicitReadOnlyReview(text: string): boolean {
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  // Consume only this complete formatting sentence, never arbitrary preamble
  // or quoted instructions. Mutation checks still inspect the full request.
  const scope = normalized.replace(/^(?:reponds|repondez|retourne[z]?)\s+uniquement\s+(?:en\s+)?json(?:\s+compact)?(?:,\s*sans\s+markdown)?\.\s*/, '');
  if (/\b(?:lecture\s+seule|read[- ]only)\s+(?:si\s+possible|if\s+possible)\b/.test(scope)) return false;
  const reviewScope = /^(?:revue|audit)\s+(?:(?:independante?|hostile|finale?|terminale?|stricte?|strictement)[\s,]+)*(?:en\s+)?lecture\s+seule\b/.test(scope)
    || /^(?:effectu(?:e|er|ez))\s+(?:une?\s+)?(?:revue|audit)\s+(?:(?:independante?|hostile|finale?|terminale?|stricte?|strictement)[\s,]+)*(?:en\s+)?lecture\s+seule\b/.test(scope)
    || /^(?:independent\s+)?read[- ]only\s+review\b/.test(scope)
    || /^(?:(?:tu\s+dois|vous\s+devez)\s+)?(?:verifi(?:e|er|ez)|inspect(?:e|er|ez))\s+(?:independamment\s*,?\s*)?en\s+lecture\s+seule\b/.test(scope);
  const reviewerRole = /^(?:(?:tu\s+es\s+(?:(?:le|la|un|une)\s+)?|agis\s+comme\s+(?:(?:le|la|un|une)\s+)?)(?:(?:second|seconde|deuxieme)\s+)?(?:contre-)?(?:relecteur|relectrice|reviseur|reviseuse|reviewer)|you\s+are\s+(?:the|an?)\s+(?:(?:second|independent)\s+)*reviewer)\b/.exec(scope);
  const exclusiveReading = /(?:^|[.!?\n])\s*(?:travaille[z]?\s+(?:uniquement|exclusivement|strictement)\s+en\s+lecture|work\s+(?:only|strictly|exclusively)\s+in\s+read[- ]only(?:\s+mode)?)\b/.test(scope.slice(0, 500))
    || (!!reviewerRole && /^(?:\s+(?:independant|hostile|final|strictement))*\s+en\s+lecture\s+seule\b/.test(scope.slice(reviewerRole[0].length)));
  if (!reviewScope && !(reviewerRole && exclusiveReading)) return false;
  // Positive instructions override a preceding review label. Negated requests
  // ("ne modifie rien") and descriptions ("le plan exige un deploiement") do
  // not become execution requirements merely by naming a mutation.
  const mutationInstruction = /(?:^|[.!?;,\n]|\b(?:mais|puis|ensuite|et|but|then|and)\s+)\s*(?:(?:maintenant|aussi|now|also)\s+)?(?:(?:tu\s+(?:peux|dois)|vous\s+(?:pouvez|devez)|merci\s+de|please)\s+)?(?:modifi(?:e|er|ez)|corrig(?:e|er|ez)|optimis(?:e|er|ez|ons?)|appliqu(?:e|er|ez)|install(?:e|er|ez)|deploie(?:z)?|deployer|publi(?:e|er|ez)|supprim(?:e|er|ez)|demarr(?:e|er|ez)|redemarr(?:e|er|ez)|cre(?:e|er|ez)|ecri(?:s|re|vez)|copi(?:e|er|ez)|transmet(?:s|tre|tez)|transfer(?:e|er|ez)|effac(?:e|er|ez)|detru(?:is|ire|isez)|nettoi(?:e|yer|yez)|purg(?:e|er|ez)|configur(?:e|er|ez)|export(?:e|er|ez)|clon(?:e|er|ez)|dupliqu(?:e|er|ez)|provisionn?(?:e|er|ez)|change|modify|fix|correct|optimiz(?:e|es|ed|ing)|optimis(?:e|es|ed|ing)|apply|install|deploy|publish|delete|remove|start|restart|create|write|copy|forward|erase|destroy|wipe|purge|configure|clear|export|clone|duplicate|provision)(?=$|\s|[,;!?]|\.(?:\s|$))/;
  // A literal response-format instruction is not a file write. Its entire
  // clause must match; a path or an appended action retains the normal gate.
  const instructions = normalized.replace(/(?:^|[.!?\n])\s*ecri(?:s|vez)\s+uniquement\s+le\s+json\s+de\s+verdict\s+dans\s+(?:ta|votre)\s+reponse\s*,\s*aucun\s+fichier(?=[.!?\n]|$)/g, '.');
  const requiredCorrection = /(?:^|[.!?;,\n]|\b(?:mais|puis|ensuite|et|but|then|and)\s+)\s*(?:apport(?:e|er|ez)\s+(?:les|des)\s+(?:corrections?|modifications?)|(?:les|des)\s+(?:corrections?|modifications?)\s+doivent\s+etre\s+appliquees?)\b/;
  return !mutationInstruction.test(instructions)
    && !hasDirectObjectiveArtifactMutation(instructions)
    && !requiredCorrection.test(instructions);
}

const TERMINAL_RECONCILIATION_MARKER_DISCLAIMER = 'Le SHA du marqueur identifie uniquement le runtime Robb Agents installé. Il ne constitue ni une révision distante, ni un artefact métier, ni une autorisation supplémentaire.';
const TERMINAL_RECONCILIATION_INSTRUCTION = 'Reprends cette mission uniquement pour réconcilier son état terminal avec l’effet déjà accompli. Tu ne dois créer aucun nouvel effet externe. Réutilise les reçus persistés et garde toute observation en lecture seule. Termine réellement comme complete_verified.';

/**
 * A host-issued recovery marker may wrap only the literal, generic terminal
 * reconciliation instruction. Mission data stays in the existing transcript;
 * allowing receipt or payload slots here would let in-band user data extend
 * the read-only allowlist.
 */
function isStrictMarkedTerminalReconciliationEnvelope(text: string): boolean {
  const source = text.replace(/\r\n/g, '\n').trimEnd();
  if (source.includes('<host_objective_contract')) return false;
  const marker = /^\[robb-resume:[a-z0-9]+(?:-[a-z0-9]+)*:[a-f0-9]{6,64}:v\d+\]$/u;
  if ((source.match(/\[robb-resume:/gu)?.length ?? 0) !== 1) return false;
  const paragraphs = source.split(/\n\n/u);
  if (paragraphs.length !== 2) return false;
  const markerAndDisclaimer = paragraphs[0]!.split('\n');
  if (markerAndDisclaimer.length !== 2
    || !marker.test(markerAndDisclaimer[0]!)
    || markerAndDisclaimer[1] !== TERMINAL_RECONCILIATION_MARKER_DISCLAIMER) return false;
  return paragraphs[1] === TERMINAL_RECONCILIATION_INSTRUCTION;
}

/** A reply-format preference cannot conceal a fresh send or target change.
 * Keep this grammar independent from the broad artifact classifier: delivery
 * verbs and addresses with dots are both known blind spots there. */
function hasExplicitTerminalContractMutation(text: string): boolean {
  const normalized = foldForIntent(text).replace(/-/g, ' ').replace(/\s+/g, ' ');
  // Sentence splitting must not lose a retarget instruction merely because an
  // email address contains a dot. Inspect the folded whole text as well as
  // bounded imperative clauses.
  const directlyRetargetsTarget = /\b(?:utilise|utilisez|use)\b[^.!?;]{0,160}\b(?:comme\s+(?:le\s+|la\s+)?(?:destinataire|cible)|as\s+(?:the\s+)?(?:recipient|target))\b/.test(normalized)
    || /\b(?:(?:le\s+)?destinataire\s+(?:est|devient)\s+desormais|the\s+recipient\s+(?:is|becomes)\s+now)\b/.test(normalized)
    || /\b(?:destinataire|recipient)\s+(?:autre|another|different)\b/.test(normalized)
    || /\b(?:cible\s+desormais|deployment\s+target)\s+production\b/.test(normalized);
  const explicitSendOrRetarget = boundedInstructionClauses(text)
    // This is a one-way safety veto. Splitting a conjunction can only retain
    // the stronger existing contract; it never grants mutation authority.
    .flatMap(rawClause => rawClause.split(/\b(?:et|puis|ensuite|and|then)\b/iu))
    .flatMap(rawClause => rawClause.split(','))
    .some((rawClause) => {
      const clause = foldForIntent(withoutClauseConnector(rawClause))
        .replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
      if (matchesExecutionAuthorityRevocation(clause)) return false;
      const polite = String.raw`(?:(?:maintenant|now)\s+)?(?:(?:merci\s+de|please|(?:tu|vous)\s+(?:dois|devez)|you\s+must)\s+)?`;
      const sends = new RegExp(
        String.raw`^${polite}(?:envoi(?:e|es)|envoyez|envoyer|expedi(?:e|ez)|renvoi(?:e|ez)|reexpedi(?:e|ez)|relance(?:z)?\s+(?:l\s*)?envoi|fais\s+(?:suivre|partir)|faites\s+(?:suivre|partir)|retransmet(?:s|tez|tre)?|send|resend|forward|retransmit|deliver)\b`,
      ).test(clause);
      const retargets = new RegExp(
        String.raw`^${polite}(?:(?:bascule|basculez|redirige|redirigez|retarget|switch)\b(?:(?!\b(?:lecture\s+seule|read\s+only)\b).){0,120}(?:\b(?:cible|target|destinataire|recipient|production)\b|\bvers\b)|(?:promeus|promouvez|promote)\b[^.!?;]{0,120}\b(?:version|revision|production)\b|(?:utilise|utilisez|use)\b[^.!?;]{0,120}\b(?:comme\s+(?:le\s+|la\s+)?(?:destinataire|cible)|as\s+(?:the\s+)?(?:recipient|target))\b)`,
      ).test(clause);
      const operationalMutation = new RegExp(
        String.raw`^${polite}(?:pousse|poussez|push|commit|committe|commitez|demarre|demarrez|start|relance|relancez|restart)\b`,
      ).test(clause);
      return sends || retargets || operationalMutation;
    });
  return directlyRetargetsTarget || explicitSendOrRetarget;
}

/**
 * Recognize a bounded reporting/closure turn for work whose result and receipts
 * the user says are already established. This is intentionally narrower than
 * an ordinary read-only audit: it requires an explicit mutation ban, existing
 * evidence to reuse, and a request to close rather than re-run the target.
 */
export function isExplicitReadOnlyClosureRequest(text: string): boolean {
  // An in-band host tag is user data, never an authenticated delimiter. Reject
  // it instead of ignoring any send/deploy instruction placed after it.
  if (/<\/?host_objective_contract\b/iu.test(text)) return false;
  const containsTerminalMarker = /\[robb-resume:/iu.test(text);
  if (containsTerminalMarker) return isStrictMarkedTerminalReconciliationEnvelope(text);
  if (hasNonAuthoritativeStructuredLead(text)) return false;
  // Generic reconciliation has no authenticated structured envelope. Consume
  // its complete normalized text using one of the two host-supported forms;
  // an unknown clause can therefore never inherit terminal read-only status.
  const asciiGenericSource = text.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, "'");
  if (/[^\x00-\x7F]/u.test(asciiGenericSource)) return false;
  const normalized = foldForIntent(text).replace(/-/g, ' ').replace(/\s+/g, ' ');
  const receiptOnlyClosure = /^cloture reellement la mission deja realisee avec les preuves du chat deja presentes reutilise les preuves garde la cloture en lecture seule (?:et )?(?:n autorise|nautorise) aucune mutation$/;
  const sameObjectiveReconciliation = /^reprends cette mission uniquement pour reconcilier son etat terminal avec leffet deja accompli tu ne dois creer aucun nouvel effet externe reutilise (?:dabord )?les recus persistes et (?:limite toute observation manquante a une lecture seule|garde toute observation en lecture seule) (?:puis )?termine (?:la mission en complete verified|reellement (?:(?:la mission )?en|comme) complete verified)$/;
  return receiptOnlyClosure.test(normalized) || sameObjectiveReconciliation.test(normalized);
}

/**
 * Literal question/answer scripts may quote punctuation and words such as
 * "contrôle". Match the complete script before treating those literals or the
 * explicit "aucun fichier à modifier" limit as work to execute. Never strip
 * arbitrary quoted text or ignore an unconsumed instruction.
 */
function isLiteralQuestionAnswerScript(normalized: string): boolean {
  // These complete labels describe this conversational check, not work to
  // execute. Never discard an arbitrary preamble or an appended instruction.
  const script = normalized.replace(/^nouvel\s+objectif\s*:\s*/, '')
    .replace(/^(?:test|essai|controle|verification)(?:\s+(?:technique|local|simple|rapide))*\s+de\s+non-regression\s+(?:ui|interface)(?:\s+[a-z0-9_-]{1,40})?[.:]\s*/, '')
    .replace(/^(?:test|essai|controle|verification)(?:\s+natif)?\s+(?:ui|interface)(?:[-\s][a-z0-9_-]{1,40})?[.:]\s*/, '');
  const question = /^(?:pose[z]?|demande[z]?)\s+exactement\s+une\s+question\s+avec\s+(?:l'outil\s+de\s+question\s+utilisateur|(?:l'outil\s+)?request_user_input)\s*:\s*(?:«[^«»]{1,300}»|"[^"]{1,300}")\s*,\s*(?:avec\s+les\s+)?choix\s+[a-z0-9'-]{1,60}\s+(?:ou|et)\s+[a-z0-9'-]{1,60}\.\s*/.exec(script)
    ?? /^(?:utilise[z]?|emploie[z]?)\s+(?:l'outil\s+)?request_user_input\s+pour\s+(?:me|nous)\s+(?:demander|poser)\s*(?:«[^«»]{1,300}»|"[^"]{1,300}")\s*,\s*avec\s+(?:les\s+choix\s+)?[a-z0-9'-]{1,60}\s+(?:ou|et)\s+[a-z0-9'-]{1,60}\.\s*/.exec(script);
  if (!question) return false;
  const remainder = script.slice(question[0].length);
  const response = /^attend(?:s|ez)\s+(?:ma|notre)\s+reponse\.\s*(?:des\s+que\s+je\s+reponds|apres\s+ma\s+reponse)\s*,\s*(?:termine[z]?|repond(?:s|ez))\s+avec\s+une\s+seule\s+phrase\s*:\s*(?:«([^«»]{1,400})»|"([^"]{1,400})")\s*\.\s*/.exec(remainder)
    ?? /^attend(?:s|ez)\s+(?:ma|notre)\s+reponse\.\s*(?:puis\s+)?repond(?:s|ez)\s+(?:uniquement|seulement|simplement)\s*(?:«([^«»]{1,400})»|"([^"]{1,400})")\s*\.\s*/.exec(remainder);
  const literalReply = response?.[1] ?? response?.[2];
  if (!response || !literalReply || !/\b(?:reponse|choix|choisi\w*|preference)\b/.test(literalReply)) return false;
  const limits = remainder.slice(response[0].length).replace(/\.$/, '').trim().split(/\s*,\s*/);
  const scope = new Set<string>();
  for (const limit of limits) {
    const category = /^aucun\s+fichier(?:\s+a\s+modifier)?$/.test(limit) ? 'files'
      : /^aucune\s+action\s+externe$/.test(limit) ? 'external'
        : /^aucune\s+autre\s+(?:demande|tache)$/.test(limit) ? 'other'
          : /^aucun\s+sous-agent$/.test(limit) ? 'delegation' : undefined;
    if (!category || scope.has(category)) return false;
    scope.add(category);
  }
  // The entire script has been consumed: question, literal answer and explicit
  // limits. "No subagent" is sufficient here without a redundant "no other task".
  return scope.has('files') && scope.has('external') && (scope.has('other') || scope.has('delegation'));
}

interface BoundedQuestionAnswerEnvelope {
  reply: string;
  work: string;
}

function normalizedQuestionAnswerRequest(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, "'").replace(/[“”]/g, '"').trim().toLowerCase()
    .replace(/^(?:test|essai|controle|verification)\s+(?:(?:local|simple|rapide)\s+)?(?:des?\s+|de la\s+|du\s+)(?:questions?|preferences?|conversation|clarification)\s*:\s*/, '');
}

function parseBoundedQuestionAnswerEnvelope(normalized: string): BoundedQuestionAnswerEnvelope | undefined {
  const clauses = normalized.split(/[.!?\n]+/).map(part => part.trim()).filter(Boolean);
  if (clauses.length !== 3 && clauses.length !== 4) return undefined;
  const [question] = clauses;
  const boundary = clauses[clauses.length - 1]!;
  const french = /^(?:utilise[z]?|emploie[z]?)\s+(?:l'outil\s+)?request_user_input\s+pour\s+(?:me|nous)\s+(?:demander|poser)\s+[^;:]{1,500}$/.test(question!);
  const english = /^use\s+request_user_input\s+to\s+ask\s+(?:me|us)\s+[^;:]{1,500}$/.test(question!);
  if (!french && !english) return undefined;
  if (!(french
    ? /^aucunes?\s+actions?\s+externes?,\s*aucuns?\s+fichiers?,\s*aucunes?\s+autres?\s+taches?$/
    : /^no\s+external\s+actions?,\s*no\s+files?,\s*no\s+other\s+tasks?$/).test(boundary)) return undefined;
  const response = clauses.length === 3 ? clauses[1]!
    : `${clauses[1]}, ${french ? 'puis' : 'then'} ${clauses[2]}`;
  const reply = (french
    ? /^attend(?:s|ez)\s+(?:ma|notre)\s+reponse\s*,?\s+(?:puis|et)\s+repond(?:s|ez)\s+(?:simplement|uniquement|seulement)\s+([^;:]{1,400})$/
    : /^wait\s+for\s+(?:my|our)\s+(?:answer|response)\s*,?\s+then\s+(?:respond|reply)\s+(?:only|simply)\s+([^;:]{1,400})$/).exec(response)?.[1];
  return reply ? { reply, work: `${question} ${response}` } : undefined;
}

function hasBoundedQuestionAnswerEnvelope(text: string): boolean {
  if (text.length > 1_200) return false;
  const normalized = normalizedQuestionAnswerRequest(text);
  return isLiteralQuestionAnswerScript(normalized)
    || parseBoundedQuestionAnswerEnvelope(normalized) !== undefined;
}

/**
 * A narrowly scoped question/answer exchange is a chat deliverable, even when
 * its introduction calls it a check or its two conversational steps use "then".
 * Consume the entire instruction: an additional inspection/action clause must
 * retain normal evidence requirements. This never reclassifies an existing goal.
 */
function isExplicitQuestionAnswerOnlyRequest(text: string): boolean {
  if (text.length > 1_200 || classifyObjectiveRequest(text).highRisk) return false;
  const normalized = normalizedQuestionAnswerRequest(text);
  if (isLiteralQuestionAnswerScript(normalized)) return true;
  const envelope = parseBoundedQuestionAnswerEnvelope(normalized);
  if (!envelope) return false;
  const { reply, work } = envelope;
  if (!reply || !/\b(?:reponse|choix|choisi\w*|preference|answer|response|choice|chosen|selected)\b/.test(reply)
    || /\b(?:et|and|puis|then|ensuite|apres|after|avant|before)\b/.test(reply)) return false;
  // Fail closed on positive target work, even inside a syntactically valid
  // question/reply clause or beside a contradictory "no external action" line.
  return !isObjectiveMutationRequested(work) && !OBSERVATION_REQUEST_PATTERN.test(work)
    && !/\b(?:lis|lire|lisez|read|ouvr\w*|open|valid\w*|cherche\w*|recherch\w*|search|browse|execut\w*|run|lanc\w*|analys\w*|analyz\w*|fetch|download|telecharg\w*|calcul\w*|compute|evalu\w*|connect\w*|authentic\w*|send|envo\w*|inform\w*|notify|transmet\w*|transfer\w*|deplo\w*|start|restart|demarr\w*|redemarr\w*|automat\w*|schedul\w*|planifi\w*|enregistr\w*|save|sauvegard\w*|update|submit|archive\w*|cancel|commit|merge|move|rename|renomm\w*|restore|restaur\w*|upload|sync\w*|push|pull|appel\w*|call)\b/.test(work)
    && !/(?:https?:\/\/|\bmcp__|\b(?:mets?|mettez|mise)\s+a\s+jour\b|\b(?:serveur|server|endpoint|api|database|repo|repository|fichier|file|artifact|artefact)\b)/.test(work);
}

/** Correct legacy intent flags at evaluation time without rewriting saved objectives. */
export function objectiveRequiresExecutionEvidence(objective: ActiveSessionObjective, fallbackText?: string): boolean {
  let amendmentDecision: boolean | undefined;
  const authorityAmendments = objectiveAuthorityAmendments(objective);
  for (let index = authorityAmendments.length - 1; index >= 0; index--) {
    const text = objectiveAmendmentAuthorityText(authorityAmendments[index]!.text);
    if (explicitlyRevokesExecutionAuthority(text)) {
      amendmentDecision = false;
      break;
    }
    if (isLegacyPlanImplementationRequest(text)
      || amendmentEvidenceRequests(text, objective.delegatedRole).execution
      || latestClauseRequestsExecution(text, objective.delegatedRole)) {
      amendmentDecision = true;
      break;
    }
  }
  const originalText = objectiveAmendmentAuthorityText(objective.originalText ?? fallbackText ?? '');
  const originalStillRequiresExecution = originalText?.trim()
    ? (isObjectiveMutationRequested(originalText)
        || latestClauseRequestsExecution(originalText, objective.delegatedRole))
      && !explicitlyRevokesExecutionAuthority(originalText)
      && !isExplicitReadOnlyReview(originalText)
      && !isChatResponseOnlyEdit(originalText)
    : true;
  // Repair the exact persisted false-negative observed in a misspelled send
  // objective. This is deliberately narrower than recomputing authority for
  // every legacy objective whose host-owned flag is absent.
  const recoveredMisspelledSendAuthority = objective.requiresExecutionEvidence === undefined
    && objective.delegatedRole !== 'reviewer'
    && !!originalText
    && canonicalizeMisspelledSendImperative(originalText) !== originalText
    && originalStillRequiresExecution;
  // An explicit repair command in a legacy root is actionable even when an
  // older router omitted its cached evidence flag. Require a direct French
  // imperative at the start; descriptive, quoted and question forms cannot
  // acquire authority through this migration.
  const recoveredDirectRepairAuthority = objective.requiresExecutionEvidence === undefined
    && objective.delegatedRole !== 'reviewer'
    && !!originalText
    && !hasNonAuthoritativeStructuredLead(originalText)
    && /^(?:solutionne|r[ée]sous|r[èe]gle|r[ée]pare|corrige)\b/iu.test(originalText.trim())
    && originalStillRequiresExecution;
  const recoveredDevLoginReactivationAuthority = objective.requiresExecutionEvidence === undefined
    && objective.delegatedRole !== 'reviewer'
    && !!originalText
    && DEV_LOGIN_REACTIVATION_REQUEST.test(originalText)
    && originalStillRequiresExecution;
  const recoveredPlanImplementationAuthority = objective.requiresExecutionEvidence === undefined
    && objective.delegatedRole !== 'reviewer'
    && !!originalText
    && isLegacyPlanImplementationRequest(originalText)
    && originalStillRequiresExecution;
  const recoveredInvoiceEmailFulfillmentAuthority = objective.requiresExecutionEvidence === undefined
    && objective.delegatedRole !== 'reviewer'
    && !!originalText
    && isDirectInvoiceEmailFulfillmentRequest(originalText)
    && originalStillRequiresExecution;
  const recoveredAutomatedFormCreationAuthority = objective.requiresExecutionEvidence === undefined
    && objective.delegatedRole !== 'reviewer'
    && !!originalText
    && isDirectAutomatedFormCreationRequest(originalText)
    && originalStillRequiresExecution;
  return objective.delegatedRole !== 'reviewer'
    && (objective.requiresExecutionEvidence === true
      || recoveredMisspelledSendAuthority
      || recoveredDirectRepairAuthority
      || recoveredDevLoginReactivationAuthority
      || recoveredPlanImplementationAuthority
      || recoveredInvoiceEmailFulfillmentAuthority
      || recoveredAutomatedFormCreationAuthority)
    && (amendmentDecision ?? originalStillRequiresExecution);
}

/** Rebuild only the completion obligations omitted by the known pre-classifier
 * historical objective schemas. This projection is runtime-only: persisted authority is
 * never broadened, and explicit false/revoked fields remain authoritative. */
export function projectLegacyObjectiveCompletionRequirements(
  objective: ActiveSessionObjective,
  fallbackText?: string,
): ActiveSessionObjective {
  if (objective.requiresExecutionEvidence !== undefined
    || objective.requiresAcceptanceCriteria !== undefined
    || !objectiveRequiresExecutionEvidence(objective, fallbackText)) return objective;
  return {
    ...objective,
    requiresExecutionEvidence: true,
    requiresAcceptanceCriteria: true,
  };
}

export function transitionObjectiveContract(input: ObjectiveTransitionInput): ActiveSessionObjective {
  const nowMs = input.nowMs ?? Date.now();
  const authorityText = objectiveAmendmentAuthorityText(input.text);
  const readOnlyClosure = isExplicitReadOnlyClosureRequest(input.text);
  const terseContextualRepair = isTerseContextualRepairAmendment(input.text);
  const executionChannelCorrection = isExecutionChannelCorrection(input.text);
  const terminalReconciliation = !!input.existing && readOnlyClosure
    && !startsExplicitNewObjective(input.text);
  if (input.existing && terminalReconciliation) {
    const alreadyRecorded = input.existing.amendments?.some(amendment => (
      amendment.messageId === input.messageId
    ));
    // This is the same objective and the same host-owned contract. The user
    // turn constrains how its terminal state is reconciled; it does not become
    // an acceptance revision, target change, payload change or new authority.
    return {
      ...input.existing,
      terminalReconciliation: {
        messageId: input.messageId,
        // Once the host grants the one-time initial-registration capability,
        // its timestamp is the immutable lower bound for both registration and
        // the optional review. Repeating the same closure after registration
        // must not move that bound past acceptanceRegisteredAt and deadlock it.
        timestamp: input.existing.terminalReconciliation
          ?.initialAcceptanceRegistrationRequired === true
          ? input.existing.terminalReconciliation.timestamp : nowMs,
        ...(input.existing.terminalReconciliation?.initialAcceptanceRegistrationRequired
          || input.existing.requiresAcceptanceCriteria === true
            && (!input.existing.acceptanceCriteria?.length || input.existing.acceptanceNeedsReview === true)
          ? { initialAcceptanceRegistrationRequired: true as const } : {}),
      },
      lastUserMessageId: input.messageId,
      continuationCount: input.existing.continuationCount + 1,
      terminalState: 'active',
      completedAt: undefined,
      lastOutcome: undefined,
      interruptedTurnRecovery: undefined,
      amendments: input.text.trim() && !alreadyRecorded
        ? [...(input.existing.amendments ?? []), {
            messageId: input.messageId, text: input.text, timestamp: nowMs,
          }]
        : input.existing.amendments,
    };
  }
  const preserveExisting = input.existing
    && !startsExplicitNewObjective(input.text)
    // A valid reconciliation returned above with its current contract intact.
    // If review is unresolved, keep the objective fail-closed here instead of
    // silently creating a criteria-free reporting objective.
    // While work is active, user feedback steers that work unless the user
    // explicitly changes the mission. Replacing the root on an unrecognized
    // clarification loses its acceptance checks, evidence and budget baseline.
    && (input.existing.terminalState === 'active'
      || looksLikeContinuation(input.text)
        && (input.existing.terminalState !== 'complete_verified'
          || !terseContextualRepair && !executionChannelCorrection));
  if (input.existing && preserveExisting) {
    const substantiveAmendment = !!input.text.trim() && !isBareObjectiveContinuation(input.text)
      && !isObjectiveStatusOnly(input.text)
      && input.messageId !== input.existing.lastUserMessageId
      && !input.existing.amendments?.some(item => item.messageId === input.messageId);
    const presentationOnlyAmendment = substantiveAmendment
      && isResponsePresentationOnlyAmendment(input.text)
      // The presentation recognizer is intentionally conversational, but a
      // trailing send/retarget instruction changes the protected target. A
      // terminal lock must fail closed rather than preserve itself here.
      && !hasExplicitTerminalContractMutation(authorityText);
    // Preserving the root must not preserve a response-only completion shortcut
    // when an accepted amendment now asks for artifacts or observations. Reuse
    // the normal request classifier, but promote only evidence obligations;
    // identity, accounting, execution permissions and model settings stay put.
    const amendment = substantiveAmendment ? transitionObjectiveContract({
      messageId: input.messageId, text: authorityText, delegatedRole: input.existing.delegatedRole,
      nowMs,
    }) : undefined;
    // Terse amendments such as "fix the reported issues" own their mutation
    // authority but inherit only the referenced domain from the accepted root.
    // Historical imperative wording therefore cannot become a fresh command,
    // while RBAC/credential/production findings still keep their safety tier.
    const contextualAmendment = substantiveAmendment
      ? classifyObjectiveRequest(authorityText, objectiveRiskContext(input.existing))
      : undefined;
    const requestedEvidence = substantiveAmendment
      ? amendmentEvidenceRequests(authorityText, input.existing.delegatedRole)
      : undefined;
    if (requestedEvidence && latestClauseRequestsExecution(authorityText, input.existing.delegatedRole)) {
      requestedEvidence.execution = true;
    }
    // Once a terminal no-effect boundary exists, conversational acknowledgments
    // and unclassified prose cannot silently reopen the old mutation. Only a
    // positively classified execution/observation instruction (or an explicit
    // new objective handled above) may replace the terminal contract.
    const terminalAuthorityAmendment = requestedEvidence?.execution === true
      || requestedEvidence?.observation === true
      || isPrecisionOrCompletenessChallenge(input.text)
      || hasExplicitTerminalContractMutation(authorityText);
    const acceptanceRelevantAmendment = substantiveAmendment
      && !presentationOnlyAmendment
      && (!input.existing.terminalReconciliation || terminalAuthorityAmendment);
    const executionAuthorityRevoked = substantiveAmendment
      && explicitlyRevokesExecutionAuthority(authorityText);
    const requiresExecutionEvidence = !executionAuthorityRevoked
      && (objectiveRequiresExecutionEvidence(input.existing) || requestedEvidence?.execution);
    const requiresObservationEvidence = input.existing.requiresObservationEvidence || requestedEvidence?.observation;
    const requiresAcceptanceCriteria = input.existing.requiresAcceptanceCriteria || requiresExecutionEvidence || requiresObservationEvidence;
    const clarificationHighStakes = reclassifiedHighStakesClarification(
      input.existing,
      authorityText,
      substantiveAmendment,
    );
    const persistedHighStakes = substantiveAmendment
      ? undefined
      : reclassifiedPersistedHighStakesObjective(input.existing);
    const candidateEvidenceDomain = persistedHighStakes !== undefined
      ? persistedHighStakes.evidenceDomain
      : clarificationHighStakes !== undefined
        ? clarificationHighStakes.evidenceDomain
      : (substantiveAmendment
        ? classifyAuthorizedObjectiveEvidenceDomain(authorityText)
          ?? (requestedEvidence?.execution
            ? latestExplicitAuditEvidenceDomain(input.existing)
            : retainedObjectiveEvidenceDomain(input.existing))
        : retainedObjectiveEvidenceDomain(input.existing));
    const correctsLegacyMedicalFalsePositive = canCorrectLegacyMedicalFalsePositive(
      input.existing,
      authorityText,
      substantiveAmendment,
    );
    const correctsLegacyTechnicalLegalFalsePositive = canCorrectLegacyTechnicalLegalFalsePositive(
      input.existing,
      authorityText,
      substantiveAmendment,
    );
    const correctsLegacyEvidenceFalsePositive = correctsLegacyMedicalFalsePositive
      || correctsLegacyTechnicalLegalFalsePositive;
    const currentOperationalRestatement = substantiveAmendment
      && (isConcreteOperationalSoftwareRestatement(objectiveAmendmentAuthorityText(input.text))
        || isOperationalTechnicalContractLifecycleObjective(objectiveAmendmentAuthorityText(input.text)))
      && classifyAuthorizedObjectiveEvidenceDomain(objectiveAmendmentAuthorityText(input.text)) === undefined
      && detectHighStakesEvidenceDomain(objectiveAmendmentAuthorityText(input.text)) === undefined;
    const amendmentCarriesHighStakesRisk = amendment?.risk === 'high-stakes'
      // A complete, current operational restatement owns its own subject.
      // Contextual classification still sees the historical journal and can
      // otherwise recreate the obsolete legal/medical label that the bounded
      // migration below just disproved. Genuine historical high-stakes work is
      // preserved separately because `correctsLegacyEvidenceFalsePositive`
      // remains false for a real legal, clinical or security segment.
      || contextualAmendment?.highRisk === true && !currentOperationalRestatement
      || clarificationHighStakes !== undefined
      || persistedHighStakes !== undefined;
    // The explicit correction may itself mention a missing secret or medical
    // source while saying those are not the task. Do not replace the stale
    // medical domain with another mention-only domain unless the amendment's
    // scoped mutation classifier independently establishes high stakes.
    const evidenceDomain = correctsLegacyEvidenceFalsePositive && !amendmentCarriesHighStakesRisk
      ? undefined
      : candidateEvidenceDomain;
    // A deictic correction ("fix the findings") inherits the latest audited
    // sensitive subject. The earlier read-only audit did not grant mutation
    // authority; this explicit correction does, and must now receive the same
    // high-stakes source/review protections as a fully restated request.
    const amendmentHighStakes = amendmentCarriesHighStakesRisk
      || requestedEvidence?.execution === true && !!evidenceDomain;
    const highStakes = amendmentHighStakes
      || input.existing.risk === 'high-stakes' && !correctsLegacyEvidenceFalsePositive;
    const evidenceRequired = highStakes && requiresExecutionEvidence && !!evidenceDomain;
    const mission = input.existing.orchestrationMode === 'mission'
      || amendment?.orchestrationMode === 'mission'
      || amendmentHighStakes;
    const existingTerminalReview = input.existing.delegatedRole === 'reviewer'
      || !requiresExecutionEvidence
        && !!input.existing.originalText
        && isExplicitReadOnlyReview(objectiveAmendmentAuthorityText(input.existing.originalText));
    const completionCriteria = existingTerminalReview
      ? input.existing.completionCriteria.filter(criterion => criterion !== 'independent-review-passed')
      : !highStakes && correctsLegacyEvidenceFalsePositive
      ? input.existing.completionCriteria.filter(criterion => criterion !== 'independent-review-passed')
      : amendmentHighStakes && input.existing.delegatedRole !== 'reviewer'
          && !input.existing.completionCriteria.includes('independent-review-passed')
        ? [...input.existing.completionCriteria, 'independent-review-passed' as const]
        : input.existing.completionCriteria;
    const continued: ActiveSessionObjective = {
      ...input.existing,
      ...(requiresExecutionEvidence ? { requiresExecutionEvidence: true } : {}),
      ...(requiresObservationEvidence ? { requiresObservationEvidence: true } : {}),
      ...(requiresAcceptanceCriteria ? { requiresAcceptanceCriteria: true } : {}),
      ...(evidenceDomain ? { evidenceDomain } : {}),
      ...(!input.existing.evidenceRequirement && evidenceRequired
        ? { evidenceRequirement: 'authoritative-sources-before-mutation' as const } : {}),
      risk: highStakes ? 'high-stakes' : 'standard',
      completionCriteria,
      ...(mission ? { orchestrationMode: 'mission' as const } : {}),
      // A new accepted message supersedes the stopped turn's Retry anchor.
      interruptedTurnRecovery: undefined,
      // A substantive non-reconciliation amendment supersedes the dedicated
      // terminal mode. Historical reconciliation prompts remain excluded from
      // authority by objectiveAuthorityAmendments.
      terminalReconciliation: acceptanceRelevantAmendment
        ? undefined : input.existing.terminalReconciliation,
      ...(acceptanceRelevantAmendment && (input.existing.acceptanceCriteria?.length || isPrecisionOrCompletenessChallenge(input.text)) ? {
        acceptanceRevision: input.messageId, acceptanceNeedsReview: true,
      } : {}),
      objectiveId: input.existing.objectiveId ?? input.existing.userMessageId,
      lastUserMessageId: input.messageId,
      continuationCount: input.existing.continuationCount + 1,
      terminalState: 'active',
      completedAt: undefined,
      lastOutcome: undefined,
      amendments: input.text.trim() && !isBareObjectiveContinuation(input.text)
        && !input.existing.amendments?.some(amendment => amendment.messageId === input.messageId)
        ? [...(input.existing.amendments ?? []), { messageId: input.messageId, text: input.text, timestamp: nowMs }]
        : input.existing.amendments,
    };
    // Normalize legacy false positives while the objective is already being
    // persisted for a new turn. Keeping the stale raw flag would make callers
    // that have not yet adopted objectiveRequiresExecutionEvidence disagree.
    if (!requiresExecutionEvidence) {
      delete continued.requiresExecutionEvidence;
    }
    if (!evidenceRequired) {
      delete continued.evidenceRequirement;
    }
    if (!evidenceDomain) {
      delete continued.evidenceDomain;
    }
    return continued;
  }

  const requestClassification = classifyObjectiveRequest(authorityText);
  // The broad router treats the standalone noun “santé” as medical. In a
  // fully restated software recovery mission with a concrete host/path,
  // service action and technical verification, the narrower evidence-domain
  // classifier has already proved that no legal, medical, financial or
  // security subject remains after neutralizing only operational health.
  const concreteOperationalSoftware = isConcreteOperationalSoftwareRestatement(authorityText);
  const highStakes = !readOnlyClosure && requestClassification.highRisk && !concreteOperationalSoftware;
  const readOnlyReview = input.delegatedRole === 'reviewer' || isExplicitReadOnlyReview(authorityText);
  const questionAnswerOnly = isExplicitQuestionAnswerOnlyRequest(authorityText);
  const requiresExecutionEvidence = !readOnlyClosure && (requestClassification.mutationRequested
      || latestClauseRequestsExecution(authorityText, input.delegatedRole))
    && !explicitlyRevokesExecutionAuthority(authorityText)
    && !readOnlyReview && !questionAnswerOnly && !isChatResponseOnlyEdit(authorityText);
  const requiresObservationEvidence = !readOnlyClosure && !questionAnswerOnly
    && (OBSERVATION_REQUEST_PATTERN.test(authorityText) || readOnlyReview);
  // A read-only audit may establish the subject of a later deictic correction,
  // but never mutation authority. The separate requirement below is created
  // only when this same objective actually requests execution.
  const evidenceDomain = readOnlyClosure ? undefined : detectHighStakesEvidenceDomain(authorityText);
  const mission = !readOnlyClosure && !questionAnswerOnly
    && (highStakes || MULTI_STEP_PATTERN.test(authorityText));
  const completionCriteria: ActiveSessionObjective['completionCriteria'] = [
    'requested-outcome-delivered',
    'relevant-checks-passed',
    'no-safe-work-remaining',
  ];
  // An explicit independent read-only review is already the terminal reviewer.
  // Requiring a review of that review creates an unbounded reviewer chain.
  if (highStakes && !readOnlyReview && input.delegatedRole !== 'reviewer') {
    completionCriteria.push('independent-review-passed');
  }

  return {
    schemaVersion: 1,
    originalText: input.text,
    ...(input.delegatedRole ? { delegatedRole: input.delegatedRole } : {}),
    ...(requiresExecutionEvidence || requiresObservationEvidence ? { requiresAcceptanceCriteria: true } : {}),
    ...(requiresObservationEvidence ? { requiresObservationEvidence: true } : {}),
    objectiveId: input.messageId,
    userMessageId: input.messageId,
    lastUserMessageId: input.messageId,
    startedAt: nowMs,
    budgetBaselineUsd: Math.max(0, input.lifetimeCostUsd ?? 0),
    tokenBaseline: Math.max(0, input.lifetimeTokens ?? 0),
    continuationCount: 0,
    orchestrationMode: mission ? 'mission' : 'direct',
    risk: highStakes ? 'high-stakes' : 'standard',
    ...(requiresExecutionEvidence ? { requiresExecutionEvidence: true } : {}),
    ...(evidenceDomain ? { evidenceDomain } : {}),
    ...(highStakes && requiresExecutionEvidence && evidenceDomain
      ? { evidenceRequirement: 'authoritative-sources-before-mutation' as const }
      : {}),
    completionCriteria,
    // A fresh informational closure has no earlier contract to recover, but it
    // still carries the same no-effect host lock. A later substantive user
    // amendment clears this marker through the ordinary amendment path.
    ...(readOnlyClosure ? { terminalReconciliation: {
      messageId: input.messageId,
      timestamp: nowMs,
    } } : {}),
    terminalState: 'active',
  };
}

export function objectiveCostUsd(
  objective: ActiveSessionObjective | undefined,
  lifetimeCostUsd: number | undefined,
): number {
  const lifetime = Math.max(0, lifetimeCostUsd ?? 0);
  return objective ? Math.max(0, lifetime - objective.budgetBaselineUsd) : lifetime;
}

export function findObjectiveText(
  messages: Message[],
  objective: ActiveSessionObjective | undefined,
): string | undefined {
  if (!objective) return undefined;
  return objective.originalText ?? messages.find(message => (
    message.id === objective.userMessageId && message.role === 'user'
  ))?.content;
}

const LEGACY_SOURCE_ACTIVATION_SUFFIX = /\n\n\[[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])? activated\]$/;
const LEGACY_AUTONOMY_FALLBACK_MESSAGE = /^<automatic_(browser|structured)_fallback\b[^>]*>[\s\S]*<\/automatic_\1_fallback>$/;
const LEGACY_AUTOMATIC_RECOVERY_MESSAGE = /^<automatic_turn_recovery\b[^>]*>[\s\S]*<\/automatic_turn_recovery>$/;

export function isHostSyntheticObjectiveText(content: string): boolean {
  const normalized = content.trim();
  const withoutActivationSuffix = normalized.replace(LEGACY_SOURCE_ACTIVATION_SUFFIX, '');
  return withoutActivationSuffix !== normalized
    || LEGACY_AUTONOMY_FALLBACK_MESSAGE.test(withoutActivationSuffix)
    || LEGACY_AUTOMATIC_RECOVERY_MESSAGE.test(normalized);
}

/**
 * Host continuations are model context, never objective authority. Current
 * rows carry `hidden`/`internalOrigin`; the content checks cover the exact
 * metadata-less rows written by older source-activation and recovery paths.
 */
export function isHostSyntheticObjectiveMessage(message: Message): boolean {
  if (message.role !== 'user') return false;
  if (message.hidden || message.isQueued || message.isPending || message.agentDelivery) return true;
  if (message.internalOrigin
    && message.internalOrigin.kind !== 'spawned-session'
    && message.internalOrigin.kind !== 'automation') return true;
  return isHostSyntheticObjectiveText(message.content);
}

/**
 * Rebuild the semantic contract visible at a branch anchor. Never copy state
 * produced by messages after the anchor. A full-history branch can retain the
 * exact registered contract; an earlier branch conservatively replays only its
 * visible user turns and cannot inherit future criteria or outcomes.
 */
export function reconstructObjectiveForBranch(input: {
  messages: Message[];
  sourceObjective?: ActiveSessionObjective;
  completeSourceHistory: boolean;
}): ActiveSessionObjective | undefined {
  const userMessages = input.messages.filter(message => (
    message.role === 'user' && !isHostSyntheticObjectiveMessage(message)
  ));
  if (userMessages.length === 0) return undefined;

  const rootCopied = input.sourceObjective
    && userMessages.some(message => message.id === input.sourceObjective?.userMessageId);
  if (rootCopied && input.completeSourceHistory) {
    return { ...input.sourceObjective!, interruptedTurnRecovery: undefined };
  }

  let reconstructed: ActiveSessionObjective | undefined;
  for (const message of userMessages) {
    // The first internal dispatch can own a child session. Later internal
    // coordination never changes that child's accepted objective.
    if (reconstructed && message.internalOrigin) continue;
    const text = input.sourceObjective?.userMessageId === message.id
      ? input.sourceObjective.originalText ?? message.content
      : message.content;
    reconstructed = transitionObjectiveContract({
      existing: reconstructed,
      messageId: message.id,
      text,
      nowMs: message.timestamp,
      delegatedRole: input.sourceObjective?.delegatedRole,
    });
  }
  if (!reconstructed) return undefined;
  if (input.sourceObjective?.userMessageId === reconstructed.userMessageId) {
    reconstructed = {
      ...reconstructed,
      objectiveId: input.sourceObjective.objectiveId ?? reconstructed.objectiveId,
      startedAt: input.sourceObjective.startedAt,
      budgetBaselineUsd: input.sourceObjective.budgetBaselineUsd,
      tokenBaseline: input.sourceObjective.tokenBaseline,
      ...(input.sourceObjective.model ? { model: input.sourceObjective.model } : {}),
      ...(input.sourceObjective.thinkingLevel
        ? { thinkingLevel: input.sourceObjective.thinkingLevel } : {}),
    };
  }
  return reconstructed;
}

function stableValue(value: unknown, depth = 0): unknown {
  if (depth >= 5) return '[depth-limit]';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim().slice(0, 2_048);
  if (Array.isArray(value)) return value.slice(0, 64).map(child => stableValue(child, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 64)
      .map(([key, child]) => [key, stableValue(child, depth + 1)]),
  );
}

function normalizedToolTarget(input: Record<string, unknown> | undefined): string {
  if (!input) return '{}';
  const targetEntries = Object.entries(input)
    .filter(([key]) => OBSERVATION_TARGET_KEY_PATTERN.test(key));
  const source = targetEntries.length > 0 ? Object.fromEntries(targetEntries) : input;
  try {
    return JSON.stringify(stableValue(source)).slice(0, MAX_CANONICAL_INPUT_CHARS);
  } catch {
    return '[unserializable-input]';
  }
}

function resultDigest(message: Message): string {
  const raw = message.toolResult ?? message.content ?? '';
  const normalized = raw.replace(/\r\n/g, '\n').trim();
  const bounded = normalized.length <= MAX_RESULT_DIGEST_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_RESULT_DIGEST_CHARS / 2)}\n[...bounded...]\n${normalized.slice(-MAX_RESULT_DIGEST_CHARS / 2)}`;
  return createHash('sha256').update(bounded).digest('hex').slice(0, 16);
}

function mutationTransformDigest(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const transformEntries = Object.entries(input)
    .filter(([key]) => MUTATION_TRANSFORM_KEY_PATTERN.test(key));
  if (transformEntries.length === 0) return undefined;
  let canonical: string;
  try {
    canonical = JSON.stringify(stableValue(Object.fromEntries(transformEntries)));
  } catch {
    canonical = '[unserializable-transform]';
  }
  const bounded = canonical.length <= MAX_TRANSFORM_DIGEST_CHARS
    ? canonical
    : `${canonical.slice(0, MAX_TRANSFORM_DIGEST_CHARS / 2)}[...bounded...]${canonical.slice(-MAX_TRANSFORM_DIGEST_CHARS / 2)}`;
  return createHash('sha256').update(bounded).digest('hex').slice(0, 16);
}

function isPassiveNoProgressTool(message: Message): boolean {
  const toolName = message.toolName ?? '';
  if (PASSIVE_NO_PROGRESS_TOOL_PATTERN.test(toolName)) return true;
  if (/^(?:write_stdin|read_thread_terminal)$/i.test(toolName)) {
    const chars = message.toolInput?.chars;
    if (chars === undefined || chars === '') return true;
  }
  const action = [message.toolInput?.action, message.toolInput?.command, message.toolInput?.operation]
    .find((value): value is string => typeof value === 'string');
  return action ? PASSIVE_NO_PROGRESS_ACTION_PATTERN.test(action.trim()) : false;
}

export function isObjectiveToolExecutedSuccessfully(message: Message): boolean {
  if (message.role !== 'tool' || message.toolStatus !== 'completed' || message.isError) return false;
  const runtimeMessage = message as Message & {
    continuationRequired?: boolean;
    toolExecutionStatus?: 'executed' | 'not-executed' | string;
  };
  if (
    message.toolExecuted === false
    || message.toolCheckpoint !== undefined
    || runtimeMessage.continuationRequired
    || runtimeMessage.toolExecutionStatus === 'not-executed'
  ) return false;
  const output = message.toolResult ?? message.content ?? '';
  return !NON_EXECUTED_CHECKPOINT_PATTERN.test(output);
}

/** Session transport tools cannot stand in for evidence about the user target. */
export function isObjectiveCoordinationTool(message: Message): boolean {
  return SESSION_COORDINATION_TOOL_PATTERN.test(message.toolName ?? '')
    || PLAN_TRACKING_TOOL_PATTERN.test(message.toolName ?? '');
}

/** True only for a real completed invocation whose persisted result can serve as evidence. */
export function hasObjectiveSubstantiveToolResult(message: Message): boolean {
  if (!isObjectiveToolExecutedSuccessfully(message)
    || isObjectiveCoordinationTool(message)) return false;
  // `content` is only a UI label. Safety-net completion can mark a child tool
  // completed without ever receiving a genuine tool_result, leaving this empty.
  const result = message.toolResult?.trim();
  return !!result && !NON_SUBSTANTIVE_TOOL_RESULT_PATTERN.test(result);
}

function positiveHttpPostTargetMutation(input: Record<string, unknown>): boolean {
  const target = [input.path, input.url, input.uri, input.endpoint, input.route]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (!target) return false;
  let pathname = target.trim().split(/[?#]/, 1)[0] ?? '';
  try {
    pathname = new URL(target).pathname;
  } catch {
    // Relative connector paths are the common case.
  }
  const tokens = normalizeToolLeafName(pathname).split('_').filter(Boolean);
  return tokens.some(token => POSITIVE_HTTP_POST_TARGET_TOKENS.has(token));
}

/** High-confidence mutation evidence, not the broader conservative invalidation boundary. */
export function isObjectiveMutationTool(message: Message): boolean {
  const toolName = message.toolName ?? '';
  if (PLAN_TRACKING_TOOL_PATTERN.test(toolName)
    || /^(?:mcp__session__|session__)?(?:set_completion_criteria|project_learning)$/.test(toolName)
    || OBJECTIVE_NON_EXECUTING_PREFLIGHT_TOOLS.has(toolName)) return false;
  const input = message.toolInput ?? {};
  // Structured connector semantics are authoritative even when the connector
  // name itself is neutral (for example graph_request with method: POST).
  // Inspect only the bounded action/method fields here: arbitrary query and
  // command payloads remain meaningful solely for generic executors below.
  const action = [input.action, input.operation]
    .find((value): value is string => typeof value === 'string');
  if (action && classifyToolNameMutationSemantics(action.trim()) === 'mutation') return true;
  const method = input.method;
  if (typeof method === 'string') {
    const normalizedMethod = method.trim();
    if (POSITIVE_MUTATION_HTTP_METHOD_PATTERN.test(normalizedMethod)) return true;
    if (/^POST$/i.test(normalizedMethod) && positiveHttpPostTargetMutation(input)) return true;
  }
  const usesInputSemantics = GENERIC_EXECUTE_TOOL_PATTERN.test(toolName)
    || /^(?:functions\.)?(?:Bash|Shell)$/i.test(toolName);
  if (!usesInputSemantics) {
    return classifyToolNameMutationSemantics(toolName) === 'mutation';
  }
  const query = [input.query, input.sql, input.statement]
    .find((value): value is string => typeof value === 'string');
  if (query && MUTATION_SQL_PATTERN.test(query)) return true;
  const command = [message.toolInput?.command, message.toolInput?.cmd, message.toolInput?.script]
    .find((value): value is string => typeof value === 'string') ?? '';
  // The AST-backed read-only classifier also recognizes non-editing forms of
  // commands such as `sed -n`; the mutation regex alone flags their name.
  if (command && isProvablyReadOnlyShellCommand(command)) return false;
  return MUTATION_BASH_PATTERN.test(command) || hasShellOutputRedirection(command);
}

/** Internal delivery and current-chat status do not change the verified target. */
export function isObjectiveEvidenceInvalidatingMutation(message: Message): boolean {
  const input = message.toolInput;
  // Limit this to the existing current-session handler shape. Other targets,
  // connector namespaces, permissions and future added operations stay guarded.
  const currentSessionStatus = /^(?:mcp__session__|session__)?set_session_status$/.test(message.toolName ?? '')
    && typeof input?.status === 'string' && input.status.trim().length > 0
    && Object.keys(input).every(key => key === 'status' || key === '_displayName' || key === '_intent');
  if (currentSessionStatus || isObjectiveCoordinationTool(message)) return false;
  if (isObjectiveMutationTool(message)) return true;

  // POST is also used by searches, validations and GraphQL queries. Method
  // alone therefore remains a conservative chronology boundary without
  // becoming positive proof that the requested mutation occurred.
  const method = input?.method;
  if (typeof method === 'string' && MUTATION_HTTP_METHOD_PATTERN.test(method.trim())) return true;

  const toolName = message.toolName ?? '';
  const usesInputSemantics = GENERIC_EXECUTE_TOOL_PATTERN.test(toolName)
    || /^(?:functions\.)?(?:Bash|Shell)$/i.test(toolName);
  if (!usesInputSemantics) {
    // Mixed compound names such as `get_and_process` are deliberately not
    // accepted as observations. They must nevertheless invalidate an older
    // observation because their side effects are unknown.
    return classifyToolNameMutationSemantics(toolName) === 'ambiguous-compound';
  }

  const semanticInput = message.toolInput ?? {};
  const command = [semanticInput.command, semanticInput.cmd, semanticInput.script]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (command) {
    // Fail closed for completed shell execution unless the same AST-backed
    // policy used by Safe mode proves that every command is read-only.
    return !isProvablyReadOnlyShellCommand(command);
  }
  const query = [semanticInput.query, semanticInput.sql, semanticInput.statement]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  // A generic SQL executor does not expose enough database semantics to prove
  // that SELECT/functions/CTEs are side-effect free. It may still count as
  // positive execution only when the mutation grammar above recognizes it,
  // but every non-empty statement invalidates older target observations.
  if (query) return true;
  const action = [semanticInput.action, semanticInput.operation]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return action ? classifyToolNameMutationSemantics(action) !== 'neutral' : false;
}

export interface TurnProgressFingerprints {
  /** Combined backwards-compatible fingerprint consumed by turn recovery. */
  fingerprint: string;
  /** Semantic observations: tool + normalized target/query + bounded result digest. */
  evidenceProgress: string;
  /** Confirmed mutations, kept separate from observational evidence. */
  executionProgress: string;
  evidenceCount: number;
  executionCount: number;
}

/** Stable semantic progress signals. Repeated reads, waits and unexecuted checkpoints do not advance them. */
export function turnProgressFingerprints(messages: Message[], userMessageId: string): TurnProgressFingerprints {
  const userIndex = messages.findIndex(message => message.id === userMessageId && message.role === 'user');
  if (userIndex < 0) {
    return {
      fingerprint: 'missing-objective',
      evidenceProgress: 'missing-objective',
      executionProgress: 'missing-objective',
      evidenceCount: 0,
      executionCount: 0,
    };
  }
  const evidence = new Set<string>();
  const execution = new Set<string>();
  for (const message of messages.slice(userIndex + 1)) {
    if (!isObjectiveToolExecutedSuccessfully(message) || isPassiveNoProgressTool(message)
      || isObjectiveCoordinationTool(message)) continue;
    const mutation = isObjectiveMutationTool(message);
    const transformDigest = mutation ? mutationTransformDigest(message.toolInput) : undefined;
    const signal = [
      (message.toolName ?? 'tool').toLowerCase(),
      normalizedToolTarget(message.toolInput),
      ...(transformDigest ? [`transform:${transformDigest}`] : []),
      resultDigest(message),
    ].join(':');
    (mutation ? execution : evidence).add(signal);
  }
  const evidenceSignals = [...evidence].sort().join('|');
  const executionSignals = [...execution].sort().join('|');
  const evidenceProgress = createHash('sha256').update(evidenceSignals).digest('hex').slice(0, 16);
  const executionProgress = createHash('sha256').update(executionSignals).digest('hex').slice(0, 16);
  return {
    fingerprint: createHash('sha256')
      .update(`e:${evidenceProgress}:${evidence.size}|x:${executionProgress}:${execution.size}`)
      .digest('hex')
      .slice(0, 16),
    evidenceProgress,
    executionProgress,
    evidenceCount: evidence.size,
    executionCount: execution.size,
  };
}

/** Backwards-compatible combined progress fingerprint. */
export function turnProgressFingerprint(messages: Message[], userMessageId: string): string {
  return turnProgressFingerprints(messages, userMessageId).fingerprint;
}

const MUTATION_BASH_PATTERN = /(?:^|\s)(?:apply_patch|chmod|chown|cp|install|ln|mkdir|mv|rm|rmdir|sed\s+-i|touch|truncate|deploy|git\s+(?:commit|merge|push)(?![-\w])|systemctl\s+(?:disable|enable|restart|start|stop)|(?:npm|bun|pnpm|yarn)\s+(?:install|publish)|(?:python\d*|bun|node)\s+[^\n]*(?:build|generate|write|create)|docx-tool|xlsx-tool|pptx-tool|pdf-tool)\b/i;

export function hasObjectiveExecutionEvidence(messages: Message[], userMessageId: string): boolean {
  const userIndex = messages.findIndex(message => message.id === userMessageId && message.role === 'user');
  if (userIndex < 0) return false;
  return messages.slice(userIndex + 1).some(message => {
    // Potential/unknown mutations invalidate stale observations, but they do
    // not positively prove that the requested action occurred.
    return isObjectiveToolExecutedSuccessfully(message)
      && isObjectiveMutationTool(message)
      && isObjectiveEvidenceInvalidatingMutation(message);
  });
}

export function objectiveReviewBinding(objective: ActiveSessionObjective): { objectiveId: string; acceptanceSha256: string } {
  return { objectiveId: objective.objectiveId ?? objective.userMessageId,
    acceptanceSha256: createHash('sha256').update(JSON.stringify(objective.acceptanceRevision || objective.procedure
      ? { criteria: objective.acceptanceCriteria ?? [], procedure: objective.procedure, revision: objective.acceptanceRevision }
      : objective.acceptanceCriteria ?? [])).digest('hex') };
}

/** A content check cannot replace registered checks or evidence of an external action. */
export function objectiveAllowsContentCheckReview(objective: ActiveSessionObjective, fallbackText?: string): boolean {
  const request = objectiveAmendmentAuthorityText(objective.originalText ?? fallbackText ?? '');
  return !!request?.trim()
    && (!isObjectiveMutationRequested(request) || isChatResponseOnlyEdit(request))
    && !OBSERVATION_REQUEST_PATTERN.test(request)
    && objective.requiresExecutionEvidence !== true
    && !objectiveRequiresExecutionEvidence(objective, fallbackText)
    && !objective.requiresObservationEvidence
    && !objective.requiresAcceptanceCriteria
    && !objective.evidenceRequirement
    && !objective.acceptanceCriteria?.length
    && !objective.completionCriteria.includes('independent-review-passed');
}

/** Quote accepted context inside the objective's exact transcript window, without changing its contract. */
function objectivePromptAmendments(objective: ActiveSessionObjective, messages?: readonly Message[]): {
  amendments: ActiveSessionObjective['amendments'];
  missingLegacyAnchor?: boolean;
} {
  const amendments = objective.amendments;
  const latestId = objective.lastUserMessageId;
  if (!messages || !latestId || latestId === objective.userMessageId) return { amendments };
  const isAcceptedPublic = (message: Message) => message.role === 'user' && !message.hidden
    && !message.internalOrigin && !message.agentDelivery && !message.isQueued && !message.isPending;
  const roots = messages.filter(message => message.id === objective.userMessageId);
  const matches = messages.filter(message => message.id === latestId);
  const root = roots[0];
  const latest = matches[0];
  if (roots.length !== 1 || matches.length !== 1 || !root || !latest
    || root.role !== 'user' || !isAcceptedPublic(latest)
    || !Number.isFinite(latest.timestamp) || latest.timestamp < objective.startedAt) {
    return { amendments, missingLegacyAnchor: true };
  }
  const rootIndex = messages.indexOf(root);
  const latestIndex = messages.indexOf(latest);
  const accepted = messages.slice(rootIndex + 1, latestIndex + 1).filter(isAcceptedPublic);
  const occurrences = new Map<string, number>();
  for (const message of messages) occurrences.set(message.id, (occurrences.get(message.id) ?? 0) + 1);
  if (latestIndex <= rootIndex || accepted.some(message => startsExplicitNewObjective(message.content)
    || occurrences.get(message.id) !== 1 || !Number.isFinite(message.timestamp) || message.timestamp < objective.startedAt)) {
    return { amendments, missingLegacyAnchor: true };
  }
  const positions = new Map(accepted.map((message, index) => [message.id, index]));
  const projected = [...new Map((amendments ?? []).map(amendment => [amendment.messageId, amendment])).values()];
  // Preserve durable amendments even if their messages were compacted locally.
  // Insert recovered instructions before the next known amendment in journal order.
  for (let index = 0; index < accepted.length; index++) {
    const message = accepted[index]!;
    const current = { messageId: message.id, text: message.content, timestamp: message.timestamp };
    const existing = projected.findIndex(amendment => amendment.messageId === message.id);
    if (existing >= 0) projected[existing] = current;
    else {
      const following = projected.findIndex(amendment => (positions.get(amendment.messageId) ?? -1) > index);
      projected.splice(following < 0 ? projected.length : following, 0, current);
    }
  }
  // Transcript order is authoritative for every available canonical message.
  // Unavailable durable amendments retain their positions relative to each other.
  let canonicalIndex = 0;
  for (let index = 0; index < projected.length; index++) {
    if (!positions.has(projected[index]!.messageId)) continue;
    const message = accepted[canonicalIndex++]!;
    projected[index] = { messageId: message.id, text: message.content, timestamp: message.timestamp };
  }
  return { amendments: projected };
}

export interface ExplicitReadOnlyAuthorityBoundary {
  messageId: string;
  text: string;
  timestamp: number;
}

/**
 * Return the current direct-user boundary only when it both withdraws mutation
 * authority and limits the remaining scope to read-only work. This is narrower
 * than the ordinary execution classifier: it is used as host-owned evidence
 * for an authority handoff after the allowed preflight has actually passed.
 * A later positive mutation instruction always supersedes the boundary.
 */
export function currentExplicitReadOnlyAuthorityBoundary(
  objective: ActiveSessionObjective,
  messages: readonly Message[],
): ExplicitReadOnlyAuthorityBoundary | undefined {
  const rootText = findObjectiveText([...messages], objective);
  if (!rootText?.trim()) return undefined;
  const promptContext = objectivePromptAmendments(objective, messages);
  if (promptContext.missingLegacyAnchor) return undefined;
  const segments: ExplicitReadOnlyAuthorityBoundary[] = [{
    messageId: objective.userMessageId,
    text: rootText,
    timestamp: objective.startedAt,
  }, ...(promptContext.amendments ?? [])];
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    const authorityText = objectiveAmendmentAuthorityText(segment.text);
    if (amendmentEvidenceRequests(authorityText, objective.delegatedRole).execution
      || latestClauseRequestsExecution(authorityText, objective.delegatedRole)) return undefined;
    const normalized = foldForIntent(authorityText).replace(/-/g, ' ').replace(/\s+/g, ' ');
    const readOnlyScope = /\b(?:lecture seule|read only)\b/.test(normalized);
    const exclusiveScope = /\b(?:uniquement|seulement|strictement|exclusivement|only|strictly|exclusively)\b/.test(normalized);
    const preflightScope = /\b(?:preflight|pre flight|controle prealable|verification prealable)\b/.test(normalized);
    const comprehensiveMutationBan = /\b(?:(?:aucune|plus aucune|pas de)\s+(?:mutation|modification|ecriture|execution|operation|action)s?(?:\s+distantes?)?|(?:neffectue|ne\s+(?:fais|realise|execute))\s+(?:aucune|plus aucune)\s+(?:mutation|modification|ecriture|execution|operation|action)s?|no\s+(?:remote\s+)?(?:mutations?|modifications?|writes?|changes?)|(?:do not|dont)\s+(?:modify|change|write)\s+anything)\b/.test(normalized);
    if (readOnlyScope && exclusiveScope && preflightScope && comprehensiveMutationBan
      && explicitlyRevokesExecutionAuthority(authorityText)) return segment;
  }
  return undefined;
}

/** Bounded host-contract segments used to restore high-stakes evidence state.
 * The durable amendment journal remains authoritative across compaction, while
 * available transcript anchors are reconciled by objectivePromptAmendments. */
export function objectiveEvidenceContractSegments(
  messages: Message[],
  objective: ActiveSessionObjective,
): Array<{ messageId: string; text: string }> {
  const root = findObjectiveText(messages, objective);
  if (!root?.trim()) return [];
  const amendments = (objectivePromptAmendments(objective, messages).amendments ?? [])
    .filter(amendment => typeof amendment?.messageId === 'string' && amendment.messageId.length > 0
      && amendment.messageId.length <= 512 && typeof amendment.text === 'string' && amendment.text.trim().length > 0
      && Number.isFinite(amendment.timestamp)
      && amendment.messageId !== objective.terminalReconciliation?.messageId
      && !isExplicitReadOnlyClosureRequest(amendment.text));
  const latestSensitiveIndex = amendments.findLastIndex(amendment => (
    classifyObjectiveRequest(objectiveAmendmentAuthorityText(amendment.text)).sensitiveDomain
  ));
  const latestEvidenceDomainIndex = amendments.findLastIndex(amendment => (
    detectHighStakesEvidenceDomain(objectiveAmendmentAuthorityText(amendment.text)) !== undefined
  ));
  // Keep the full root, a bounded recent amendment window, the latest broad
  // sensitive anchor, and the latest domain the evidence gate can enforce.
  // A later production mutation must not evict an older security amendment.
  const retained = amendments.filter((_, index) => (
    index >= amendments.length - 16 || index === latestSensitiveIndex || index === latestEvidenceDomainIndex
  ));
  return [
    { messageId: objective.userMessageId,
      text: boundedObjectiveRiskText(objectiveAmendmentAuthorityText(root), 8_192) },
    ...retained.map(amendment => ({
      messageId: amendment.messageId,
      text: boundedObjectiveRiskText(objectiveAmendmentAuthorityText(amendment.text), 2_048),
    })),
  ];
}

export function buildObjectiveContractPrompt(
  objective: ActiveSessionObjective,
  messages?: readonly Message[],
  options: { humanInputAllowed?: boolean } = {},
): string {
  const completionObjective = projectLegacyObjectiveCompletionRequirements(
    objective,
    messages ? findObjectiveText([...messages], objective) : undefined,
  );
  const promptContext = objectivePromptAmendments(objective, messages);
  const terminalIndependentReviewer = objective.delegatedRole === 'reviewer'
    || !!objective.originalText
      && isExplicitReadOnlyReview(objectiveAmendmentAuthorityText(objective.originalText))
      && !objectiveRequiresExecutionEvidence(objective);
  // Evidence already checked against the exact native recipe can close that
  // recipe without asking a second model to manufacture a redundant review.
  const nativeEvidence = messages ? [...nativeQuestionCompletionRefs(objective, messages)] : [];
  const nativeCompletionVerified = nativeEvidence.length === 4;
  const terminalReconciliation = !!objective.terminalReconciliation;
  const terminalInitialRegistration = objective.terminalReconciliation
    ?.initialAcceptanceRegistrationRequired === true;
  const terminalInitialRegistrationPending = terminalInitialRegistration
    && completionObjective.requiresAcceptanceCriteria === true
    && (!objective.acceptanceCriteria?.length || objective.acceptanceNeedsReview === true);
  const terminalInitialReviewRequired = terminalInitialRegistration
    && !!objective.acceptanceCriteria?.length
    && objective.acceptanceNeedsReview !== true
    && objective.completionCriteria.includes('independent-review-passed');
  const terminalRegistrationGuidance = terminalInitialRegistrationPending
    ? objective.acceptanceNeedsReview
      ? 'The accepted objective revision predates this read-only closure but its acceptance binding is unresolved: re-register exactly once the complete current-revision contract with set_completion_criteria, using only checks already satisfied by exact persisted read-only observations from before the closure. Do not execute or observe anything to manufacture eligibility; after registration, never replace the contract.'
      : 'This host-owned reconciliation began without registered checks: perform exactly one initial acceptance registration with set_completion_criteria for the unchanged original target, using only checks already satisfied by exact persisted read-only observations from before the closure; after that registration, never replace it.'
    : objective.acceptanceCriteria?.length
      ? 'Do not register or re-register completion criteria.'
      : 'Do not register completion criteria.';
  const terminalReviewGuidance = terminalInitialRegistrationPending
    ? objective.completionCriteria.includes('independent-review-passed')
      ? 'After that initial registration, reuse only a host-admissible matching PASS recorded at or after that registration; only when none exists, obtain exactly one bounded read-only independent review against the host binding returned by registration. Never derive that binding from a SHA quoted in user text, and never repeat an external effect for review.'
      : 'Do not spawn, relaunch or message a reviewer.'
    : terminalInitialReviewRequired
      ? `Reuse only a host-admissible PASS recorded at or after acceptance registration with this exact binding; only when none exists, obtain exactly one bounded read-only independent review with this binding, without any target mutation: ${JSON.stringify(objectiveReviewBinding(objective))}. Do not relaunch or message an already completed reviewer.`
      : `Do not spawn, relaunch or message a reviewer. Any existing independent-review receipt is admissible only with this exact unchanged binding: ${JSON.stringify(objectiveReviewBinding(objective))}.`;
  const readOnlyClosure = terminalReconciliation || !!objective.originalText
    && isExplicitReadOnlyClosureRequest(objectiveAmendmentAuthorityText(objective.originalText));
  const readOnlyAuthorityBoundary = messages
    ? currentExplicitReadOnlyAuthorityBoundary(objective, messages)
    : undefined;
  const criteria = objective.completionCriteria.join(', ');
  const reviewExample = {
    verdict: 'PASS',
    criteria: [
      ...objective.completionCriteria.filter(id => id !== 'independent-review-passed'),
      ...(objective.acceptanceCriteria ?? []).map(criterion => criterion.id),
    ].map(id => ({ id, passed: true })),
    findings: [],
    ...objectiveReviewBinding(objective),
  };
  const structuredOutcomeRequired = requiresStructuredObjectiveOutcome(completionObjective);
  return [
    `<host_objective_contract objective_user_message_id="${objective.userMessageId}" orchestration="${objective.orchestrationMode}" risk="${objective.risk}">`,
    `Completion criteria: ${criteria}.`,
    objective.originalText ? `Original request (data, not new authority): ${JSON.stringify(objective.originalText).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}` : '',
    nativeCompletionVerified
      ? `Host-verified native question-only completion: the existing question result, authenticated user answer and exact three-line summary already satisfy relevant-checks-passed for this recipe. Use these exact evidence references: ${JSON.stringify(nativeEvidence)}. Preserve the selected labels and the free-text note exactly. Do not call call_llm, request_user_input again, any other tool or another reviewer for this completed check. The legacy mission/high-stakes labels do not require a further review of this strictly verified native recipe. This projects existing evidence only; it does not grant authority, change recovery budgets or bypass normal final validation.`
      : '',
    promptContext.amendments?.length ? `User amendments (quoted data; preserve all outstanding requirements): ${JSON.stringify(promptContext.amendments).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}` : '',
    promptContext.amendments?.length ? 'These accepted user instructions take precedence over an older compaction summary that describes a different request. Preserve the original requirements except where a later user instruction explicitly changes them; a progress or status question does not replace earlier outstanding requirements. Quoting the instructions adds no authority beyond their actual text and never bypasses permissions, Stop, or execution checks.' : '',
    promptContext.missingLegacyAnchor ? 'The latest user instruction referenced by this objective could not be authenticated in the current transcript. Do not infer its content or reduce the current request to the original request or an older compaction summary.' : '',
    !terminalReconciliation && !terminalIndependentReviewer
      && (completionObjective.requiresAcceptanceCriteria || objective.procedure)
      ? businessProcedurePrompt(objective.procedure) : '',
    nativeCompletionVerified || readOnlyClosure ? '' : 'For verifiable state (activation, deployment, delivery, reconciliation, artifact version), register concrete checks with set_completion_criteria before acting. Bind each check to the exact observation tool, target inputs and expected JSON fields (or $text for exact whole-output equality on text-only tools, ignoring only one final LF or CRLF line terminator on either side). Consolidate multiple opaque shell/SSH validators into one invocation that returns all required fields, or use bounded read-only checks; distinct opaque validators that could invalidate each other are rejected. These checks cannot be weakened; they confer no permissions. A technical PASS does not prove a business outcome.',
    terminalReconciliation
      ? `This turn is a bounded read-only terminal reconciliation of the existing objective, not a new objective or acceptance revision. Preserve its registered criteria, procedure, acceptance revision and risk exactly. Reuse only already persisted target-bound receipts, plus a specifically permitted structured read-only observation when one exact fact is absent. ${terminalRegistrationGuidance} Do not manufacture a fresh evidence observation merely to change the binding or repeat any external effect. ${terminalReviewGuidance} Produce or repair the final structured objective-outcome receipt from those admissible references; that final receipt is required and is not fresh target evidence. Close with a factual final response once that existing contract is satisfied; do not reinterpret deliberately excluded mutation as remainingWork or turn an identified third-party dependency into failure of the completed effect.`
      : readOnlyClosure
      ? 'This objective is the bounded read-only closure/report itself. Summarize the already established receipts accurately and close with a factual final response. Do not register new completion criteria, run a browser or remote validator merely to manufacture a fresh receipt, reinterpret deliberately excluded deployment or mutation as remainingWork, or declare blocked_human for work this closure explicitly leaves out of scope. Perform only a specifically permitted local or structured read-only observation when one precise fact is actually absent.'
      : '',
    completionObjective.requiresAcceptanceCriteria || objective.acceptanceCriteria?.length ? 'The host requires at least one registered target-bound acceptance check before it can accept complete_verified. Register the checks before implementation, then inspect the actual resulting target. Include all registered check IDs in the final receipt. Prefer actual toolUseId or message IDs; tool:<exact tool name> is accepted only when the host can resolve it to one exact, unambiguous observation for that registered check.' : '',
    !terminalReconciliation && !terminalIndependentReviewer && !nativeCompletionVerified
      && (completionObjective.requiresAcceptanceCriteria || objective.acceptanceCriteria?.length)
      ? 'Before declaring completion, call get_session_info once for this session and consult objectiveEvidenceContext for the current persisted observation message IDs. Cite each passed target-bound observation for its registered criterion and an appropriate observed check for relevant-checks-passed. The metadata response itself is not proof. A reviewer finalMessageId proves only the bound independent review, not the parent’s business observations. Do not inspect session storage or repeat completed work merely to discover evidence IDs.' : '',
    !terminalReconciliation && objective.acceptanceNeedsReview ? 'The user amended this objective. Re-register the complete acceptance contract for the updated request, then obtain fresh observations and a review bound to the new contract. Preserve completed work; never repeat an external action solely to refresh evidence.' : '',
    objective.acceptanceCriteria?.length ? `Registered checks: ${JSON.stringify(objective.acceptanceCriteria)}` : '',
    'Continue through every safe in-scope step. A progress report, proposed next action, or partially created deliverable is not a terminal result.',
    options.humanInputAllowed === false
      ? 'For an outgoing message requested by the accepted objective, resolve the audience and complete content from verified context, run the non-sending preflight, transmit the target-bound action, then verify its external receipt. In YOLO, resolve missing details autonomously; if the target cannot be established, finish independent work and report the exact unresolved dependency without a question. A draft-only objective never authorizes transmission. Do not send incomplete content, broaden the audience, fabricate access, or replay an uncertain effect.'
      : 'For an outgoing message explicitly requested by the authenticated user objective, resolve the exact audience and content from the objective and verified context, compose the message internally, run the connector non-sending preflight, then transmit through its target-bound action without a separate user review. Do not ask to reconfirm recipients, thread IDs, attachments or content already established. If the objective is only to analyze or prepare a draft, do not transmit. If the exact audience, required content or authority to transmit genuinely remains unresolved, ask once for that missing decision. For an existing-thread Gmail reply, use the signed Gmail preflight and bound reply; do not ask the user to confirm an internal Gmail message ID already bound by a host-observed read and signed preflight. Before transmitting, verify every key requirement, target, attachment, technical access and deliverable in the original request. Never send incomplete content or change the authorized audience. Provider consent, MFA and host permission dialogs remain authoritative when actually required.',
    'For technical handovers, migration access, credential inventories, hosting (cPanel, DNS, servers, databases), or third-party service audits, execute a systematic multi-query investigation across all available organizational tools (e.g. drive_search, gmail_search, notes_list, local files) using varied technical keywords (accès, mot de passe, passation, handover, hébergement, cpanel, dns, identifiants). Never conclude that an item is missing or demand external credential resets based on a single failed search. When information is genuinely absent after exhaustive search, provide a structured search ledger listing the specific queries, directories, and documents verified.',
    'An authorization flow that was only started or is waiting for a human callback is not a connected integration. Claim connection only after the callback/poll reports the target connected state and a fresh target-bound read confirms it.',
    PROGRESS_GUIDANCE,
    options.humanInputAllowed === false ? YOLO_AUTONOMY_GUIDANCE
      : nativeCompletionVerified || terminalReconciliation ? '' : 'Use request_user_input when missing context or a user preference materially changes the work: ask a few short questions with useful choices (multiple selection only when needed); the user can always enter a free-text answer. When an exact target, project, environment, path, or one of a few mutually exclusive scopes is genuinely missing, finish independent safe work first, then ask exactly one short structured question naming the concrete choices. Do not guess a default, convert a hostname into a user choice, or end with prose asking the same question. Continue independent work while the request is pending, then wait if the remaining work depends on it. Do not repeat the question, poll for an answer, select a default for the user, or replace execution permission and credential dialogs with this tool. An Objective authority refusal is not policy-blocker evidence: correct the target/authority interpretation from the authenticated objective, or use the one structured question only when a material user decision is truly absent. When an exact sensitive external action is prepared and only its requested confirmation remains, invoke that exact tool once so the host can present its scoped permission dialog; never ask for that approval with request_user_input or final prose. Incorporate ordinary replies into the current objective without discarding prior requirements or claiming that asking a question completed the task.',
    nativeCompletionVerified || terminalReconciliation ? '' : 'A credential, endpoint, key, access grant, or vendor response already proven to be pending from an identified third party is not a missing user choice. Finish all independent safe work, do not call request_user_input merely to ask whether to wait or who should provide the same item, and report the exact external dependency with its evidence. Keep an already authorized monitor or scheduled follow-up active when available.',
    FINAL_RESPONSE_GUIDANCE,
    'Before ending, evaluate the objective as exactly one of: complete_verified, blocked_human, blocked_policy, continue.',
    'Use complete_verified only after the requested outcome exists, relevant checks passed, and no safe in-scope work remains. Use blocked_human only for a concrete credential, MFA, external authorization, or genuinely missing user decision.',
    readOnlyAuthorityBoundary && readOnlyAuthorityBoundary.messageId !== objective.userMessageId
      ? 'When the latest authenticated user instruction strictly limits the scope to read-only work and explicitly withholds every mutation or deployment, finish all registered target-bound preflight checks first. Only then may blocked_human with kind external_authorization cite that exact user message ID. Never use this handoff after a mutation in the read-only phase or while another safe check remains; an earlier mutation still requires fresh post-boundary checks.'
      : '',
    'A build, deployment pipeline, synchronization, import/export job or other observable automated process is not a human blocker: use continue with a concrete bounded status check and final verification, then keep working from that checkpoint.',
    !nativeCompletionVerified && !terminalReconciliation
      && objective.orchestrationMode === 'mission' && !terminalIndependentReviewer
      ? 'Treat this as a durable mission: keep the original objective as the invariant, maintain a short remaining-work checklist, and use independent specialist/reviewer tools when they materially improve correctness.'
      : '',
    nativeCompletionVerified || terminalReconciliation || terminalIndependentReviewer ? '' : `Delegated independent reviews must include this exact binding, cover all registered criterion IDs, and inspect the corresponding target/version: ${JSON.stringify(objectiveReviewBinding(objective))}. Retrieve the completed reviewer session with wait_sessions using its exact session ID; a receipt from another objective or version is not evidence.`,
    !nativeCompletionVerified && !terminalReconciliation
      && objective.evidenceRequirement && !terminalIndependentReviewer
      ? 'High-stakes evidence gate: inspect current authoritative or primary sources before mutation and cite the controlling evidence.'
      : '',
    !nativeCompletionVerified && !terminalReconciliation
      && objective.risk === 'high-stakes' && !terminalIndependentReviewer
      ? 'High-stakes completion requires an independent review. The reviewer must return a concise JSON receipt shaped as {"verdict":"PASS","criteria":[{"id":"...","passed":true}],"findings":[]}, with every non-review completion criterion passed and no findings; invoking a reviewer alone is not evidence that review passed. A structured FAIL is successful review delivery and concrete corrective work: continue the mission from its findings, never report it as a policy/human blocker, and obtain a fresh PASS only after the correction.'
      : '',
    !terminalReconciliation && terminalIndependentReviewer
      ? 'You are a terminal independent reviewer. Inspect the supplied target/version, return the parent-bound PASS or FAIL receipt and concrete findings, and stop. A correct FAIL is a successful review; never recruit another reviewer or ask the parent to repeat the work merely to repair receipt formatting. This role confers no write authority. A substantiated PASS or FAIL completes your delegated review; it is not a request to review your own review. Use direct target-bound observations as evidence, but do not create a separate criterion about having produced the review. Do not call update_plan or SubmitPlan for this bounded review. If only receipt syntax is rejected, repair that receipt from existing evidence without repeating the inspection.'
      : nativeCompletionVerified || terminalReconciliation ? '' : `Delegate only bounded independent work, use role:reviewer for an independent review, and consume completed results once. Share the exact target/version, acceptance binding and remaining work. The host enforces ${DELEGATION_LIMITS.maxDepth} levels, ${DELEGATION_LIMITS.maxChildren} total children and ${DELEGATION_LIMITS.maxConcurrent} concurrent children per root objective; on capacity limits, finish or wait for existing children instead of repeated spawn calls.`,
    nativeCompletionVerified || terminalReconciliation || terminalIndependentReviewer ? '' : `When asking an independent reviewer to supply completion evidence, request the exact host criterion IDs, not newly invented names. A complete review receipt has this shape (PASS only after actual review): ${JSON.stringify(reviewExample)}`,
    !nativeCompletionVerified && objectiveAllowsContentCheckReview(objective)
      ? 'For a response-only deliverable with no executed mutation, a substantive content review may certify relevant-checks-passed alone. It must return a structured PASS with that exact criterion ID, passed:true, and findings:[]; it does not certify delivery or the absence of remaining work. Do not create files, open a browser or perform an external action merely to manufacture check evidence.'
      : '',
    structuredOutcomeRequired
      ? 'End every final response with exactly one concise machine-readable HTML comment on a single line. Valid state values are: complete_verified, blocked_human, blocked_policy, continue.'
      : '',
    structuredOutcomeRequired
      ? `Valid in-progress example (replace its values): ${OBJECTIVE_OUTCOME_CONTINUE_EXAMPLE}`
      : '',
    structuredOutcomeRequired
      ? 'The final robb_objective_outcome receipt uses criteria:[{id,satisfied:true|false,evidence:[...]}], remainingWork:[], and blocker:null when no blocker exists. This is different from an independent reviewer receipt using verdict/criteria[].passed/findings. Allowed blocker.kind values are exactly credential, mfa, external_authorization, irreversible_authority, business_decision, policy; a kind still requires matching observed evidence. If the host reports a receipt format error, repair only the receipt against existing evidence, never repeat an external action to repair formatting.'
      : '',
    nativeCompletionVerified
      ? 'For this native recipe, cite the host-verified references listed above for relevant-checks-passed. Use assistant-final only for requested-outcome-delivered or no-safe-work-remaining.'
      : structuredOutcomeRequired
      ? 'For evidence references, prefer toolUseId values from successful tool results. Use tool:<exact tool name> only when exactly one host-observed invocation qualifies for that criterion; registered target-bound checks must also match its exact target and expected result. Only the native Bash, bash and functions.bash spellings alias each other; other tool names, including MCP names, are exact and case-sensitive. A blocker tool alias likewise requires exactly one host-observed failure of that exact tool and declared blocker type. Use assistant-final only for requested-outcome-delivered or no-safe-work-remaining. The host rejects invented references.'
      : '',
    nativeCompletionVerified
      ? 'complete_verified still requires all three completion criteria, satisfied:true, and valid evidence. The native references check only the exact requested summary; they do not prove any other deliverable or action.'
      : structuredOutcomeRequired
      ? 'complete_verified requires every completion criterion to be present, satisfied:true, and backed by non-empty valid evidence. relevant-checks-passed must reference a substantive observation or validation executed after the latest mutation. For blocked_human or blocked_policy, blocker must be an object with kind, description, and evidence:["toolUseId/messageId or one exact host-resolved tool alias"]; a blocker without matching structured evidence is invalid. For continue, list concrete remainingWork.'
      : '',
    '</host_objective_contract>',
  ].filter(Boolean).join('\n');
}
