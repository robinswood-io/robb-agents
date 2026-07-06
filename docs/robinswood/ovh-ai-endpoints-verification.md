# Vérification OVHcloud AI Endpoints

Date de référence : 2026-07-06

## Statut

Preset Robinswood OVH : **bloqué volontairement** tant que les tests live ne sont pas exécutés avec une vraie clé client/projet.

## Informations documentaires relevées

Source officielle consultée : OVHcloud Docs — AI Endpoints Responses API.

Points documentés :

- endpoint OpenAI-compatible Responses API : `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` ;
- route : `/v1/responses` ;
- auth : `Authorization: Bearer $AI_ENDPOINT_API_KEY` ;
- exemple modèle texte : `gpt-oss-20b` ;
- streaming : `stream: true` via SSE ;
- statefulness Responses API : non géré ; utiliser `store: false` ;
- multi-turn : envoyer l’historique complet côté client ;
- vision : support modèle-dépendant, image en data URL base64, pas URL distante ;
- built-in tools OpenAI non supportés ; custom function tools seulement ;
- limitations variables selon modèle.

## À vérifier live avant preset

### 1. Authentification

Commande :

```bash
curl https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AI_ENDPOINT_API_KEY" \
  -d '{
    "model": "gpt-oss-20b",
    "input": "Réponds uniquement OK.",
    "store": false
  }'
```

Résultat attendu : réponse texte OK, pas 401/403.

Statut : `[ ] PASS` `[ ] FAIL` `[ ] BLOCKED`

### 2. Streaming

Commande :

```bash
curl https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AI_ENDPOINT_API_KEY" \
  -d '{
    "model": "gpt-oss-20b",
    "input": "Écris 5 mots séparés lentement.",
    "stream": true,
    "store": false
  }'
```

Résultat attendu : SSE exploitable par l’adapter.

Statut : `[ ] PASS` `[ ] FAIL` `[ ] BLOCKED`

### 3. Chat Completions fallback

À vérifier si l’adapter actuel Robinswood/Pi attend plutôt `chat/completions` :

```bash
curl https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AI_ENDPOINT_API_KEY" \
  -d '{
    "model": "gpt-oss-20b",
    "messages": [{"role": "user", "content": "Réponds uniquement OK."}],
    "stream": false
  }'
```

Résultat attendu : confirmer si la route est disponible et compatible.

Statut : `[ ] PASS` `[ ] FAIL` `[ ] BLOCKED`

### 4. Liste modèles / modèle IDs

À vérifier dans le catalogue OVH et/ou par endpoint si disponible :

- modèles texte recommandés ;
- modèles reasoning ;
- modèles vision ;
- context window ;
- support streaming ;
- support tool/function calling ;
- support structured outputs.

Modèles confirmés live :

```text

```

### 5. Vision

Tester un modèle vision OVH documenté, par exemple celui indiqué par le catalogue courant.

Contraintes docs :

- image en data URL base64 ;
- pas d’image distante par URL ;
- support dépend du modèle.

Statut : `[ ] PASS` `[ ] FAIL` `[ ] BLOCKED`

### 6. Structured output

Tester `text.format` JSON schema.

Statut : `[ ] PASS` `[ ] FAIL` `[ ] BLOCKED`

### 7. Tool calling

Tester custom function tools uniquement.

Statut : `[ ] PASS` `[ ] FAIL` `[ ] BLOCKED`

### 8. Intégration Robinswood

Créer une connexion custom endpoint dans l’app :

- slug : `souverain-standard` ou `ovh-ai-endpoints-test` ;
- base URL : `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` ;
- auth : API key bearer/OpenAI-compatible selon adapter ;
- modèle : modèle confirmé live ;
- streaming : activé si compatible.

Tester :

- validation connexion ;
- session simple ;
- streaming ;
- multi-turn ;
- source `internal` ;
- source `confidential` ;
- policy fail-closed.

## Décision preset

Coder un preset OVH uniquement si :

- auth OK ;
- route compatible avec l’adapter actuel ;
- au moins un modèle texte stable confirmé ;
- streaming confirmé ;
- limitations documentées dans le playbook ;
- policy client recommande explicitement OVH pour `internal` / `confidential`.

## Preset proposé après validation

Nom visible : `OVHcloud AI Endpoints`

Slug conseillé : `souverain-standard`

Base URL candidate : `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1`

Protocole : OpenAI-compatible, à confirmer selon route utilisée (`responses` vs `chat/completions`).

Modèle par défaut : à renseigner après test live.

## Notes de test

```text
Date :
Projet OVH :
Région :
Clé utilisée : jamais stocker ici
Modèles testés :
Résultats :
Décision preset : GO / NO-GO
```
