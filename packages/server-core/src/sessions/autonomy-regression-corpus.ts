/**
 * Anonymized regression corpus distilled from the 72-hour production audit.
 * Keep these as behavioral fixtures: they are not prompts and contain no
 * workspace paths, credentials, customer data, or session identifiers.
 */
export const AUTONOMY_REGRESSION_CORPUS = {
  prematureFinals: [
    'État intermédiaire : la configuration locale est corrigée. Il reste à installer la version distante puis à la valider.',
    'Point d’étape : le diagnostic est confirmé. La prochaine action consiste à appliquer le correctif.',
    'Reste à exécuter : le test d’intégration et la validation utilisateur.',
    'Étape restante : déployer le candidat sur l’environnement de test.',
    'Prochaine action automatique : relancer le service puis contrôler son état.',
    'Le travail est engagé mais pas terminé.',
    'L’objectif n’est pas encore déclaré terminé.',
  ],
  continuationTurns: [
    'Fais le',
    'Fais le avec précision',
    'Go',
    'Ok go',
    'Poursuit',
    'Reprends',
  ],
  legitimateHumanBlocks: [
    'OAuth exige un code MFA. Connectez-vous puis dites-moi quand c’est fait.',
    'J’ai besoin d’une autorisation externe irréversible. Dites-moi si la cible exacte est confirmée.',
  ],
} as const;
