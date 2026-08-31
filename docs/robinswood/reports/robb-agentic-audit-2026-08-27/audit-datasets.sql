-- Reproducible materialization of the three bounded report datasets.
-- The qualitative judgments and their evidence are documented in source-notes.md.

CREATE TEMP TABLE maturity (
  domain TEXT NOT NULL,
  chart_domain TEXT NOT NULL,
  score REAL NOT NULL,
  position TEXT NOT NULL,
  gap TEXT NOT NULL,
  priority TEXT NOT NULL
);

INSERT INTO maturity VALUES
  ('Missions durables et reprise', 'Missions', 4.5, 'Runtime, réservations, retries, recovery, replan et Control Room branchés.', 'SLO end-to-end et charge réelle non qualifiés.', 'P0 — instrumenter et piloter'),
  ('Gouvernance, mutations et preuves', 'Gouvernance', 4.5, 'Capabilities, approbations exactes, WAL, idempotence, rapprochement et passeports Ed25519.', 'Ancres organisationnelles et connecteurs réels non qualifiés.', 'P0 — productiser la boucle de confiance'),
  ('Skills, contexte et mémoire', 'Skills/mémoire', 3.5, 'Skills progressifs et obligatoires ; mémoire v2 structurée, temporelle et locale.', 'Le runtime ne propose ni n’alimente automatiquement la mémoire v2 ; index sémantique optionnel seulement.', 'P0 — Context Engine v3'),
  ('Évaluations et observabilité', 'Evals et OTLP', 3.5, 'Gates multi-graders, intervalles de confiance et OTLP corrélé avec redaction.', 'Pas de backend opéré ni de producteur d’outcomes durable à l’échelle production.', 'P0 — Trust Loop'),
  ('UX agentique et supervision', 'UX/supervision', 3.5, 'Control Room, approvals, navigateur intégré, WebUI distante et WhatsApp.', 'Pas de surface AG-UI/generative UI commune ni de benchmark GUI hybride.', 'P1 — surface événementielle unifiée'),
  ('Interopérabilité ouverte', 'Interop', 3.0, 'MCP 2026 dual-era et tests A2A 1.0/AG-UI sur un modèle canonique.', 'A2A et AG-UI sont des adaptateurs internes non exposés par le produit.', 'P0 — Interop Gateway'),
  ('Sandbox et plan d’exécution', 'Sandbox', 3.0, 'Isolation réseau/fichiers fail-closed pour script_sandbox sur macOS/Linux.', 'Pas de quotas CPU/RAM/disque multi-OS ni d’interface sandbox indépendante par Mission.', 'P0 — Sandbox Provider Interface'),
  ('Routage modèles et économie', 'Routage', 3.0, 'Policy-first, fallbacks, outcomes durables, drift et recommandations shadow.', 'Peu de ground truth réel ; aucune promotion canary branchée en production.', 'P1 — router outcome-aware qualifié'),
  ('Connecteurs et outcomes réels', 'Connecteurs', 2.5, 'Broker sécurisé et pack financier qualifié hors ligne.', 'Aucun tenant Microsoft/Google réel muté et réconcilié dans la campagne auditée.', 'P0 — pilotes limités réels'),
  ('Mesh multi-hôte et control plane', 'Mesh', 2.0, 'Identités, attestations, leases, fencing et failover simulés localement.', 'Pas d’IdP, control plane ni essai deux hôtes réels.', 'P1 — qualification distribuée');

SELECT domain, chart_domain, score, position, gap, priority
FROM maturity
ORDER BY score DESC, domain ASC;

SELECT ROUND(AVG(score) * 20, 0) AS overall_score_100
FROM maturity;

CREATE TEMP TABLE frontier (
  rank INTEGER NOT NULL,
  technology TEXT NOT NULL,
  frontier TEXT NOT NULL,
  robb TEXT NOT NULL,
  decision TEXT NOT NULL
);

