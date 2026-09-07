# Staging local : autonomie — 7 septembre 2026

**Incident ultérieur résolu :** une modification directe de l’archive par une tâche a empêché les ouvertures suivantes. Le candidat intact a été restauré, la reprise responsable arrêtée et le contrôle manquant ajouté. Voir le [rapport de réparation](</Users/thibault/Documents/Robb Agents/docs/robinswood/reports/staging-launch-repair-2026-09-07/README.md>).

**Installé et lancé, avec deux réserves de qualification : mémoire et console WING absente.**

Cible : `/Applications/Robb Agents.app`, identité `io.robinswood.robbagents`, version `0.12.6`, canal production utilisé pour le staging local. Profil réel : `~/.craft-agent` ; runtime confirmé par son nouveau PID dans `~/.craft-agent/robb-electron/.server.lock`.

Commit embarqué : `eaf673c998b178102115adf457c931aad98902b0`. Archive ASAR installée : `a27d9d35d14dbe8b9fd7dda225eb8d70503654ad837932da1f774961409651e4`.

## Livraison

Les six axes de l’[implémentation d’autonomie](</Users/thibault/Documents/Robb Agents/docs/robinswood/reports/autonomy-implementation-2026-09-07/README.md>) sont inclus : critères de réussite observables, reprise durable, contrats d’outils, coordination persistante, mémoire vérifiée et protocole de comparaison humaine.

Le code a été figé dans un worktree isolé sur `codex/staging-autonomy-20260907`. Le workspace et l’index originaux ont été conservés. Construction depuis un commit propre, avec la commande imposée :

```sh
bash apps/electron/scripts/build-dmg.sh arm64 --local-production
```

La recette a révélé un défaut supplémentaire dans `sources:getMcpTools` : les variables de source et les substitutions propres à la plateforme étaient transmises littéralement aux processus. La résolution utilise désormais le même utilitaire que les agents. Deux tests lancent de vrais serveurs MCP de test ; ils échouaient avant le correctif et passent après. Le correctif et les tests sont également présents dans le workspace principal.

## Vérifications

| Contrôle | Résultat |
|---|---|
| Autonomie | 304 tests passés, scénarios E01–E16 couverts |
| Correctif MCP et chemins | 5 tests passés, dont 2 nouvelles régressions avec sous-processus |
| TypeScript | `server-core` valide après le correctif ; validation complète de l’implémentation conservée dans le rapport Dev |
| Contrats de release / paquet | 54 + 21 tests passés |
| Installateur | 9 passés, 1 ignoré selon la plateforme |
| Paquet final | Smoke test, signature ad hoc, intégrité ASAR, ressources externes, provenance du worker et montage DMG valides |
| Installation | Empreinte du bundle installé identique au candidat, commit final confirmé |
| Sessions | 1 049 chats, 200 786 messages originaux conservés ; 3 historiques chargés par le serveur installé |
| Connexions / sources | 4 connexions authentifiées, 31 sources retrouvées |
| Navigateur | 526 cookies avant et après ; profil réel conservé |
| MCP | 18 sur 19 répondent, 674 outils listés en lecture seule |
| Documents | PDF créé et rendu en PNG avec les wrappers du bundle installé |
| Fenêtre | Bundle attendu actif et fenêtre visible via les API macOS existantes |

Les sessions actives ont repris après les fermetures propres ; les cinq journaux modifiés conservent leurs messages antérieurs. Aucune opération métier ni aucun message de test n’a été envoyé par les vérifications.

## Réserves ouvertes

1. **Mémoire** : le dernier contrôle retourne `unhealthy`, avec un heap de **1,77 Go** pour un seuil de **1,5 Go**. Le gestionnaire de sessions répond ; les processus suivis ne présentent ni échec ni orphelin. Cette observation ne permet pas d’attribuer une fuite ou une régression à ce changement. La qualification prolongée sous charge reste ouverte.
2. **`ingenierie-son`** : après correction du chemin, son démarrage atteint la découverte matérielle, puis échoue car la console WING portant l’identité configurée n’est pas détectée. Le contrôle d’identité matériel est conservé. Une console disponible est nécessaire pour terminer cette vérification.
3. **Runtime documentaire** : `uv` n’est pas embarqué ; le repli sur le `uv` présent dans PATH fonctionne sur ce Mac et le rendu PDF installé a été contrôlé. La portabilité vers un Mac sans ce runtime reste distincte.
4. **Interface** : la présence de la fenêtre et les lectures applicatives sont confirmées. Le parcours visuel complet dans Electron n’a pas été exécuté. La revue automatique a refusé le port CDP temporaire ; il a été retiré. Les vérifications utilisent le serveur TLS déjà configuré, avec certificat vérifié et jeton conservé en mémoire.
5. La comparaison humaine indépendante reste à mesurer. Cette installation ne certifie aucune autonomie universelle ni supériorité générale.

## Sauvegarde et retour arrière

[Sauvegarde restaurable](</Users/thibault/Library/Application Support/Robb Agents/Staging Backups/20260907-autonomy-3633f7e5/README.md>) : ancien bundle signé vérifié, copie indépendante du profil par clones APFS et point de sauvegarde supplémentaire des fichiers persistants avant le candidat final. Les 1 087 fichiers critiques du point de sauvegarde sont vérifiés par SHA-256.

Le script `restore-previous-staging.py`, joint à la sauvegarde, contrôle les empreintes, ferme proprement le staging, restaure l’ancien bundle et conserve le profil actuel ainsi que le candidat remplacé. Il est préparé et sa syntaxe est vérifiée ; le retour arrière n’a pas été exécuté. Une restauration du profil complet est une opération distincte, afin de préserver les travaux apparus depuis la sauvegarde.

Aucune GitHub Release, publication, signature Developer ID ou notarisation publique n’a été créée. Le paquet ad hoc reste strictement local. La recette utilisateur et les réserves ci-dessus restent visibles avant toute promotion publique.

## MCP contrôlés

| Source | Résultat |
|---|---|
| `apple-messages-codes` | OK — 3 outils |
| `atria-microsoft-365` | OK — 14 outils |
| `atria-sellsy` | OK — 16 outils |
| `auto-ads-bundle` | OK — 4 outils |
| `bmb-sellsy` | OK — 16 outils |
| `comptabilite` | OK — 49 outils |
| `gocardless` | OK — 41 outils |
| `google-contacts` | OK — 239 outils |
| `ingenierie-son` | Indisponible — console WING attendue non détectée |
| `inqom` | OK — 117 outils |
| `jlm-microsoft-365` | OK — 4 outils |
| `marketing` | OK — 84 outils |
| `mlx-whisper` | OK — 7 outils |
| `plc-microsoft-365` | OK — 11 outils |
| `rbw-agents-oss` | OK — 12 outils |
| `rbw-servers` | OK — 37 outils |
| `sky-scrapper` | OK — 6 outils |
| `whatsapp` | OK — 6 outils |
| `wordpress-pierre-ceram` | OK — 8 outils |

Les [résultats structurés](</Users/thibault/Documents/Robb Agents/docs/robinswood/reports/staging-autonomy-2026-09-07/verification.json>) donnent les empreintes des preuves. Les journaux détaillés restent dans le dossier privé de sauvegarde.
