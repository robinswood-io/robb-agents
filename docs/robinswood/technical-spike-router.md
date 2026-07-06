# Spike technique — switch provider et router IA

## Problème

Craft Agents OSS verrouille `llmConnection` après le premier message. Cela protège la cohérence avec les SDKs agents, mais empêche :

- le switch manuel de provider en cours de chat ;
- le routage automatique par tour ;
- les politiques local/cloud dynamiques.

## Fichiers observés

- `packages/server-core/src/sessions/SessionManager.ts`
  - `getOrCreateAgent(...)`
  - `setSessionConnection(...)`
  - `updateSessionModel(...)`
- `packages/shared/src/config/llm-connections.ts`
- `apps/electron/src/renderer/components/app-shell/input/CompactModelSelector.tsx`
- `apps/electron/src/renderer/pages/ChatPage.tsx`

## Option MVP : handoff contrôlé

Permettre un changement de provider uniquement entre deux tours :

1. vérifier que l’agent est idle ;
2. enregistrer l’intention de changement ;
3. créer un résumé canonique du contexte ;
4. disposer l’agent courant ;
5. effacer/remplacer les métadonnées SDK incompatibles ;
6. créer un nouvel agent avec la nouvelle connexion ;
7. injecter résumé + transcript utile ;
8. journaliser `provider_handoff`.

Avantage : plus rapide.

Risque : continuité imparfaite si le backend précédent avait un contexte natif non reconstructible.

## Option cible : policy-first router

Le router doit rester **policy-first** : confidentialité/sensibilité et allow-lists avant coût, performance ou préférence utilisateur.

Socle ajouté le 2026-07-06 :

- `packages/shared/src/config/routing-policy.ts`
  - schema `RoutingPolicy` versionné ;
  - `RoutingSensitivity = 'public' | 'internal' | 'confidential' | 'restricted'` ;
  - règles `allowConnectionSlugs`, `denyConnectionSlugs`, `allowProviderTypes` ;
  - préférences non contraignantes `preferConnectionSlugs` et fallbacks ;
  - `validateRoutingPolicy(...)` ;
  - `resolveRoutingPolicy(...)` pur et testable.
- `WorkspaceConfig.routingPolicy?: RoutingPolicy`
- `packages/shared/tests/routing-policy.test.ts`

Exemple cible :

```ts
routingPolicy: {
  version: 1,
  enabled: true,
  defaultSensitivity: 'internal',
  requireExplicitAllowFor: ['confidential', 'restricted'],
  rules: [
    {
      id: 'confidential-local-or-sovereign',
      when: { sensitivity: ['confidential', 'restricted'] },
      allowConnectionSlugs: ['local-ollama', 'ovh-sovereign'],
      allowProviderTypes: ['pi_compat'],
      preferConnectionSlugs: ['ovh-sovereign', 'local-ollama']
    },
    {
      id: 'public-fast',
      when: { sensitivity: ['public'] },
      allowConnectionSlugs: ['openrouter-balanced', 'anthropic-direct'],
      preferConnectionSlugs: ['openrouter-balanced']
    }
  ]
}
```

Intégration runtime ajoutée : `SessionManager.getOrCreateAgent(...)` appelle maintenant `resolveRoutingPolicy(...)` avant création/réutilisation du backend lorsqu’une `routingPolicy` workspace est activée. La sélection reste entre deux tours : si la policy choisit une autre connexion, le runtime courant est disposé, l’état SDK natif non portable est effacé, et un résumé de continuité best-effort est préparé.

Les sources peuvent porter `routingSensitivity?: 'public' | 'internal' | 'confidential' | 'restricted'`. Quand plusieurs sources sont activées, le runtime utilise la sensibilité la plus élevée comme contexte de décision pour `resolveRoutingPolicy(...)`.

Le router conserve le transcript canonique et délègue chaque tour au backend cible.

## Données à persister par message

- provider utilisé ;
- connection slug ;
- model id ;
- raison de routage ;
- sensibilité estimée ;
- coût estimé/réel si disponible ;
- fallback éventuel ;
- policy appliquée.

## MVP implémenté — 2026-07-06

Premier changement de code :

- `SessionManager.setSessionConnection(...)` autorise maintenant un changement de connexion après démarrage **uniquement si la session est idle**.
- Si le provider change après le premier message :
  - un résumé de continuité est généré best-effort via `generateRemoteTransferSummary(...)` ;
  - l’agent courant est disposé via `disposeManagedAgentRuntime(...)` ;
  - les métadonnées SDK natives non portables (`sdkSessionId`, fork SDK ids) sont effacées ;
  - le résumé est injecté une fois au prochain backend via `transferredSessionSummary` ;
  - `llmConnection` est persisté ;
  - l’UI reçoit l’événement existant `connection_changed` ;
  - le prochain message recréera un backend sur la nouvelle connexion.
- `derivePickerMode(...)` garde maintenant le switcher visible dès qu’il y a plusieurs connexions, y compris en session non vide.
- Les messages assistant portent désormais un `routingMeta` persistant avec `connectionSlug`, `providerType`, `model` et `reason` (`session-connection` ou `manual-handoff`).
- Le renderer reçoit aussi `routingMeta` via `text_complete` et affiche un badge discret provider/modèle.
- Le schema `routingPolicy` est branché au runtime pour les workspaces qui l’activent explicitement.
- Les réponses routées automatiquement portent `routingMeta.reason = 'router'`, `sensitivity` et `policyRuleIds`.
- Les sources supportent désormais un hint manuel `routingSensitivity`, validé par le schema source.

Ce MVP reste volontairement un **handoff entre tours**, pas un routage mid-stream ni un transfert parfait de contexte natif SDK.

## Critère de succès du spike

Un utilisateur doit pouvoir :

1. commencer une session avec un provider A ;
2. envoyer plusieurs messages ;
3. basculer vers provider B ;
4. continuer avec le contexte utile ;
5. voir clairement quel provider a répondu ;
6. ne pas casser sources, outils, permissions, streaming, reprise session.
