# Spécification — fallback router policy-aware

Date de référence : 2026-07-06

## Problème

Le router sélectionne aujourd’hui une connexion autorisée avant création/réutilisation du backend. Si le provider choisi est indisponible ou échoue à l’exécution, l’expérience peut se bloquer alors qu’une autre connexion autorisée existe.

Le fallback doit rester **policy-first** : ne jamais basculer vers une connexion interdite par `routingPolicy`, même si elle est techniquement disponible.

## Objectifs

- Réessayer sur une connexion de fallback seulement si elle est autorisée par la policy effective du tour.
- Exposer le fallback dans `routingMeta`.
- Rendre la cause visible dans le tooltip assistant.
- Fail-closed si aucun fallback autorisé n’existe.

## Non-objectifs MVP

- Optimisation coût dynamique.
- Classification automatique de difficulté.
- Retry infini ou multi-provider complexe.
- Fallback pendant un stream déjà partiellement envoyé au renderer.

## Modèle de données proposé

Étendre `RoutingMeta` :

```ts
interface RoutingMeta {
  connectionSlug?: string
  providerType?: string
  model?: string
  reason?: 'session-connection' | 'manual-handoff' | 'router'
  sensitivity?: RoutingSensitivity
  policyRuleIds?: string[]
  fallbackFromConnectionSlug?: string
  fallbackReason?: 'connection-unavailable' | 'backend-create-failed' | 'auth-failed' | 'provider-error' | 'model-unavailable'
}
```

## Algorithme MVP

1. Résoudre la route primaire via `resolveRoutingPolicy(...)`.
2. Tenter de créer/réutiliser le backend primaire.
3. Si échec avant streaming utilisateur :
   - classifier l’erreur dans `fallbackReason` ;
   - construire la liste fallback candidate :
     - `fallbackConnectionSlugs` des règles matchées ;
     - `policy.fallbackConnectionSlug` ;
     - autres connexions encore autorisées par la décision policy, dans ordre stable.
   - retirer la connexion primaire ;
   - tester la première candidate autorisée.
4. Si fallback réussi :
   - utiliser cette connexion ;
   - persister `routingMeta.fallbackFromConnectionSlug` et `fallbackReason`.
5. Si aucun fallback autorisé :
   - échouer explicitement ;
   - ne jamais utiliser une connexion hors policy.

## Points d’attention

- Ne pas fallback après émission partielle d’une réponse streamée, sauf futur mécanisme explicite d’annulation/retry visible.
- Ne pas masquer les erreurs d’auth : un fallback peut aider, mais l’admin doit voir que la connexion primaire est cassée.
- Respecter le handoff idle-only déjà en place.
- Nettoyer les métadonnées SDK non portables si le fallback implique un changement de provider runtime.

## Tests requis

### Unitaires `routing-policy`

- fallback local rule préféré si primary échoue ;
- fallback global si rule fallback absent ;
- aucune route si fallback non autorisé ;
- restricted ne tombe jamais sur premium/Gemini.

### Server-core session

- backend primaire `souverain-standard` échoue, fallback `local-rapide` réussit ;
- `routingMeta` contient :
  - `connectionSlug: local-rapide` ;
  - `fallbackFromConnectionSlug: souverain-standard` ;
  - `fallbackReason` ;
  - `policyRuleIds` inchangé.
- échec fail-closed si seul fallback disponible est interdit.

### Renderer

- tooltip affiche fallback :
  - `Fallback depuis: souverain-standard` ;
  - `Raison fallback: provider-error`.

## Critères d’acceptation

- Aucun fallback hors allow-list n’est possible.
- Un provider indisponible ne bloque pas les cas où un fallback autorisé existe.
- L’utilisateur/admin voit clairement que la réponse vient d’un fallback.
- CI Robinswood couvre les scénarios critiques.
