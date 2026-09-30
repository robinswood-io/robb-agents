# Configuration d'un workspace client

La distribution publique utilise une connexion, un modèle et un raisonnement
choisis explicitement. Les tâches n'entraînent pas de changement automatique de
fournisseur ou de modèle.

1. Créer le workspace et choisir sa langue.
2. Configurer les connexions autorisées par le client ; vérifier séparément
   leurs identifiants, modèles et capacités d'outils.
3. Choisir la connexion et le modèle par défaut du workspace.
4. Configurer les sources utiles et leurs autorisations.
5. Choisir le mode de permissions adapté, puis créer une conversation test.
6. Vérifier que la connexion et le modèle choisis sont conservés après reprise,
   revue, sous-tâche et erreur temporaire.

Les décisions concernant les données autorisées sur un fournisseur relèvent du
choix explicite des connexions et des permissions du client. Ce guide ne promet
pas un classement automatique ou un changement de fournisseur selon le contenu.

| Contrôle | Attendu |
|---|---|
| Connexions | Chaque connexion utilisée est autorisée et validée |
| Sélection | Fournisseur, modèle et raisonnement visibles et modifiables |
| Sources | Accès et permissions adaptés au workspace |
| Échec fournisseur | Erreur visible, aucun changement silencieux de modèle |
| Historique | Messages anciens lisibles, provenance et coûts conservés |
| Recette | Parcours de [validation manuelle](manual-e2e.md) effectué |

Noter le client, le responsable, la date, le commit testé, les connexions validées
et les limites restantes. Ne pas inclure d'identifiants secrets dans ces notes.
