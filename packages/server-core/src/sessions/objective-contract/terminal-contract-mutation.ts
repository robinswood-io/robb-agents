import { withoutClauseConnector } from './amendment-intent.ts';
import { boundedInstructionClauses } from './execution-revocation.ts';
import { matchesExecutionAuthorityRevocation } from './instruction-clause-syntax.ts';
import { foldForIntent } from './types.ts';

/** A reply-format preference cannot conceal a fresh send or target change.
 * Keep this grammar independent from the broad artifact classifier: delivery
 * verbs and addresses with dots are both known blind spots there. */
export function hasExplicitTerminalContractMutation(text: string): boolean {
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
