# Notes de source — Audit agentique Robb 2026

## Mission du rapport

- Question : comparer Robb Agents aux technologies agentiques structurantes les plus récentes et recommander les prochaines évolutions.
- Audience : parties prenantes produit et techniques.
- Périmètre : dépôt local Robb Agents 0.12.6 au commit `434f57f37d7ed68a630b82ffe4daad0434c047d3`.
- Date de coupe : 27 août 2026.
- Baseline de comparaison : technologies et spécifications publiques disponibles à cette date.
- Décision visée : ordre d’investissement produit/architecture pour les 12 prochains mois.

## Rubrique de scoring

Le score 0–5 est un jugement d’audit, pas une mesure d’usage :

- 0 : absent ;
- 1 : idée ou document seulement ;
- 2 : fondation ou simulation locale ;
- 3 : capacité fonctionnelle/testée, mais partiellement branchée ou non qualifiée ;
- 4 : capacité produit branchée et largement vérifiée localement ;
- 5 : frontière technique qualifiée en conditions réelles avec preuves externes et SLO.

Le score global `66/100` est la moyenne non pondérée des dix domaines (`3,3/5`) multipliée par 20. Il est destiné à comparer les écarts internes, pas Robb à un classement marché.

## Preuves locales inspectées

- `README.md`, `package.json`, workspaces et historique Git ;
- `docs/robinswood/breaking-and-game-changers-implementation-2026-08-20.md` ;
- `docs/robinswood/autonomy-research-2026-08-12.md` ;
- `docs/robinswood/market-roadmap-execution-plan-2026.md` ;
- `docs/robinswood/mission-orchestration-v2.md` et `mission-v2-evaluation.md` ;
- `docs/robinswood/mcp-2026-dual-era.md` ;
- `docs/robinswood/enterprise-mission-foundation-v1.md` ;
- `packages/server-core/src/missions/` ;
- `packages/shared/src/interop/` ;
- `packages/shared/src/projects/memory-v2.ts` ;
- `packages/shared/src/governance/` ;
- `packages/shared/src/telemetry/execution-telemetry.ts` ;
- `packages/shared/src/evals/eval-gate.ts` ;
- `packages/session-tools-core/src/runtime/` et `handlers/script-sandbox.ts` ;
- appels réels de Proof Passport, OTLP, mémoire projet, router shadow et UI Mission.
- `audit-datasets.sql`, qui matérialise exactement les trois datasets bornés du rapport et recalcule le score global.

Constats de branchement importants :

- `createAgentInteropAdapters` n’a pas de call site produit hors tests/conformance ; A2A et AG-UI sont donc évalués comme contrats internes, pas comme surfaces livrées.
- `appendProjectMemoryEntry` n’a pas de call site runtime hors tests ; la mémoire v2 est relue dans le contexte projet mais n’est pas auto-alimentée.
- Verified Learning possède un store et un contrat signés, mais le bilan d’implémentation documente l’absence de RPC/UI et d’auto-publication.
- Proof Passport, execution proofs et OTLP ont des call sites runtime et des surfaces UI/RPC.

## Vérification ciblée exécutée

Commande :

```sh
bun run validate:versions
bun test packages/shared/src/projects/__tests__/memory-v2.test.ts \
  packages/shared/src/interop/agent-interop.test.ts \
  packages/shared/src/interop/protocol-conformance.test.ts \
  packages/shared/src/mcp/protocol-eras.test.ts \
  packages/shared/src/evals/eval-gate.test.ts \
  packages/shared/src/governance/verified-learning.test.ts \
  packages/shared/src/telemetry/execution-telemetry.test.ts \
  packages/session-tools-core/src/handlers/script-sandbox.test.ts \
  packages/server-core/src/missions/MissionRuntime.test.ts \
  packages/server-core/src/missions/MissionDigitalTwinIntegration.test.ts \
  packages/server-core/src/missions/MissionProofPassportService.test.ts \
  packages/server-core/src/missions/BrokeredMissionConnectorExecutor.test.ts
```

Résultat : version workspace 0.12.6 valide ; 89 tests réussis, 0 échec, 367 assertions, durée 3,20 s.

Cette campagne est ciblée. Elle ne remplace pas `bun test`, `validate:ci`, les builds Electron, les paquets multi-OS, les canaris fournisseurs ou les pilotes externes.

## Sources primaires externes

- MCP 2026-07-28 : <https://blog.modelcontextprotocol.io/posts/2026-07-28/>
- MCP roadmap, août 2026 : <https://blog.modelcontextprotocol.io/posts/mcp-roadmap/>
- A2A 1.0 : <https://a2a-protocol.org/latest/announcing-1.0/>
- A2A specification : <https://a2a-protocol.org/latest/specification/>
- AG-UI : <https://docs.ag-ui.com/>
- OpenAI Agents SDK, harness et sandbox : <https://openai.com/index/the-next-evolution-of-the-agents-sdk/>
- OpenAI Responses API et environnement : <https://openai.com/index/equip-responses-api-computer-environment/>
- Anthropic Managed Agents : <https://www.anthropic.com/engineering/managed-agents>
- Anthropic Agent Skills : <https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills>
- Anthropic context engineering : <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- Anthropic containment : <https://www.anthropic.com/engineering/how-we-contain-claude>
- Anthropic agent evals : <https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents>
- OpenTelemetry GenAI : <https://opentelemetry.io/blog/2026/genai-observability/>
- Amazon Bedrock AgentCore Policy : <https://aws.amazon.com/bedrock/agentcore/faqs/>
- Google AP2 : <https://blog.google/products-and-platforms/platforms/google-pay/agent-payments-protocol-fido-alliance/>
- UCP : <https://ucp.dev/2026-04-08/specification/overview/>
- IETF draft AIP : <https://datatracker.ietf.org/doc/draft-aip-agent-identity-protocol/>

## Carte de visualisation

- Section : maturité par domaine.
- Question : où Robb est-il proche de la frontière et où sont les écarts ?
- Forme : comparaison, barres catégorielles verticales avec libellés courts et détail dans la table adjacente.
- Champs : `domain`, `score`, avec `position` et `priority` en tooltip.
- Takeaway : noyau Mission/gouvernance fort ; multi-hôte, connecteurs réels et productisation interop plus faibles.
- Palette : racine unique gérée par le renderer natif ; aucune distinction ne dépend uniquement de la couleur.
- Surface : chart natif dans le rapport HTML portable.

Les tableaux sont utilisés pour l’audit exact et la feuille de route, car les textes de position, d’écart et de gate sont essentiels et ne seraient pas honnêtement résumés dans un graphique.

## Structure du rapport

La spécification exécutive est mappée ainsi :

1. Titre : `Robb face à la frontière agentique 2026` ;
2. Executive Summary : bloc dédié immédiatement après le titre ;
3. Key findings : positionnement, maturité, comparaison game changers ;
4. Recommended next steps : narration et table de roadmap ;
5. Further questions : quatre décisions de positionnement ;
6. Caveats and assumptions : périmètre, caractère qualitatif, tests ciblés et gates externes.

## Limites

- Aucun binaire Robb, profil production ou service managé n’a été lancé.
- Aucune mutation externe, publication, installation ou release n’a été effectuée.
- Les dernières preuves exhaustives documentées concernent la campagne 0.12.3 des 20–21 août ; l’audit courant a vérifié la version 0.12.6 avec une campagne ciblée.
- Les affirmations de marché n’utilisent pas de sources secondaires ; cela réduit la couverture des données d’adoption mais augmente la fiabilité technique.
