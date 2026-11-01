import { hasNonAuthoritativeStructuredLead } from './instruction-clause-syntax.ts';
import { hasDirectObjectiveArtifactMutation } from './request-intent.ts';
import { foldForIntent } from './types.ts';

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
export function isLiteralQuestionAnswerScript(normalized: string): boolean {
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

export function normalizedQuestionAnswerRequest(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, "'").replace(/[“”]/g, '"').trim().toLowerCase()
    .replace(/^(?:test|essai|controle|verification)\s+(?:(?:local|simple|rapide)\s+)?(?:des?\s+|de la\s+|du\s+)(?:questions?|preferences?|conversation|clarification)\s*:\s*/, '');
}

export function parseBoundedQuestionAnswerEnvelope(normalized: string): BoundedQuestionAnswerEnvelope | undefined {
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

export function hasBoundedQuestionAnswerEnvelope(text: string): boolean {
  if (text.length > 1_200) return false;
  const normalized = normalizedQuestionAnswerRequest(text);
  return isLiteralQuestionAnswerScript(normalized)
    || parseBoundedQuestionAnswerEnvelope(normalized) !== undefined;
}
