import type { Message } from '@craft-agent/core/types';

export type LatestTurnTerminalState =
  | 'final-assistant'
  | 'premature-final-assistant'
  | 'error'
  | 'incomplete'
  | 'no-user';

const UNFINISHED_ACTION_PATTERNS = [
  /\b(?:je\s+(?:vais\s+)?(?:(?:maintenant|donc|d['’]abord|ensuite|aussi|[àa]\s+pr[ée]sent)\s+)?(?:v[ée]rifier|lancer|relancer|ex[ée]cuter|impl[ée]menter|corriger|modifier|cr[ée]er|g[ée]n[ée]rer|tester|analyser|auditer|chercher|contr[oô]ler|ouvrir|fermer|d[ée]ployer|remplacer|copier|soumettre|pousser|charger|lire|relire|poursuivre|continuer|commencer|poursuis|continue|commence)|j['’](?:ouvre|[ée]cris|analyse|ex[ée]cute|impl[ée]mente)|i\s+(?:will|am\s+going\s+to)\s+(?:now\s+)?(?:check|verify|run|rerun|implement|fix|change|create|generate|test|analyze|audit|search|open|close|deploy|continue|resume)|i['’]ll\s+(?:now\s+)?(?:check|verify|run|rerun|implement|fix|change|create|generate|test|analyze|audit|search|open|close|deploy|continue|resume))\b/i,
  /\bje\s+(?:poursuivrai|continuerai|reprendrai|relancerai|v[ée]rifierai|terminerai)\b/i,
  /\bje\s+(?:v[ée]rifie|lance|relance|ex[ée]cute|impl[ée]mente|corrige|modifie|cr[ée]e|g[ée]n[èe]re|teste|analyse|audite|cherche|contr[oô]le|ouvre|ferme|d[ée]ploie|remplace|copie|soumets|pousse|charge|lis|relis|poursuis|continue|commence)(?:\s+(?:maintenant|d['’]abord|ensuite|aussi))?\b/i,
  /(?:au\s+prochain\s+tour|dans\s+un\s+nouveau\s+tour|next\s+turn|new\s+turn).{0,120}(?:poursuiv|continu|reprendr|relanc|v[ée]rifi|termin|resume)/i,
];

const RECOVERABLE_TECHNICAL_CHECKPOINT_PATTERNS = [
  /(?:le|un)\s+prochain\s+correctif\s+(?:doit|devra|consiste|portera)\b/i,
  /\b(?:je\s+n['’]ai\s+pas|nous\s+n['’]avons\s+pas)\s+(?:encore\s+)?(?:appliqu[ée]|impl[ée]ment[ée]|tent[ée]|test[ée])\s+(?:de\s+|la\s+|le\s+|un\s+|une\s+)?(?:correction|correctif|solution|alternative)\b/i,
  /\b(?:aucun|aucune)\s+(?:test|validation|v[ée]rification|d[ée]ploiement|d[ée]p[oô]t|mutation).{0,100}\bn['’]a\s+(?:donc\s+)?pu\s+[êe]tre\s+(?:ex[ée]cut[ée]|effectu[ée]|valid[ée]|termin[ée])\b/i,
  /\b(?:la\s+suite|l['’][ée]tape\s+suivante)\s+(?:concerne|consiste|sera|doit|devra)\b/i,
];

const HUMAN_HANDOFF_PATTERN = /(?:connecte(?:-toi|z-vous)?|authentifie(?:-toi|z-vous)?|clique(?:z)?|valide(?:z)?|saisis(?:sez)?|renseigne(?:r|z)?|r[ée]ponds|dites?-moi|dis-moi|quand\s+(?:tu|vous)|merci\s+de|peux-tu|pouvez-vous|il\s+me\s+manque\s+(?:seulement\s+|ton|ta|votre|un\s+choix|une\s+d[ée]cision|une\s+autorisation|un\s+identifiant|un\s+secret)|j['’]ai\s+besoin\s+(?:de\s+ton|de\s+ta|de\s+votre|d['’]un\s+choix|d['’]une\s+d[ée]cision|d['’]une\s+autorisation|d['’]un\s+identifiant|d['’]un\s+secret)|(?:action|intervention|validation|confirmation|d[ée]cision|autorisation)\s+humaine|j['’]attends\s+(?:ta|votre)\s+(?:r[ée]ponse|validation|confirmation|d[ée]cision|autorisation)|please\s+(?:sign\s+in|log\s+in|click|confirm|enter|reply)|tell\s+me|once\s+you|waiting\s+for\s+you)/i;

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
  const unfinished = UNFINISHED_ACTION_PATTERNS.some(pattern => pattern.test(actionTail))
    || RECOVERABLE_TECHNICAL_CHECKPOINT_PATTERNS.some(pattern => pattern.test(checkpointTail));
  return unfinished && !HUMAN_HANDOFF_PATTERN.test(checkpointTail);
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
