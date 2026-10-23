import type { Message } from '@craft-agent/core/types';

export type LatestTurnTerminalState =
  | 'final-assistant'
  | 'premature-final-assistant'
  | 'error'
  | 'incomplete'
  | 'no-user';

export type ObjectiveTerminalState =
  | 'complete_verified'
  | 'blocked_human'
  | 'blocked_policy'
  | 'continue';

/** Fold existing plan events; dropping a pending step is not completing it. */
export function incompletePlanSteps(messages: readonly Message[], objectiveUserMessageId?: string): string[] {
  const start = objectiveUserMessageId
    ? messages.findIndex(message => message.role === 'user' && message.id === objectiveUserMessageId)
    : messages.findLastIndex(message => message.role === 'user' && !message.hidden && !message.internalOrigin);
  if (start < 0) return [];
  const pending = new Map<string, string>();
  for (let index = start + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== 'tool' || message.toolStatus !== 'completed' || message.toolExecuted === false) continue;
    const name = message.toolName;
    const nativeTodo = name === 'TodoWrite';
    if (!nativeTodo && name !== 'update_plan' && name !== 'mcp__session__update_plan' && name !== 'session__update_plan') continue;
    const items: unknown = message.toolInput?.[nativeTodo ? 'todos' : 'plan'];
    if (!Array.isArray(items)) continue;
    const steps: Array<{ text: string; status: string }> = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') break;
      const value = item as Record<string, unknown>;
      const text = value[nativeTodo ? 'content' : 'step'];
      if (typeof text !== 'string' || !text.trim()
        || !['pending', 'in_progress', 'completed'].includes(String(value.status))) break;
      steps.push({ text: text.trim(), status: String(value.status) });
    }
    if (steps.length !== items.length) continue;
    for (const step of steps) {
      const key = step.text.replace(/\s+/g, ' ');
      if (step.status === 'completed') pending.delete(key);
      else pending.set(key, step.text);
    }
  }
  return [...pending.values()];
}

