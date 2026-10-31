
/** A structured quotation/topic header owns the following line. Its payload
 * is data to discuss, not a fresh instruction that can grant or revoke the
 * active objective merely because sentence splitting detached it. */
export function hasNonAuthoritativeStructuredLead(text: string): boolean {
  const normalized = text.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').toLowerCase();
  return /^\s*(?:(?:exemple(?:\s+d(?:instruction|option|invite|ordre))?|example(?:\s+of\s+(?:an?\s+)?(?:instruction|option|prompt|order))?|citation|quote|sujet|subject|question|hypothese|option|proposition|scenario|consigne\s+citee|texte\s+a\s+analyser|plan\s+(?:propose|proposed))|(?:(?:le|la)\s+)?(?:rapport|report|document|documentation|texte|text|message)\b.{0,100}\b(?:dit|says?|indique|mentions?|recommande|recommends?)|analyse\b.{0,100}\b(?:instruction|option|texte|text|si|whether))\s*:\s*(?:\r?\n)+/u.test(normalized);
}

export function matchesExecutionAuthorityRevocation(candidate: string): boolean {
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
