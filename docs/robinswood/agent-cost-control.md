# Contexte, coûts et reprise des agents

La distribution publique conserve le fournisseur, le modèle et le raisonnement
choisis pour la session. Le contenu de la demande, le coût et les erreurs ne
sélectionnent pas un autre modèle. Les sous-tâches, revues `call_llm` et résumés de
contexte héritent de ce choix, sauf paramètre de modèle explicitement fourni.

Les helpers fixes de titre et d'icône sont des opérations de métadonnées. Les
modèles par défaut des connexions sont configurés lors de leur création. Ces
fonctions ne décident pas de l'affectation des travaux utilisateur.

## Contrôles conservés

| Contrôle | Valeur par défaut | Effet |
|---|---:|---|
| Compaction | 80 000 tokens | Résume l'historique sur le modèle sélectionné |
| Limite de contexte | 100 000 tokens | Signale la limite, ajustée à la fenêtre réelle |
| Reprise automatique | 8 tentatives au maximum | Reprend sur la connexion existante |
| Reprise sans progrès | 2 tentatives | Arrête les répétitions sans progrès vérifié |
| File inter-agents | 8 messages | Borne les messages en attente |

Les budgets chiffrés restent des données de suivi ; ils ne changent pas le modèle
ou le raisonnement. Les autorisations d'outils et d'actions restent applicables.

Les résultats volumineux restent accessibles sur disque. Une synthèse garde
l'objectif, les décisions vérifiées, les contraintes, les références aux preuves
et les actions restantes. Le callback de synthèse utilise la session choisie.

## Configuration

Le réglage workspace `costControl` accepte des valeurs partielles :

```json
{
  "enabled": true,
  "context": { "compactAtTokens": 80000, "hardLimitTokens": 100000 },
  "recovery": { "maxAutomaticAttempts": 8, "maxNoProgressAttempts": 2 },
  "coordination": { "maxQueuedMessages": 8 }
}
```

Les anciennes clés de sélection automatique n'ont plus de consommateur actif.
Les conversations historiques conservent leurs métadonnées de provenance et de
coûts ; leur présence n'active aucune décision automatique.

Le chargement conserve également les anciens modèles et connexions explicitement
sélectionnés. Un modèle retiré ou une connexion absente demande un nouveau choix.
Les migrations de modèles déjà appliquées par une ancienne version ne sont pas
inversées et aucune donnée réelle n'est restaurée automatiquement.

## Validation

Tester un choix manuel conservé après un message simple, une demande complexe,
une revue, une sous-tâche, un résumé de contexte et une erreur fournisseur.
Contrôler séparément la compaction, les permissions, la reprise et la lecture des
anciens historiques. Les cibles Dev, staging local et Release suivent le contrat
[CONTRIBUTING](../../CONTRIBUTING.md).