INSERT INTO frontier VALUES
  (1, 'MCP 2026-07-28 + Tasks', 'Cœur stateless, routage par headers, listes cacheables, MRTR et extension Tasks officielle.', 'Très bien aligné : SDK v2 scindé, négociation dual-era et conformance Tasks ; défaut SDK amont gardé fail-closed.', 'Achever l’exposition production et tester contre au moins deux implémentations réelles.'),
  (2, 'A2A Protocol 1.0', 'Découverte d’agents, délégation, tâches longues et compatibilité inter-organisations.', 'Contrat interne et conformance existent, mais aucun endpoint AgentCard/tâches n’est branché dans le produit.', 'Livrer une passerelle opt-in au-dessus de Mission, sans adopter A2A comme modèle interne.'),
  (3, 'AG-UI et UI générative', 'Flux standard de run, messages, outils, état, interrupts et interactions frontend.', 'Adaptateur et validation d’événements présents ; Electron, WebUI et mobile utilisent encore des contrats propriétaires.', 'Unifier les surfaces temps réel via AG-UI ; garder MCP Apps/A2UI comme formats de rendu optionnels.'),
  (4, 'Meta-harness brain / hands / session', 'Le harness, l’état durable et les sandboxes évoluent et échouent indépendamment.', 'Mission et sessions sont durables, mais le provider et l’environnement d’exécution ne sont pas encore une interface sandbox portable par Mission.', 'Créer un SandboxProvider et externaliser explicitement snapshots, leases, artefacts et secrets.'),
  (5, 'Agent Skills + context engineering', 'Divulgation progressive, scripts déterministes et expertise portable chargée à la demande.', 'Alignement fort : découverte multi-niveaux, SKILL.md obligatoire avant outils et validation locale.', 'Ajouter evals de skills, provenance, versions et promotion depuis des outcomes prouvés.'),
  (6, 'Mémoire hybride et apprentissage vérifié', 'Mémoire structurée, retrieval lexical+sémantique, validité temporelle et feedback mesuré.', 'Le journal v2 est solide et accepte des scores vectoriels, mais aucune boucle runtime ne l’alimente automatiquement.', 'Introduire des propositions de mémoire revues, ACL/provenance, index local et métriques d’utilité.'),
  (7, 'Containment et policy gateway', 'Permissions évaluées hors modèle, confinement OS, egress borné et credentials hors sandbox.', 'Très fort sur policy et mutations ; sandbox de scripts limitée et sans quotas de ressources complets.', 'Étendre le même modèle de confinement à toutes les hands, MCP et sous-agents.'),
  (8, 'OTel GenAI + trace grading', 'Traçage standardisé du modèle, outils, tokens, coûts et outcomes avec contenu opt-in.', 'OTLP corrélé et redacted existe ; l’exploitation et les dashboards de fiabilité restent externes.', 'Adopter les semconv courantes, relier Mission/Task/Tool/Proof et grader les traces sur corpus réels.'),
  (9, 'Computer use hybride DOM + vision', 'Choix dynamique entre API, DOM/accessibility et vision, vérifié par état backend.', 'Navigateur intégré avec snapshot, clic, saisie et screenshot ; pas de benchmark de sélection de modalité.', 'Créer un router d’interaction et des evals WebArena/OSWorld-like centrées sur l’état final.'),
  (10, 'AP2 / UCP et identité agentique', 'Mandats cryptographiques, reçus et protocoles verticaux pour commerce et paiements agents.', 'Proof Passport et approvals payload-bound offrent une base conceptuelle proche ; aucun adaptateur vertical standard.', 'Surveiller et prototyper seulement si la verticale financière devient le marché prioritaire.');

SELECT rank, technology, frontier, robb, decision
FROM frontier
ORDER BY rank ASC;

CREATE TEMP TABLE roadmap (
  rank INTEGER NOT NULL,
  priority TEXT NOT NULL,
  horizon TEXT NOT NULL,
  evolution TEXT NOT NULL,
  outcome TEXT NOT NULL,
  gate TEXT NOT NULL
);

INSERT INTO roadmap VALUES
  (1, 'P0', '0–90 jours', 'Trust Loop produit : Mission → OTLP → outcome → eval → passport → proposition d’apprentissage.', 'Une mission terminée est explicable, comparable et réutilisable depuis la Control Room.', '100 % des nœuds corrélés ; aucune promotion automatique ; preuve utilisateur vérifiable.'),
  (2, 'P0', '0–90 jours', 'Interop Gateway MCP 2026 / A2A 1.0 / AG-UI au-dessus du modèle Mission canonique.', 'Robb peut être runtime, client ou interface dans un écosystème multi-agents sans lock-in.', 'Deux implémentations externes réelles par protocole, identité et plafond de permissions vérifiés.'),
  (3, 'P0', '0–90 jours', 'Context Engine v3 : propositions mémoire, retrieval hybride local, provenance, TTL, oubli et evals de skills.', 'Les agents réutilisent le bon contexte avec moins de tokens et sans mémoire silencieuse indésirable.', '−30 % tokens ou interventions, régression succès ≤ 1 point, 100 % des écritures explicables/révocables.'),
  (4, 'P0', '0–120 jours', 'Sandbox Provider Interface séparant brain, hands et session avec egress et credentials brokerés.', 'Une Mission peut reprendre dans un nouvel environnement sans élargir son blast radius.', 'Quotas CPU/RAM/disque et isolement réseau/fichiers qualifiés sur macOS, Windows et Linux.'),
  (5, 'P0', '60–150 jours', 'Pilotes réels limités Microsoft 365 et Google Workspace avec révocation et rapprochement.', 'La promesse de travail autonome dépasse les mocks et prouve un gain opérateur.', '0 mutation dupliquée sur 1 000 reprises, 100 % des écritures approuvées/réconciliées, gain > 50 %.'),
  (6, 'P1', '3–6 mois', 'Router outcome-aware avec ground truth Mission, canary et promotion humaine.', 'Robb choisit le provider selon réussite, coût et délai réels, pas seulement des règles statiques.', '≥ 500 cas ; −25 % coût ou −20 % latence ; baisse de réussite ≤ 1 point ; zéro violation policy.'),
  (7, 'P1', '3–6 mois', 'Sovereign Team Mesh qualifié avec IdP, control plane minimal et deux hôtes.', 'Les équipes distribuent l’exécution sans centraliser leurs données ni perdre la capacité de révocation.', 'Failover < 60 s, révocation < 30 s, 1 000 bascules sans mutation dupliquée.'),
  (8, 'P2', '6–12 mois', 'Adaptateurs verticaux AP2/UCP, identité agentique et WebMCP selon traction marché.', 'Robb entre dans des écosystèmes spécialisés sans fragiliser son cœur souverain.', 'Adoption seulement après stabilité du standard, demande client et threat model spécifique.');

SELECT rank, priority, horizon, evolution, outcome, gate
FROM roadmap
ORDER BY rank ASC;
