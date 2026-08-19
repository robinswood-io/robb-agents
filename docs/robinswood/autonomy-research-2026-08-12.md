# Autonomie des agents — état de l’art et intégration Robb

Date de recherche : 12 août 2026.

## Résultat

Robb disposait déjà des fondations de production recommandées pour des agents
autonomes : orchestration de spécialistes, exécution durable, budgets, échéances,
approbations, kill switches, isolation, diversification des retries, preuves de
mutation et boucle finale evaluator–optimizer.

La lacune prioritaire n’était donc pas d’ajouter une nouvelle boucle générique,
mais d’empêcher la boucle de réparation existante d’oublier ses essais et de
consommer son budget sans progrès observable.

La livraison ajoute :

1. une mémoire épisodique bornée des critiques du vérificateur ;
2. la réinjection bornée de la dernière sortie rejetée dans la tentative suivante ;
3. une empreinte canonique du résultat observable de chaque frontière réparée ;
4. un arrêt anticipé durable lorsqu’un résultat déjà rejeté réapparaît ;
5. une vérification finale qui distingue explicitement affirmation de succès et
   état réellement observé ;
6. un routage `judge`/`verify` vers le rôle review et le meilleur tier de modèle,
   sauf route explicitement épinglée ;
7. une projection de la stagnation comme blocker actionnable dans Mission Control ;
8. une reprise bornée des dépassements de contexte Codex : compaction native,
   compaction opérationnelle de secours puis continuation sans dupliquer le tour.

## Sources primaires et conséquences de conception

