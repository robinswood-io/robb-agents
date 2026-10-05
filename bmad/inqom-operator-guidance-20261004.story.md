# Consignes comptables opérateur et preuves du cycle

Critères vérifiés :

- Les files expert cohérentes continuent ; les files incohérentes ou mutantes restent bloquées.
- Une preuve terminale ancienne ne transforme pas un cycle interrompu en succès.
- Les consignes sont consommées à chaque cycle, avec lecture paginée des trois dossiers sur toute la période 2026 disponible.
- Les lignes déjà lettrées et les réimports exacts identifiés sont exclus du rapprochement par simple montant.
- EDF annuel, facture complète Antonini, JLM paid_out sans contrepartie bancaire et décisions expert restent des attentes explicites.
- Le matérialiseur reste en lecture comptable seule ; banque et worker sont conservés.
- Les OD 473 existantes équilibrées sont recherchées avant création d’une charge ou d’une autre OD.
- Les réimports sont comparés aux factures et écritures consolidées antérieures ; une différence de TVA avec une OD TTC provisoire impose l’arbitrage expert.

Vérification du 5 octobre 2026 : 214 tests DEV réussis ; 27 scripts opérationnels identiques aux empreintes DEV, source 0ea3c62228e9dc101ebc105d94c72753a961bfc3. Promotion sous verrou avec sauvegarde, aucun redémarrage ; delta concurrent du pipeline conservé. Les 7 règles et 16 étapes sont consommées par le runtime à 13:20 UTC ; couverture complète de 30 périodes mensuelles, 3 dossiers, 5 404 lignes, 242 préparations et 5 attentes documentées. Les préparations ne constituent pas des autorisations de mutation.

Relecture native à 13:25 UTC : 17 OD équilibrées et uniques, 18 groupes de lettrage équilibrés, 23 lignes sources fermées, 7 lignes bancaires contrôlées conservées. Dix factures réimportées neutralisées : 3 097,20 EUR TTC, dont 371,20 EUR de TVA dupliquée. Écritures canoniques, anciens lettrages DYLAN/JLM, charge WEMIND et TVA MaxiCoffee de septembre préservés. Détail : inqom-operator-guidance-20261005-verification.json et rapport natif opérationnel.

Limite utilisateur : livres non clôturés. Dernier cycle complet à 12:32 UTC arrêté après 24 étapes sur les règles strictes des comptes dépréciés et du compte erroné. Restent la parité fiscale MaxiCoffee/NEWREST, BIP & GO, carburant, les pièces et décisions documentées. Ne pas masquer ce résultat avec le succès des tests DEV ou du matérialiseur. Orion affiche Échec ; planification active, prochain cycle 12 octobre 06:35.

Complément Laure de septembre envoyé et vérifié (1a10b8e27107f635), collecte annuelle Réseau Entreprendre envoyée et vérifiée (1a10b3fce19a9795). Demande WEMIND et dossier d’arbitrage à Laure préparés ; accord spécifique d’envoi encore attendu.
