import { hasNonAuthoritativeStructuredLead } from './instruction-clause-syntax.ts';
import { foldForIntent } from './types.ts';

export const MULTI_STEP_PATTERN = /\b(?:puis|ensuite|et\s+(?:v[ée]rifie|teste|corrige|impl[ée]mente|d[ée]ploie)|tous\s+les\s+points|l['’]ensemble\s+de\s+ces\s+points|de\s+bout\s+en\s+bout|end[- ]to[- ]end|multi[- ]?[ée]tapes?)\b/i;

export const OBSERVATION_REQUEST_PATTERN = /\b(?:inspect\w*|audit\w*|v[ée]rifi\w*|contr[oô]l\w*|check|verify)\b/i;

// An amendment can contain exclusions and historical descriptions. Only a
// positive request adds work; words inside "ne modifie rien" are not a write.
export const AMENDMENT_REQUEST_PREFIX = String.raw`(?:^|[.!?;:\n,]|\b(?:et|puis|ensuite|mais|and|then|but)\s+)\s*(?:(?:\d+[.)]|[-*+])\s*)?(?:(?:maintenant|aussi|now|also)\s+)?(?:(?:merci de|please|tu dois|tu peux|vous devez|vous pouvez|peux-tu|pouvez-vous|can you|could you|je veux(?: que tu)?|je souhaite(?: que tu)?|il faut(?: que tu)?|j['’]ai besoin de)\s+)?`;

export const AMENDMENT_OBSERVATION_REQUEST = new RegExp(AMENDMENT_REQUEST_PREFIX + String.raw`(?:inspect(?:e|er|ez)?|audit(?:e|er|ez)?|verifi(?:e|er|ez)|control(?:e|er|ez)|check|verify)\b`, 'i');

// A new artifact may be a correction inside the current mission. Only a direct
// declaration or instruction changing the mission can discard its contract.
// Anchoring also excludes mentions such as "ne change pas de sujet".
export const EXPLICIT_NEW_OBJECTIVE_PATTERNS = [
  /^(?:(?:je\s+(?:veux|souhaite)|jai)\s+)?(?:(?:un|une)\s+)?(?:nouvel(?:le)?|nouveau|autre|different(?:e)?)\s+(?:objectif|mission|tache|demande|sujet|projet)\b/i,
  /^(?:(?:i\s+(?:want|have|need))\s+)?(?:a\s+)?(?:new|another|different)\s+(?:objective|mission|task|request|topic|project)\b/i,
  /^(?:changeons|changez?|passons?)\s+(?:de\s+|d)(?:sujet|objectif|mission|tache)\b/i,
  /^passons?\s+(?:a|sur)\s+(?:(?:un|une)\s+)?(?:nouvel(?:le)?|nouveau|autre)\s+(?:objectif|mission|tache|sujet|projet)\b/i,
  /^(?:switch|move)\s+to\s+(?:a\s+)?(?:new|another|different)\s+(?:objective|mission|task|topic|project)\b/i,
  /^(?:abandonne|annule|oublie|arrete|stoppe)\s+(?:(?:cet?|cette|la|le|notre)\s+|l)?(?:objectif|mission|tache|demande|travail)\b/i,
  /^(?:abandon|cancel|forget|stop)\s+(?:(?:this|the|current|previous)\s+)*(?:objective|mission|task|request)\b/i,
];

export const CONTINUATION_FILLER_PATTERN = /^(?:(?:bah|ben|bon|alors|donc|non|ok|okay|oui|yes|daccord|vas\s+y|allez\s+y)\s+)*(?:et\s+)?(.+)$/i;

export const CONTINUATION_REFERENCE_PATTERN = /(?:\b(?:encore|aussi|precedent|precedente|above|again|remaining|restant\w*)\b|\b(?:la\s+suite|le\s+reste)\b)/i;

export const CONTINUATION_REOPEN_PATTERN = /(?:\b(?:pas|not)\s+(?:termine|fini|fait|complet|verified|done|finished|exhausti(?:f|ve))\b|\b(?:il\s+manque|tu\s+nas\s+pas|tu\s+as\s+(?:oublie|omis|zappe|saute)|ca\s+ne\s+(?:marche|fonctionne)\s+pas|keep\s+going|carry\s+on|ou\s+sont\s+(?:les|l)|where\s+are\s+the)\b|\b(?:avec\s+precision|plus\s+de\s+precision|plus\s+precisement|sois\s+plus\s+precis|soyez\s+plus\s+precis|precise(?:z)?|detaille(?:z)?|plus\s+de\s+details?|approfondi[sz]?|incomplet|incomplete|insuffisant|insuffisante|exhausti(?:f|ve)|inexhausti(?:f|ve)|creuse(?:z)?|va\s+plus\s+loin|allez\s+plus\s+loin|dig\s+deeper)\b|\b(?:ce\s+n\s*est\s+pas|c\s*est\s+(?:pas\s+)?)\s*(?:complet|suffisant|assez|precis|incomplet|insuffisant|exhausti(?:f|ve))\b|\b(?:trop\s+(?:court|bref|breve|sommaire|superficiel(?:le)?|succinct(?:e)?|leger|legere)|too\s+(?:shallow|brief|short|superficial))\b|\b(?:more\s+precis\w*|be\s+more\s+precise|more\s+details?|in-?depth|incomplete|insufficient|not\s+enough|not\s+complete|not\s+exhaustive|missing\s+\w+)\b)/i;

const PRECISION_OR_COMPLETENESS_CHALLENGE_PATTERN = /(?:(?:^|[\s,;:.!?-])(?:avec\s+pr[ée]cision|plus\s+de\s+pr[ée]cision|plus\s+pr[ée]cis[ée]ment|sois\s+plus\s+pr[ée]cis|soyez\s+plus\s+pr[ée]cis|pr[ée]cise(?:z)?|d[ée]taille(?:z)?|plus\s+de\s+d[ée]tails?|approfondi[sz]?|incomplet|incompl[èe]te|insuffisant|insuffisante|exhausti(?:f|ve)s?|inexhausti(?:f|ve)s?|creuse(?:z)?|va\s+plus\s+loin|allez\s+plus\s+loin)(?:\b|[\s,;:.!?-]|$)|(?:ce\s+n['’]est\s+pas|c['’]est\s+(?:pas\s+)?)\s*(?:complet|suffisant|assez|pr[ée]cis|incomplet|insuffisant|exhausti(?:f|ve)s?)(?:\b|[\s,;:.!?-]|$)|(?:pas\s+(?:assez\s+)?|non\s+)(?:exhausti(?:f|ve)s?|complet|pr[ée]cis|suffisant)(?:\b|[\s,;:.!?-]|$)|(?:trop\s+(?:court|bref|br[èe]ve|sommaire|superficiel(?:le)?|succinct(?:e)?|l[ée]ger|l[ée]g[èe]re)|too\s+(?:shallow|brief|short|superficial))(?:\b|[\s,;:.!?-]|$)|(?:il\s+(?:n['’]y\s+a\s+pas|manque)|tu\s+(?:n['’]as\s+pas|as\s+oubli[ée]|as\s+omis|as\s+zapp[ée]|as\s+saut[ée])|(?:o[ùu]|ou)\s+sont\s+(?:les|l['’]))(?:\b|[\s,;:.!?-]|$)|(?:more\s+precis\w*|be\s+more\s+precise|more\s+details?|in-?depth|incomplete|insufficient|not\s+enough|not\s+complete|not\s+exhaustive|dig\s+deeper|where\s+are\s+the|missing\s+\w+)\b)/i;

export function isPrecisionOrCompletenessChallenge(text: string): boolean {
  if (hasNonAuthoritativeStructuredLead(text)) return false;
  const normalized = text.trim();
  if (normalized.length > 500) return false;
  return PRECISION_OR_COMPLETENESS_CHALLENGE_PATTERN.test(normalized);
}

export const CONTINUATION_VERBS = [
  'avance', 'continue', 'continuer', 'poursuis', 'poursuit', 'poursuivre',
  'reprend', 'reprends', 'reprendre',
] as const;

/** A terse correction of the execution channel steers an active or incomplete
 * accepted mission. It is deliberately insufficient to reopen a verified
 * mission: doing so would recover the old target and mutation authority from a
 * channel-only sentence and could repeat an already verified side effect. */
export function isExecutionChannelCorrection(text: string): boolean {
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

export const OBSERVATION_TARGET_KEY_PATTERN = /^(?:action|cmd|command|file|file_path|filename|id|key|operation|path|pattern|q|query|ref_id|resource|search|search_query|sessionId|target|threadId|uri|url)$/i;

export const MUTATION_TRANSFORM_KEY_PATTERN = /^(?:body|content|data|diff|edits|new_string|newText|old_string|oldText|patch|payload|replacement|text|value)$/i;

export const PASSIVE_NO_PROGRESS_TOOL_PATTERN = /(?:^|[_:\-.])(?:wait|sleep|reload|refresh)(?:$|[_:\-.])/i;

export const PASSIVE_NO_PROGRESS_ACTION_PATTERN = /^(?:wait|sleep|poll|reload|refresh)(?:\b|_)/i;

export const NON_EXECUTED_CHECKPOINT_PATTERN = /(?:\bcost guard(?: checkpoint)?\s*:|\bwas not started\b|\btool-call (?:budget|checkpoint)\b.{0,120}\b(?:blocked|not (?:started|executed))\b)/i;

export const NON_SUBSTANTIVE_TOOL_RESULT_PATTERN = /^(?:\[?auto[- ]?completed\]?|completed automatically|tool completed|completed|done|ok|success)$/i;

export const GENERIC_EXECUTE_TOOL_PATTERN = /(?:^|[_:\-.])(?:exec|execute)(?:$|[_:\-.])/i;

export const SESSION_COORDINATION_TOOL_PATTERN = /^(?:mcp__session__|session__|functions\.)?(?:send_agent_message|request_user_input|get_session_info)$/;

export const PLAN_TRACKING_TOOL_PATTERN = /^(?:functions\.|mcp__session__|session__)?(?:update_plan|TodoWrite|todo_write)$/;

// This exact first-party operation is a non-executing dry run despite the
// mutation verb in its name. Keep the exception closed to the connector tool
// already admitted as a read by the shared permission classifier; lookalike
// providers and compound preflight-and-send names remain mutations/unknowns.
export const OBJECTIVE_NON_EXECUTING_PREFLIGHT_TOOLS = new Set([
  'mcp__google-contacts__gmail_send_preflight',
]);

export const MUTATION_HTTP_METHOD_PATTERN = /^(?:DELETE|PATCH|POST|PUT)$/i;

export const POSITIVE_MUTATION_HTTP_METHOD_PATTERN = /^(?:DELETE|PATCH|PUT)$/i;

export const POSITIVE_HTTP_POST_TARGET_TOKENS = new Set([
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

export const MUTATION_SQL_PATTERN = /^\s*(?:ALTER|CALL|COPY|CREATE|DELETE|DO|DROP|EXEC(?:UTE)?|GRANT|INSERT|MERGE|REPLACE|REVOKE|TRUNCATE|UPDATE|UPSERT|VACUUM)\b/i;

export const MAX_CANONICAL_INPUT_CHARS = 4_096;

export const MAX_RESULT_DIGEST_CHARS = 16_384;

export const MAX_TRANSFORM_DIGEST_CHARS = 16_384;

export const OBJECTIVE_OUTCOME_CONTINUE_EXAMPLE =
  '<!-- robb_objective_outcome {"state":"continue","criteria":[],"remainingWork":["describe the next concrete step"],"blocker":null} -->';
