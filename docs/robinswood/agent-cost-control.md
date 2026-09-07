# Profils de qualité et contrôle des coûts des agents

## Cible et objectif

Cette implémentation est destinée au canal **Robb Agents Dev** (`io.robinswood.robbagents.dev`, profil `~/.craft-agent-dev`). Elle ne remplace pas l’application de staging/production et ne modifie pas `~/.craft-agent`.

L’objectif par défaut est la qualité maximale : la politique de confidentialité choisit d’abord la connexion autorisée, puis le runtime conserve le modèle et le niveau de raisonnement de la session pendant toute la mission. La réduction automatique du coût est un choix explicite du workspace, jamais une conséquence implicite de la longueur d’un message ou d’une reprise interne.

## Profils

| Profil | Statut | Comportement |
| --- | --- | --- |
| `maximum-quality` | Défaut | Conserve exactement le modèle et le raisonnement effectifs de la session, quels que soient la longueur du message, le budget atteint ou le type de tour. Si aucune route n’existe encore, choisit le modèle le plus fort disponible et `xhigh`. |
| `balanced` | Opt-in | Autorise la sélection Astra/Terra/Luna décrite plus bas pour les tours ordinaires, avec Sol en repli d’Astra. Les premiers tours des spécialistes et les reprises automatiques conservent néanmoins leur route existante. |

`enabled: false` désactive l’application du contrôleur. Il ne sélectionne pas implicitement le profil `balanced`.

## Valeurs par défaut

| Contrôle | Valeur | Effet |
| --- | ---: | --- |
| Profil | `maximum-quality` | Interdit les rétrogradations automatiques de modèle et de raisonnement |
| Compaction du contexte | 80 000 tokens | Résume l’historique avant le tour suivant |
| Limite dure de contexte | 100 000 tokens | Signale la limite dans la provenance sans diminuer la qualité |
| Résultat d’outil en contexte | 4 000 tokens | Conserve le résultat complet sur disque et injecte une synthèse/référence |
| Budget session souple | 10 USD estimés | Produit un signal d’audit ; n’abaisse la route qu’en profil `balanced` |
| Budget session dur | 25 USD estimés | Produit un signal d’audit ; n’abaisse la route qu’en profil `balanced` |
| Reprise automatique | 6 h, plafond absolu 256 passages | Continue tant que des preuves nouvelles apparaissent ; arrêt après 2 passages stagnants |
| Reprise sans empreinte de progrès | 8 tentatives | Limite de compatibilité configurable ; 0 désactive les reprises |
| Reprises au redémarrage | 2 simultanées | Évite une rafale de sessions après lancement |
| File inter-agents | 8 messages | Fusionne les mises à jour au-delà de la limite |
| Boucle d’outil | indication au 3e, blocage du 4e identique | Encourage le batching et interdit la répétition inchangée |

Les opérations à risque (production, déploiement, suppression, migration, secrets, paiements, sécurité, signatures) restent sur le modèle le plus fort disponible avec un raisonnement `xhigh` en profil `balanced`. Astra est préféré lorsqu’il est proposé par la connexion autorisée, sinon Sol/équivalent. En `maximum-quality`, la route déjà choisie ne peut pas être rétrogradée implicitement.

## Routage par tour en profil `balanced`

| Tour | Simple | Standard | Complexe | Risque élevé |
| --- | --- | --- | --- | --- |
| Utilisateur direct | Luna / low | Terra / medium | Astra / high | Astra / xhigh |
| Message agent, automation, navigateur | Luna / low | Luna / low | Terra / medium | Astra / xhigh |
| Premier tour spécialiste ou reprise automatique | Route héritée | Route héritée | Route héritée | Route héritée |

Les noms sont des motifs appliqués uniquement aux modèles de la connexion autorisée. Le niveau fort recherche Astra, puis Sol, GPT-5.5 et Opus. Les niveaux économiques conservent leurs alternatives (`mini`/`haiku`, modèle équilibré/`sonnet`). Si aucun motif ne correspond, le routeur conserve le modèle courant ou le défaut de connexion. Les listes de motifs explicitement configurées restent prioritaires.

