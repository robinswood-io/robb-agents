import type { Message } from '@craft-agent/core/types';

export type LatestTurnTerminalState =
  | 'final-assistant'
  | 'premature-final-assistant'
  | 'error'
  | 'incomplete'
  | 'no-user';

const UNFINISHED_ACTION_PATTERN = /\b(?:je\s+(?:vais\s+(?:(?:maintenant|donc|d['’]abord|ensuite|aussi|[àa]\s+pr[ée]sent)\s+)?(?:v[ée]rifier|lancer|relancer|ex[ée]cuter|impl[ée]menter|corriger|modifier|cr[ée]er|g[ée]n[ée]rer|tester|analyser|auditer|chercher|contr[oô]ler|ouvrir|fermer|d[ée]ployer|remplacer|copier|soumettre|pousser|charger|lire|relire)|(?:v[ée]rifie|lance|relance|ex[ée]cute|impl[ée]mente|corrige|modifie|cr[ée]e|g[ée]n[èe]re|teste|analyse|audite|cherche|contr[oô]le|ouvre|ferme|d[ée]ploie|remplace|copie|soumets|pousse|charge|lis|relis)(?:\s+(?:maintenant|d['’]abord|ensuite|aussi))?|poursuis|continue|commence)|j['’](?:ouvre|[ée]cris|analyse|ex[ée]cute|impl[ée]mente)|i\s+will\s+(?:now\s+)?(?:check|verify|run|rerun|implement|fix|change|create|generate|test|analyze|audit|search|open|close|deploy)|i['’]ll\s+(?:now\s+)?(?:check|verify|run|rerun|implement|fix|change|create|generate|test|analyze|audit|search|open|close|deploy)|i(?:\s+am|'m)\s+going\s+to\s+(?:check|verify|run|rerun|implement|fix|change|create|generate|test|analyze|audit|search|open|close|deploy))\b/i;

const HUMAN_HANDOFF_PATTERN = /(?:connecte(?:-toi|z-vous)?|clique(?:z)?|valide(?:z)?|saisis(?:sez)?|renseigne(?:r|z)?|r[ée]ponds|dites?-moi|dis-moi|quand\s+(?:tu|vous)|merci\s+de|peux-tu|pouvez-vous|il\s+me\s+manque|j['’]ai\s+besoin\s+de|(?:action|intervention|validation|confirmation)\s+humaine|j['’]attends\s+(?:ta|votre|une)|bloqu[ée]|ne\s+peux\s+pas|red[ée]marr(?:er|e|ez)|please\s+(?:sign\s+in|log\s+in|click|confirm|enter|reply)|tell\s+me|once\s+you|cannot|can't|blocked|waiting\s+for\s+you)/i;

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
  const tail = normalized.slice(-700);
  return UNFINISHED_ACTION_PATTERN.test(tail) && !HUMAN_HANDOFF_PATTERN.test(tail);
}

/**
 * Classify whether the latest user turn has a user-visible terminal outcome.
 * Intermediate commentary and tool results are progress, not a final answer.
 */
export function classifyLatestTurnTerminalState(messages: Message[]): LatestTurnTerminalState {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
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
      return looksLikePrematureFinalAssistant(message.content)
        ? 'premature-final-assistant'
        : 'final-assistant';
    }
  }

  return 'incomplete';
}
