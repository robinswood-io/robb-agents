# Contrôle des coûts des agents

## Cible et objectif

Cette implémentation est destinée au canal **Robb Agents Dev** (`io.robinswood.robbagents.dev`, profil `~/.craft-agent-dev`). Elle ne remplace pas l’application de staging/production et ne modifie pas `~/.craft-agent`.

L’objectif est de réduire le coût par résultat utile sans affaiblir les garde-fous de sécurité : la politique de confidentialité choisit d’abord la connexion autorisée, puis le contrôleur de coût choisit le modèle et le niveau de raisonnement disponibles dans cette connexion.

## Valeurs par défaut

| Contrôle | Valeur | Effet |
| --- | ---: | --- |
| Compaction du contexte | 80 000 tokens | Résume l’historique avant le tour suivant |
| Limite dure de contexte | 100 000 tokens | Déclenche le routage économique et signale la limite dans la provenance |
| Résultat d’outil en contexte | 4 000 tokens | Conserve le résultat complet sur disque et injecte une synthèse/référence |
| Budget session souple | 10 USD estimés | Compacte et abaisse d’un niveau les travaux non critiques |
| Budget session dur | 25 USD estimés | Force Luna/équivalent pour les tours non critiques |
| Reprise automatique | 1 tentative | Supprime les boucles de reprise après crash/fin de flux |
| Reprises au redémarrage | 2 simultanées | Évite une rafale de sessions après lancement |
| File inter-agents | 8 messages | Fusionne les mises à jour au-delà de la limite |
| Boucle d’outil | indication au 3e, blocage du 4e identique | Encourage le batching et interdit la répétition inchangée |

Les opérations à risque (production, déploiement, suppression, migration, secrets, paiements, sécurité, signatures) restent sur le modèle le plus fort avec un raisonnement `xhigh`.

## Routage par tour

| Tour | Simple | Standard | Complexe | Risque élevé |
| --- | --- | --- | --- | --- |
| Utilisateur direct | Luna / low | Terra / medium | Sol / high | Sol / xhigh |
| Agent, automation, reprise, navigateur | Luna / low | Luna / low | Terra / medium | Sol / xhigh |

Les noms sont des motifs. Si une connexion ne propose pas Luna, Terra ou Sol, le routeur recherche les équivalents configurés (`mini`/`haiku`, modèle équilibré/`sonnet`, modèle fort/`opus`) puis conserve le modèle courant si aucun motif ne correspond.

## Résultats d’outils et compaction

Un résultat dépassant le plafond est enregistré dans `long_responses/`. Le modèle reçoit une synthèse et le chemin du fichier ; les données brutes restent accessibles par les outils de lecture. Au-delà de 40 000 tokens, le système évite aussi d’envoyer l’intégralité au mini-modèle de synthèse et utilise une référence avec aperçu.

La compaction conserve : objectif courant, décisions vérifiées, contraintes utilisateur, identifiants et chemins utiles, effets externes en attente, blocages et références aux preuves. Elle élimine les sorties brutes, statuts répétés, accusés de réception et pistes abandonnées.

## Coordination et reprise

`send_agent_message` transporte un type `progress`, `result`, `question` ou `decision`. `progress` et `result` sont à sens unique ; une réponse n’est attendue que pour une question, une décision, un blocage ou un handoff final. Les messages d’un même agent sont fusionnés si la cible travaille déjà.

Le fallback navigateur est autorisé uniquement pour un outil ayant une voie d’accès web équivalente (source, MCP, HTTP, GitHub, Gmail, etc.). Les erreurs locales de terminal ou filesystem restent dans la boucle de diagnostic locale et ne créent plus un nouveau tour navigateur.

## Configuration workspace

La page **Réglages → Workspace → Contrôle des coûts agents** édite `costControl` dans `config.json`. Une configuration partielle hérite des valeurs par défaut. Exemple :

```json
{
  "enabled": true,
  "context": {
    "compactAtTokens": 80000,
    "hardLimitTokens": 100000
  },
  "budgets": {
    "softSessionUsd": 10,
    "hardSessionUsd": 25
  },
  "recovery": {
    "maxAutomaticAttempts": 1
  },
  "coordination": {
    "maxQueuedMessages": 8
  }
}
```

## Mesure et audit

Chaque réponse conserve dans `routingMeta` : modèle effectif, difficulté, explication du routage, état du budget, type de tour, effort de raisonnement, taille du contexte avant le tour, franchissement de la limite dure et réussite éventuelle de la compaction. Les événements de coût existants continuent d’enregistrer coût estimé/réel, tokens de cache et provenance tarifaire.

Les quatre indicateurs à suivre sur une fenêtre glissante de 48 h sont : coût équivalent par réponse finale, p90 du contexte, part des tours internes, et proportion Sol/Terra/Luna. Le critère de succès initial est une baisse supérieure à 75 % du coût équivalent sans hausse des erreurs terminales ni des escalades humaines.

## Validation avant promotion

1. Exécuter les tests ciblés et le typecheck complet.
2. Lancer `bun run electron:dev` et vérifier le profil `~/.craft-agent-dev`.
3. Tester un tour simple, un tour complexe, un tour à risque, une compaction, un gros résultat, une reprise et une rafale inter-agents.
4. Comparer une fenêtre Dev représentative au baseline 48 h.
5. Ne construire le staging local qu’à partir d’un commit propre avec `bash apps/electron/scripts/build-dmg.sh arm64 --local-production`, après accord explicite.
