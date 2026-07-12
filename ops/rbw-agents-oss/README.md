# RBW Agents OSS

Stack open source multi-agents (CLI-first) installée sous `/srv/rbw-agents-oss`.

## Statut actuel — 2026-04-27
- **Source de vérité runtime** : `/srv/rbw-agents-oss` sur `interne`
- **Miroir local modifiable** : `local-sources/rbw-oss-control/oss`
- **Schedules configurés et contrôlés** : 139
- **Schedules actifs live** : 139 / 139
- **Migration opérationnelle** : terminée
- **Wrappers au manifeste** : 193 / 193 catalogués en v2
- **Contrat OSS** : `checked=33`, `errors=0`, `warnings=0`
- **Smoke suite OSS** : `ok=true`
- **Backlog OSS live** : `blockedOrDegraded=0`, `stale=0`
- **Backlog événementiel restant** : aucun (event-bridge v2.1 activé, labels appliqués via métadonnées de session)

## Démarrage rapide
```bash
cd /srv/rbw-agents-oss/compose
cp .env.example .env
# éditer .env avec vraies clés OVH/OpenRouter
docker compose up -d
```

## UIs de contrôle (local host)
- Temporal UI: http://127.0.0.1:18080
- LiteLLM API: http://127.0.0.1:14000
- Grafana: http://127.0.0.1:13001
- Prometheus: http://127.0.0.1:19090
- NATS monitor: http://127.0.0.1:18222

## Références de clôture
- `runbooks/final-migration-closure-2026-04-15.md`
- `runbooks/oss-final-autonomy-closure-2026-04-27.md`
- `runbooks/oss-final-autonomy-closure-2026-04-27.json`
- `runbooks/legacy-migration-control-2026-04-14.md`
- `config/agents/legacy-migration-control.json`
- `config/temporal/ready-schedules.json`

## Fallback navigateur local (hybride)
- Les formulaires web non gérables côté OSS navigateur sont d'abord documentés par `scripts/web_form_submitter_real.py`.
- Artefacts produits côté runtime :
  - `campaigns/ops/web-form-submitter-pack.md`
  - `campaigns/ops/local-browser-form-queue.json`
- Une automation Craft locale dédiée (`local-browser-form-fallback`) lit cette file, ouvre le navigateur local via `browser_tool`, tente le remplissage des formulaires publics supportés (Airtable, Tally, Typeform, Google Forms, Jotform), puis journalise le résultat côté serveur.
- Un registre stable d'assets speaker côté poste local (`campaigns/assets/speaker-form-assets.json`) permet de référencer la photo 1000x1000 disponible et de bloquer proprement les soumissions tant qu'un lien vidéo speaker anglais vérifié manque.
- Les cas `requires_payment`, portails privés/ambiguës, captchas ou uploads restent bloqués pour revue manuelle contrôlée.

## Scripts migration
- `scripts/extract_prompt_packs.py`
- `scripts/build_temporal_schedule_manifest.py`

## Hardening & contrôle OSS (vagues 1+2+3+)
- `config/oss-status-taxonomy.json` — taxonomie canonique des statuts d'exécution et de blocage
- `config/oss-wrapper-capabilities.json` — manifest de capacités généré depuis le manifest d'exécution + la cartographie d'automations
- `scripts/build_wrapper_capabilities.py` — régénère le manifest de capacités
- `scripts/oss_backlog_dashboard.py` — produit le tableau de backlog opérationnel (`campaigns/ops/oss-backlog-dashboard.*`)
- `scripts/oss_contract_audit.py` — vérifie les contrats de sortie `standard-v1` (`campaigns/ops/oss-contract-audit.*`)
- `scripts/oss_smoke_tests.py` — exécute la smoke suite contrôle/qualité (`campaigns/ops/oss-smoke-tests.*`)
- `scripts/oss_regression_watchdog.py` — régénère les artefacts critiques, contrôle la cible fully-green (`33/33`, `blockedOrDegraded=0`, `stale=0`) et écrit `campaigns/ops/oss-regression-watchdog.*`
- `scripts/server_digest_real.py` — relaie désormais l'état du watchdog anti-régression dans les digests quotidiens / hebdomadaires
- vague suivante livrée sur Night Agent / finance sync / wrappers événementiels de labels / mémoire partagée / AO review watch / speaker-CFP

## UI publique OSS
- URL publique : `https://oss-agents.rbw.ovh`
- surface exposée : **Temporal UI**
- endpoint de vérification : `https://oss-agents.rbw.ovh/healthz`

## Wrappers standardisés `standard-v1`
- `campaign-governance-master`
- `pr-campaign-avant-le-flow`
- `conference-prospection-daily`
- `triage-emails-multi-sources-master`
- `web-form-submitter`
- `server-daily-digest`
- `server-weekly-digest`
- `shared-memory-sync`
- `memory-capture-post-session`
- `ao-sellsy-review-watch`
- `2bfe5f`
- `night-agent-daily-report`
- `night-agent-alerts`
- `gc-inqom-sync-weekly`
- `cb77bc`
- `post-flag-auto-review`

<!-- ARCHITECTURE_V2_BEGIN -->
## Architecture agents v2 — 2026-07-12

- Runtime typé : `packages/rbw_agent_runtime/` (Pydantic 2).
- Catalogue modulaire : `config/agents-v2/catalog-v2.json` et fragments par domaine.
- CLI : `PYTHONPATH=/srv/rbw-agents-oss/packages /srv/rbw-agents-oss/.venv/bin/python -m rbw_agent_runtime doctor`.
- Temporal : cache mtime, policy preflight, backend `argv` pour les nouvelles specs et adaptateur `legacy_shell` explicite.
- Inconnu/non-script : fail-closed, jamais de succès skeleton.
- Guard : `scripts/oss_architecture_v2_guard.py`, intégré au release gate.
- Baseline migrée : 193 wrappers et 139 schedules, sans changement de cadence.
<!-- ARCHITECTURE_V2_END -->
