# Inqom operator guidance — 4 octobre 2026

Travail isolé DEV, baseline runtime vérifiée par SHA-256, 34 tests exécutés et reproduction du blocage réel avant/après. Promotion limitée de scripts CLI vers INTERNE autorisée, sans runtime/container/restart. Critères et limites détaillés dans ACTIVE-WORK.json.

Qualification INTERNE vérifiée : 4 étapes passées, 4918 lignes dans 3 dossiers, 207 dossiers préparés, 5 attentes, 397 candidats écartés, 0 lot natif exécutable. 38 tests DEV, 9/14/7 contrôles runtime passés. 7 suivis expert conservés entre cycles. Les 6 corrections natives / 7 lettrages / 11 lignes fermées sont relus, banque inchangée sur les 6 lignes sources. Aucun redémarrage. Lancement complet bloqué par revue automatique ; autorisation explicite demandée.

5 octobre : autorisation explicite du cycle complet reçue. Exécution Temporal vérifiée, 24 étapes, blocage reproduit sur trois comptes 473 en attente. 16 tests du contrat de suivi passent avec 38 régressions existantes. Le nouveau contrôle conserve FAIL comptable et la clôture incomplète, exige couverture native/solde/file sans mutation, et laisse poursuivre les recherches indépendantes. Delta concurrent qualification conservé. Aucun redémarrage.

Second blocage reproduit : le test du nettoyeur rejoue run_autonomous_cleaner et exige FAIL→PASS même pour les trois soldes documentés. Correction minimale du test : vérification du rapport existant et du contrat natif, erreurs/dérive/effets non relus toujours bloquants. 6 tests supplémentaires passés, total 60.