const UNFINISHED_ACTION_PATTERNS = [
  /\b(?:je\s+(?:vais\s+)?(?:(?:maintenant|donc|d['’]abord|ensuite|aussi|[àa]\s+pr[ée]sent)\s+)?(?:v[ée]rifier|lancer|relancer|ex[ée]cuter|impl[ée]menter|corriger|modifier|cr[ée]er|g[ée]n[ée]rer|tester|analyser|auditer|chercher|contr[oô]ler|ouvrir|fermer|d[ée]ployer|remplacer|copier|soumettre|pousser|charger|lire|relire|poursuivre|continuer|commencer|poursuis|continue|commence)|j['’](?:ouvre|[ée]cris|analyse|ex[ée]cute|impl[ée]mente)|i\s+(?:will|am\s+going\s+to)\s+(?:now\s+)?(?:check|verify|run|rerun|implement|fix|change|create|generate|test|analyze|audit|search|open|close|deploy|continue|resume)|i['’]ll\s+(?:now\s+)?(?:check|verify|run|rerun|implement|fix|change|create|generate|test|analyze|audit|search|open|close|deploy|continue|resume))\b/i,
  /\bje\s+(?:poursuivrai|continuerai|reprendrai|relancerai|v[ée]rifierai|terminerai)\b/i,
  /\bje\s+(?:v[ée]rifie|lance|relance|ex[ée]cute|impl[ée]mente|corrige|modifie|cr[ée]e|g[ée]n[èe]re|teste|analyse|audite|cherche|contr[oô]le|ouvre|ferme|d[ée]ploie|remplace|copie|soumets|pousse|charge|lis|relis|poursuis|continue|commence)(?:\s+(?:maintenant|d['’]abord|ensuite|aussi))?\b/i,
  /(?:au\s+prochain\s+tour|dans\s+un\s+nouveau\s+tour|next\s+turn|new\s+turn).{0,120}(?:poursuiv|continu|reprendr|relanc|v[ée]rifi|termin|resume)/i,
];

const RECOVERABLE_TECHNICAL_CHECKPOINT_PATTERNS = [
  /\b(?:[ée]tat\s+interm[ée]diaire|point\s+d['’][ée]tape)\b.{0,900}\b(?:reste(?:nt)?\s+[àa]|pas\s+(?:encore\s+)?termin[ée]|[ée]tape(?:s)?\s+restante(?:s)?|prochaine\s+action)\b/i,
  /\b(?:travail|t[âa]che|objectif|mise\s+en\s+[œo]uvre|impl[ée]mentation)\b.{0,100}(?:engag[ée]e?\s+mais\s+pas\s+termin[ée]e?|(?:n['’]est\s+)?pas\s+encore\s+(?:d[ée]clar[ée]e?\s+)?termin[ée]e?|incomplet(?:e)?)(?=\s|[.,;:!?]|$)/i,
  /(?:reste(?:nt)?\s+[àa]\s+(?:faire|ex[ée]cuter|installer|impl[ée]menter|corriger|tester|v[ée]rifier|d[ée]ployer|publier|livrer|finaliser)|[ée]tape(?:s)?\s+restante(?:s)?|prochaine\s+action\s+(?:automatique|technique))(?=\s|[.,;:!?]|$)/i,
  /(?:le|un)\s+prochain\s+correctif\s+(?:doit|devra|consiste|portera)\b/i,
  /\b(?:je\s+n['’]ai\s+pas|nous\s+n['’]avons\s+pas)\s+(?:encore\s+)?(?:appliqu[ée]|impl[ée]ment[ée]|tent[ée]|test[ée])\s+(?:de\s+|la\s+|le\s+|un\s+|une\s+)?(?:correction|correctif|solution|alternative)\b/i,
  /\b(?:aucun|aucune)\s+(?:test|validation|v[ée]rification|d[ée]ploiement|d[ée]p[oô]t|mutation).{0,100}\bn['’]a\s+(?:donc\s+)?pu\s+[êe]tre\s+(?:ex[ée]cut[ée]|effectu[ée]|valid[ée]|termin[ée])(?=\s|[.,;:!?]|$)/i,
  /\b(?:la\s+suite|l['’][ée]tape\s+suivante)\s+(?:concerne|consiste|sera|doit|devra)\b/i,
];

const HUMAN_HANDOFF_PATTERN = /\b(?:connecte(?:-toi|z-vous)?|authentifie(?:-toi|z-vous)?|clique(?:z)?|valide(?:z)?|saisis(?:sez)?|renseigne(?:r|z)?|r[ée]ponds|dites?-moi|dis-moi|quand\s+(?:tu|vous)|merci\s+de|peux-tu|pouvez-vous|il\s+me\s+manque\s+(?:seulement\s+|ton|ta|votre|un\s+choix|une\s+d[ée]cision|une\s+autorisation|un\s+identifiant|un\s+secret)|j['’]ai\s+besoin\s+(?:de\s+ton|de\s+ta|de\s+votre|d['’]un\s+choix|d['’]une\s+d[ée]cision|d['’]une\s+autorisation|d['’]un\s+identifiant|d['’]un\s+secret)|(?:action|intervention|validation|confirmation|d[ée]cision|autorisation)\s+humaine|j['’]attends\s+(?:ta|votre)\s+(?:r[ée]ponse|validation|confirmation|d[ée]cision|autorisation)|please\s+(?:sign\s+in|log\s+in|click|confirm|enter|reply)|tell\s+me|once\s+you|waiting\s+for\s+you)\b/i;
const PROVEN_HUMAN_BLOCKER_PATTERN = /\b(?:oauth|mfa|2fa|authentification\s+[àa]\s+deux\s+facteurs|(?:code\s+(?:de\s+)?(?:validation|s[ée]curit[ée])|mot\s+de\s+passe|password|api[-_ ]?key|cl[ée]\s+api|secret|credentials?|identifiant)\s+(?:manquant|requis|n[ée]cessaire|absent|invalide|expir[ée]|missing|required|needed|invalid|expired)|(?:manque|besoin|exige|requiert|requires?|needs?)\s+(?:d['’])?(?:un\s+|une\s+|le\s+|la\s+|des?\s+)?(?:code\s+(?:de\s+)?(?:validation|s[ée]curit[ée])|mot\s+de\s+passe|password|api[-_ ]?key|cl[ée]\s+api|secret|credentials?|identifiant)|connecte(?:-toi|z-vous)?|authentifie(?:-toi|z-vous)?|sign\s+in|log\s+in|d[ée]cision\s+m[ée]tier|business\s+decision|choix\s+m[ée]tier|autorisation\s+(?:externe|humaine|irr[ée]versible)|external\s+authorization)\b/i;
const POLICY_BLOCKER_PATTERN = /\b(?:(?:politique|policy|r[èe]gle|permission|mode\s+lecture\s+seule|read[- ]only|sandbox)\b.{0,120}\b(?:interdit|bloqu[ée]|refus[ée]|n['’]autorise\s+pas|forbids?|blocked|denied)|(?:interdit|bloqu[ée]|refus[ée]|forbidden|blocked|denied)\b.{0,120}\b(?:politique|policy|permission|sandbox)|(?:l['’]application|l['’]h[ôo]te|le\s+connecteur|le\s+relais)\s+(?:actuel\s+)?(?:bloque|refuse|interdit|impose\s+la\s+lecture\s+seule)|(?:r[ée]ponse|message|mail|courriel|envoi)\s+pr[ée]par[ée]e?,?\s+mais\s+non\s+envoy[ée]e?|(?:le\s+nettoyage|l['’]op[ée]ration|l['’]envoi|la\s+suppression|la\s+modification)\s+reste\s+bloqu[ée]e?)\b/i;

const CONDITIONAL_POLITE_OFFER_PATTERN = /\b(?:si\s+(?:vous|tu)\s+(?:le\s+)?(?:souhait(?:ez|es?)|voulez|veux|avez\s+besoin|as\s+besoin)|au\s+besoin|n['’]h[ée]site(?:z)?\s+pas|le\s+cas\s+[ée]ch[ée]ant|sur\s+demande|je\s+reste\s+(?:[àa]\s+disposition|disponible)|if\s+you\s+(?:want|need|wish)|let\s+me\s+know\s+if|feel\s+free\s+to)\b/i;

/**
 * Detect a provider "final" that is actually only a progress update followed
 * by a concrete promise to keep working. Keep this deliberately narrow: an
 * explicit human handoff remains a legitimate terminal outcome.
 */
export function looksLikePrematureFinalAssistant(content: string): boolean {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  // Only the tail decides whether the response actually ended with pending
  // work. This avoids matching an opening "I will..." followed by a complete
  // report in the same message.
  const actionTail = normalized.slice(-700);
  const checkpointTail = normalized.slice(-1_800);

  // If the tail ends with a polite closing or conditional offer, strip that offer
  // before checking for unfinished actions so an offer to help does not reject a completed turn.
  const politeMatch = CONDITIONAL_POLITE_OFFER_PATTERN.exec(actionTail);
  const effectiveActionTail = politeMatch && politeMatch.index > 0
    ? actionTail.slice(0, politeMatch.index).trim()
    : actionTail;

  const unfinishedAction = UNFINISHED_ACTION_PATTERNS.some(pattern => pattern.test(effectiveActionTail));
  const recoverableCheckpoint = RECOVERABLE_TECHNICAL_CHECKPOINT_PATTERNS
    .some(pattern => pattern.test(checkpointTail));
  if (recoverableCheckpoint) {
    const provenHumanBlocker = PROVEN_HUMAN_BLOCKER_PATTERN.test(checkpointTail)
      && HUMAN_HANDOFF_PATTERN.test(checkpointTail);
    return !provenHumanBlocker;
  }
  return unfinishedAction && !HUMAN_HANDOFF_PATTERN.test(checkpointTail);
}

/** Host-side terminal evaluator used by the durable objective lifecycle. */
export function classifyObjectiveTerminalState(
  content: string,
  options: {
    evidenceGap?: string;
    executionEvidenceMissing?: boolean;
    structuredOutcomeRequired?: boolean;
    structuredOutcomeValid?: boolean;
    declaredState?: ObjectiveTerminalState;
    remainingPlanSteps?: readonly string[];
  } = {},
): ObjectiveTerminalState {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'continue';
  if (options.declaredState) {
    if (options.structuredOutcomeValid !== true) return 'continue';
    if (options.declaredState === 'continue') return 'continue';
    if (options.declaredState === 'complete_verified'
      && (options.evidenceGap || options.executionEvidenceMissing || options.remainingPlanSteps?.length)) return 'continue';
    return options.declaredState;
  }
  if (looksLikePrematureFinalAssistant(normalized)) return 'continue';
  if (options.structuredOutcomeRequired) return 'continue';
  if (PROVEN_HUMAN_BLOCKER_PATTERN.test(normalized) && HUMAN_HANDOFF_PATTERN.test(normalized)) {
    return 'blocked_human';
  }
  if (POLICY_BLOCKER_PATTERN.test(normalized)) return 'blocked_policy';
  if (options.evidenceGap || options.executionEvidenceMissing || options.remainingPlanSteps?.length) return 'continue';
  return 'complete_verified';
}

/**
 * Classify whether the latest user turn has a user-visible terminal outcome.
 * Intermediate commentary and tool results are progress, not a final answer.
 */
export function classifyLatestTurnTerminalState(
  messages: Message[],
  userMessageId?: string,
  remainingPlanSteps: readonly string[] = incompletePlanSteps(messages, userMessageId),
): LatestTurnTerminalState {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user' && (!userMessageId || messages[index]?.id === userMessageId)) {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex === -1) return 'no-user';

  for (let index = messages.length - 1; index > latestUserIndex; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === 'error') return 'error';
    if (message.role === 'assistant' && !message.isIntermediate) {
      // Structured declarations are evaluated by the objective validator;
      // prose heuristics must not bypass that host-side decision.
      if (message.objectiveOutcome || message.objectiveOutcomeError) return 'final-assistant';
      const stop = classifyObjectiveTerminalState(message.content);
      return looksLikePrematureFinalAssistant(message.content)
        || (remainingPlanSteps.length > 0 && stop !== 'blocked_human' && stop !== 'blocked_policy')
        ? 'premature-final-assistant'
        : 'final-assistant';
    }
  }

  return 'incomplete';
}