Astra est destiné aux travaux complexes de raisonnement et de code selon la [documentation officielle OpenAI](https://developers.openai.com/api/docs/models/gpt-6-astra). Son ajout au routage ne change pas le défaut des nouvelles connexions OpenAI, qui reste Sol, ni la conservation de la route existante en profil `maximum-quality`.

Une demande courte n’est plus `simple` du seul fait qu’elle contient moins de 30 mots. Seuls les acquittements et ordres de continuation triviaux sont classés `simple`. Les signaux d’implémentation, diagnostic, architecture, migration, automatisation ou traitement de plusieurs éléments classent la demande `complex` même si elle est concise.

## Héritage des spécialistes

Pour les agents issus du graphe de tâches, les connexions OpenAI API et ChatGPT/Codex à catalogue automatique sélectionnent le modèle par besoin, indépendamment de l’ordre du catalogue :

| Besoin du nœud | Modèle préféré | Raisonnement |
| --- | --- | --- |
| Simple | Luna | `low` |
| Standard | Terra | `medium` |
| Complexe, vérificateur ou juge final | Astra, puis Sol si absent | `high` |
| Deuxième tentative | Niveau supérieur (simple → Terra, standard → Astra) | `medium` ou `high` |
| Troisième tentative et suivantes | Astra, puis Sol si absent | `xhigh` |

Un modèle fixé sur le nœud, ou dans les valeurs par défaut de la tâche, précède cette sélection. Les connexions à trois niveaux définis par l’utilisateur conservent leur ordre. La politique de confidentialité continue de choisir les connexions autorisées avant toute sélection de modèle ; la présence d’Astra n’autorise aucun changement de fournisseur supplémentaire.

`spawn_session` résout la route dans cet ordre :

1. override explicite `llmConnection`, `model` ou `thinkingLevel` du spawn ; un changement de connexion sans modèle explicite utilise le défaut de la nouvelle connexion, pas un modèle incompatible du parent ;
2. valeur effective du parent ;
3. défaut workspace/global si le parent n’en possède pas.

Le premier tour du spécialiste est marqué `spawned-session` et conserve cette route exacte. Une reprise `automatic-recovery` conserve pareillement le modèle et le raisonnement du tour interrompu. Ces deux invariants s’appliquent aux deux profils : un prompt interne court ne constitue jamais une autorisation de rétrogradation.

## Résultats d’outils et compaction

Un résultat dépassant le plafond est enregistré dans `long_responses/`. Le modèle reçoit une synthèse et le chemin du fichier ; les données brutes restent accessibles par les outils de lecture. Au-delà de 40 000 tokens, le système évite aussi d’envoyer l’intégralité au mini-modèle de synthèse et utilise une référence avec aperçu.

La compaction conserve : objectif courant, décisions vérifiées, contraintes utilisateur, identifiants et chemins utiles, effets externes en attente, blocages et références aux preuves. Elle élimine les sorties brutes, statuts répétés, accusés de réception et pistes abandonnées.

## Coordination et reprise

`send_agent_message` transporte un type `progress`, `result`, `question` ou `decision`. `progress` et `result` sont à sens unique ; une réponse n’est attendue que pour une question, une décision, un blocage ou un handoff final. Les messages d’un même agent sont fusionnés si la cible travaille déjà.

Le fallback navigateur est autorisé uniquement pour un outil ayant une voie d’accès web équivalente (source, MCP, HTTP, GitHub, Gmail, etc.). Les erreurs locales de terminal ou filesystem restent dans la boucle de diagnostic locale et ne créent plus un nouveau tour navigateur.

Après un échec navigateur/desktop, une continuation structurée oriente l’agent vers un connecteur, une API, une base de données ou SSH déjà autorisés. Aucune permission n’est élargie. Un fallback fournisseur ne traverse que les connexions explicitement admises par la politique de routage : la présence d’une connexion configurée ne suffit pas à autoriser le transfert du contexte.

Les reprises conservent un objectif racine stable, les budgets et l’effort effectif. Un nouveau message utilisateur indépendant remplace le contrat ; un « poursuis » le conserve. Le progrès compare les cibles, transformations et résultats utiles, pas le nombre de messages. Une attente, une répétition inchangée ou un outil non exécuté ne prolongent pas la mission.

Le garde de boucle ne coupe plus systématiquement au 24e appel distinct. Il conserve un plafond de 96 appels par prompt et une réserve de 4 appels avant mutation. Un refus avant exécution devient un checkpoint explicite et une reprise, jamais une preuve de succès.

## Configuration workspace

La page **Réglages → Workspace → Contrôle des coûts agents** édite `costControl` dans `config.json`. Une configuration partielle hérite des valeurs par défaut. Exemple :

```json
{
  "profile": "maximum-quality",
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
    "maxAutomaticAttempts": 8
  },
  "coordination": {
    "maxQueuedMessages": 8
  }
}
```

Pour activer volontairement l’ancien arbitrage coût/qualité, définir explicitement :

```json
{
  "profile": "balanced",
  "enabled": true
}
```

## Mesure et audit

Chaque réponse conserve dans `routingMeta` : modèle effectif, difficulté, explication du routage, état du budget, type de tour, effort de raisonnement, taille du contexte avant le tour, franchissement de la limite dure et réussite éventuelle de la compaction. Les événements de coût existants continuent d’enregistrer coût estimé/réel, tokens de cache et provenance tarifaire.

Les indicateurs à suivre sur une fenêtre glissante de 48 h sont : taux d’objectifs vérifiés, taux de relance humaine, conservation de la route entre parent/spécialiste/reprise, coût par résultat vérifié, p90 du contexte, part des tours internes et proportion Astra/Sol/Terra/Luna. Une baisse du coût n’est recevable que si elle ne dégrade ni le taux de réussite, ni les erreurs terminales, ni les escalades humaines.

## Validation avant promotion

1. Exécuter les tests ciblés et le typecheck complet.
2. Lancer `bun run electron:dev` et vérifier le profil `~/.craft-agent-dev`.
3. Tester un tour simple, une demande complexe concise, un tour à risque, un spécialiste avec et sans override, une reprise, une compaction, un gros résultat et une rafale inter-agents.
4. Comparer une fenêtre Dev représentative au baseline 48 h.
5. Ne construire le staging local qu’à partir d’un commit propre avec `bash apps/electron/scripts/build-dmg.sh arm64 --local-production`, après accord explicite.

Le contrat de fin vérifiée et la qualification sur observations sont décrits dans [Autonomie vérifiable](autonomy-verifiable-execution-2026-09-06.md).
