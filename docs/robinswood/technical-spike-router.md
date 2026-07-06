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

## Option cible : RouterBackend

Créer une abstraction de backend routeur :

```ts
providerType: 'router'
```

ou une politique attachée au workspace/session :

```ts
routingPolicy: {
  mode: 'auto' | 'manual' | 'privacy' | 'cost' | 'quality',
  allowedConnections: string[],
  defaultConnection: string,
  classifierConnection?: string,
  rules: RoutingRule[]
}
```

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

Ce MVP reste volontairement un **handoff entre tours**, pas un routage automatique ni un transfert parfait de contexte natif SDK.

## Critère de succès du spike

Un utilisateur doit pouvoir :

1. commencer une session avec un provider A ;
2. envoyer plusieurs messages ;
3. basculer vers provider B ;
4. continuer avec le contexte utile ;
5. voir clairement quel provider a répondu ;
6. ne pas casser sources, outils, permissions, streaming, reprise session.
