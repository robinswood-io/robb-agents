# Spécification — audit provider, modèle et coûts

Date de référence : 2026-07-06

## Objectif

Permettre à Robinswood et au client d’auditer :

- quel provider a répondu ;
- quel modèle a été utilisé ;
- pourquoi cette route a été choisie ;
- quelle sensibilité a été appliquée ;
- quelles règles policy ont matché ;
- quel coût estimé/réel est associé à la réponse ou à la session.

## État actuel

Déjà disponible :

- `routingMeta.connectionSlug` ;
- `routingMeta.providerType` ;
- `routingMeta.model` ;
- `routingMeta.reason` ;
- `routingMeta.sensitivity` ;
- `routingMeta.policyRuleIds` ;
- tooltip assistant avec ces informations.

À ajouter :

- coût estimé/réel ;
- résumé agrégé session ;
- export/audit client.

## Modèle de données proposé

### Par message assistant

```ts
interface RoutingMeta {
  connectionSlug?: string
  providerType?: string
  model?: string
  reason?: string
  sensitivity?: string
  policyRuleIds?: string[]
  fallbackFromConnectionSlug?: string
  fallbackReason?: string
  estimatedCostEur?: number
  actualCostEur?: number
  tokenUsageSource?: 'sdk' | 'provider' | 'estimated' | 'unavailable'
}
```

### Agrégat session

```ts
interface SessionRoutingAuditSummary {
  totalEstimatedCostEur?: number
  totalActualCostEur?: number
  byConnectionSlug: Record<string, {
    turns: number
    estimatedCostEur?: number
    actualCostEur?: number
  }>
  bySensitivity: Record<string, { turns: number }>
  policyRuleHits: Record<string, number>
}
```

## Sources de coût

Ordre de préférence :

1. coût réel provider si API disponible ;
2. usage token SDK × grille tarifaire locale ;
3. estimation approximative ;
4. `unavailable` explicite.

Ne jamais inventer un coût comme s’il était réel. Toujours marquer la source.

## UI proposée

### Tooltip message

Ajouter :

- coût estimé/réel si disponible ;
- source du coût.

### Header/session info

Ajouter un panneau audit :

- coût total ;
- providers utilisés ;
- règles policy touchées ;
- nombre de tours par sensibilité.

## Export client

Format minimal Markdown/JSON :

```json
{
  "sessionId": "...",
  "totalEstimatedCostEur": 0.42,
  "providers": {
    "souverain-standard": { "turns": 8, "estimatedCostEur": 0.31 },
    "local-rapide": { "turns": 3, "estimatedCostEur": 0 }
  },
  "sensitivities": {
    "internal": { "turns": 6 },
    "confidential": { "turns": 5 }
  },
  "policyRuleHits": {
    "internal-sovereign-first": 6,
    "confidential-sovereign-or-local": 5
  }
}
```

## Tests requis

- message avec tokenUsage SDK produit coût estimé ;
- message sans coût marque `unavailable` ;
- agrégat session groupe par provider ;
- tooltip n’affiche pas de coût si non disponible ;
- export ne confond jamais estimation et réel.

## Critères d’acceptation

- Chaque réponse reste auditée provider/modèle/règle.
- Les coûts ne sont affichés que s’ils sont sourcés.
- L’export permet une revue client sans exposer de secrets ni clés API.
