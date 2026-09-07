# Protocole de comparaison humaine à compléter avant la collecte

Ce document est un canevas de protocole, sans mesure de performance.

1. Définir les domaines métier précis et les tâches admissibles, puis figer la version du système, ses outils, son modèle et ses permissions dans le dossier de l’évaluation.
2. Réserver au moins 30 familles indépendantes par domaine, exclues de l’entraînement, de la conception des prompts et du développement des corrections. Une variante d’une tâche existante ne constitue pas une nouvelle famille.
3. Pour chaque cas, conserver l’entrée identique et les mêmes ressources accessibles ; recruter au moins trois professionnels indépendants. Fixer les limites de temps et le plafond de coût de l’agent avant les essais.
4. Définir une grille de qualité sur 100 points : exactitude du résultat, complétude de l’objectif, utilisabilité et conformité aux critères métier. Fixer les pondérations propres au domaine avant tout essai. Faire noter les livrables à l’aveugle.
5. Mesurer séparément temps écoulé et coût, avec une méthode comptable commune explicitée. Une qualité supérieure ne prouve pas un avantage économique.
6. Conserver les livrables, entrées, preuves et journaux dans des chemins relatifs au dossier du benchmark ; renseigner leurs SHA-256. Ne pas confondre le résultat d’un test unitaire avec une exécution réelle.
7. Faire attester par l’évaluateur indépendant la réalité des participants, les budgets, la séparation des familles et l’enregistrement antérieur du protocole. Signer en Ed25519 les octets UTF-8 de `JSON.stringify({protocol, cases})`. Distribuer sa clé publique par un canal de confiance.
8. Qualifier uniquement les domaines évalués. Une borne Wilson à 95 % supérieure à 0,5 sur les victoires en qualité face au quartile humain supérieur, avec les autres critères satisfaits, établit l’avantage observé dans ce protocole ; elle ne constitue pas une garantie universelle.