| Source | Résultat utile | Décision Robb |
| --- | --- | --- |
| [Anthropic — Building Effective AI Agents](https://www.anthropic.com/engineering/building-effective-agents) | Les patterns orchestrator–workers et evaluator–optimizer sont adaptés aux tâches complexes lorsque les critères sont explicites. | Conserver le DAG et le vérificateur existants ; améliorer la boucle plutôt que créer un second orchestrateur concurrent. |
| [Reflexion](https://arxiv.org/abs/2303.11366) | Une mémoire épisodique de feedback verbal permet aux tentatives suivantes d’exploiter les erreurs passées sans réentraînement. | Conserver les critiques du vérificateur dans l’état durable du run et les réinjecter de façon bornée. |
| [Self-Refine](https://arxiv.org/abs/2303.17651) | La boucle feedback→refinement conserve les sorties et feedbacks précédents et requiert une condition d’arrêt. | Ajouter la sortie rejetée, des feedbacks spécifiques et une condition d’arrêt fondée sur le résultat. |
| [Voyager](https://arxiv.org/abs/2305.16291) | Le feedback de l’environnement, les erreurs d’exécution et l’auto-vérification améliorent les itérations ; les compétences réutilisables évitent l’oubli. | Donner priorité aux preuves d’exécution et à la mémoire du run. La promotion automatique d’un essai en skill global reste différée car elle exige revue, provenance et révocation. |
| [Anthropic — Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | Le résultat dans l’environnement doit être distingué du texte final de l’agent ; les trajectoires et graders sont des preuves différentes. | Le prompt de verdict refuse qu’une simple déclaration de complétion serve de preuve et demande checks, état, artefacts ou reçus. |
| [OpenAI — A practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/) | Les runs ont besoin de conditions de sortie ; les seuils d’échec et les actions à risque doivent provoquer arrêt ou intervention humaine. | Garder budgets et approbations existants, puis ajouter un seuil de non-progrès déterministe avant épuisement complet du budget. |
| [Anthropic — Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Le contexte est une ressource finie ; les tâches longues demandent compaction, notes structurées et conservation des tokens à fort signal. | Résumer en handoff opérationnel borné, préserver objectif/décisions/preuves et éliminer sorties d’outils brutes ou répétées. |
| [OpenAI — Responses API reference](https://platform.openai.com/docs/api-reference/responses) | Une entrée trop grande échoue lorsque la troncature est désactivée ; la troncature automatique retire les éléments les plus anciens. | Préférer une compaction explicite qui préserve l’état utile à une suppression silencieuse et non sémantique de l’historique. |
| [ReTree](https://arxiv.org/abs/2608.10676) | Pour la recherche longue, une mémoire arborescente peut conserver provenance et historiques de révision tout en réparant les branches dépendantes. | Le repair frontier de Robb répare déjà les dépendants. Une evidence tree complète n’est pas généralisée hors recherche tant que son coût et ses invariants ne sont pas qualifiés. |

## Contrat `task.yaml`

La politique est optionnelle. Son absence active les valeurs sûres par défaut :

```yaml
autonomy:
  reflection_memory_entries: 3
  reflection_output_chars: 1500
  stagnation_limit: 2
```

- `reflection_memory_entries` : nombre maximal de critiques pertinentes
  réinjectées ; `0` désactive cette mémoire de prompt.
- `reflection_output_chars` : taille maximale de l’extrait de sortie rejetée ;
  `0` désactive l’extrait.
- `stagnation_limit` : nombre de revisites d’un résultat déjà rejeté avant arrêt.

Les caps du schéma sont respectivement 8 entrées, 4 000 caractères et 5
revisites. `max_iterations` reste la limite absolue des réparations.

## Modèle de progression

À chaque verdict `FAIL`, Robb matérialise la plus petite frontière valide indiquée
par le vérificateur, normalise les espaces de ses sorties puis calcule une empreinte
SHA-256. Une empreinte nouvelle remet le compteur de stagnation à zéro ; une
empreinte déjà rejetée l’incrémente. Le journal conserve l’empreinte, la frontière
et le compteur, jamais une copie supplémentaire de la sortie.

Ce choix détecte de façon déterministe les points fixes et les cycles courts, y
compris après redémarrage. Il ne prétend pas mesurer une amélioration sémantique.

## Garde-fous conservés

- aucune mutation externe n’est rejouée sans preuve rapprochée ;
- aucune permission n’est élargie par la mémoire réflexive ;
- les sorties historiques sont traitées comme données non fiables, pas comme
  instructions ;
- la mémoire est bornée au run et ne devient pas automatiquement une mémoire
  globale ou un skill ;
- les budgets tokens/coût, échéances, approvals et kill switches restent
  prioritaires sur toute réparation.

## Résilience des chats longs

Lorsqu’un fournisseur renvoie `context_length_exceeded`, Robb laisse d’abord le
SDK Pi effectuer son compactage et sa reprise natifs. L’itérateur d’événements
reste ouvert pendant cette séquence afin que la réponse récupérée ne soit pas
perdue après le premier `agent_end`.

Si aucune compaction native ne démarre, si le SDK épuise son unique reprise ou
s’il rencontre sa course transitoire connue, Robb lance une seule reprise de
secours sérialisée :

1. attendre la fin de toute compaction en vol ;
2. produire un handoff compact qui conserve objectif, décisions, état vérifié,
   chemins, tests, contraintes et prochaine action ;
3. retirer uniquement le message d’erreur assistant terminal ;
4. continuer le tour utilisateur déjà journalisé, sans renvoyer le texte ni les
   images ;
5. interdire toute nouvelle boucle de secours sur ce tour.

Si le contexte reste trop grand — typiquement parce que le message ou ses pièces
jointes dépassent à eux seuls la fenêtre — Robb termine avec une indication
actionnable plutôt qu’avec l’erreur brute Codex.

## Limites et suites qualifiables

- L’empreinte tolère les différences d’espacement mais ne reconnaît pas encore
  deux textes sémantiquement équivalents.
- Le verdict final est rendu par l’orchestrateur de la tâche. Un nœud explicite
  `judge` ou `verify` reçoit un routage renforcé, mais l’indépendance obligatoire
  par fournisseur/modèle n’est pas imposée aux anciens workflows.
- L’exploration de plusieurs candidats façon LATS et le vote multi-juge restent
  à évaluer : ils augmentent fortement coût et latence et ne doivent pas être
  activés par défaut sans benchmark Robb reproductible.
- La mémoire arborescente sourcée de type ReTree est pertinente pour les missions
  de recherche, pas encore prouvée comme abstraction commune aux mutations et
  tâches de code.

## Vérification locale

- 176 tests ciblés passent sur l’autonomie, le schéma, l’exécution durable,
  Mission Control, le routage, le `TaskRunner` et le round-trip de l’éditeur.
- 71 tests ciblés passent sur l’adaptation d’événements Pi et la reprise des
  dépassements de contexte, dont reprise native, secours, épuisement et
  préparation sûre de la continuation.
- Les typechecks `packages/shared` et `packages/server-core` passent.
- Les tests couvrent explicitement l’arrêt d’un résultat identique, la mémoire
  injectée, les caps de configuration et la reconstruction après redémarrage.
