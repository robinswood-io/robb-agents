# Nouvelles demandes : saturation RPC et recherche web

Cible autorisée : staging local `/Applications/Robb Agents.app`, profil habituel.
Cette correction prolonge la correction de complétion et celle de l’aperçu.
Les modifications concurrentes du dépôt principal sont conservées.

## Causes reproduites

1. Deux consommateurs préchargeant les mêmes 35 icônes émettaient 70 lectures
   simultanées avant que le cache soit rempli. Avec le vrai `WsRpcServer` et sa
   limite inchangée de 64 requêtes, un nouveau message était refusé avec
   `Too many concurrent in-flight requests (max 64)`.
2. La recherche ChatGPT utilisait un modèle fixe sans rapport avec la session.
   Sur la connexion habituelle, les modèles `gpt-5.4-mini` et `gpt-5.3-codex`
   ont été refusés en HTTP 400. Le modèle actif `gpt-6.1-sol` a été accepté.
3. Le flux de recherche fournissait le texte et les citations dans
   `response.output_item.done`, puis terminait par `response.completed` avec
   `output:[]`. Le parseur jetait les items reçus et annonçait à tort
   `Search returned no content`.

## Corrections simples

- Partager uniquement les lectures d’images encore en cours, dans le module de
  cache existant ; supprimer leur entrée à la fin, y compris en cas d’échec.
- Précharger les icônes successivement et arrêter le préchargement du composant
  démonté. Découvrir les extensions successivement en s’arrêtant au premier
  fichier existant.
- Transmettre le modèle actif au fournisseur de recherche existant, y compris
  après changement de modèle ; ne pas créer une nouvelle connexion.
- Conserver les items achevés du flux lorsque la réponse finale omet son output.
- Remplacer une assertion de type non valide dans le garde de contexte existant
  par une vérification explicite du rôle `toolResult`.

Aucune hausse de la limite RPC, file d’attente générale, retry, ordonnanceur,
nouveau fournisseur ou stockage durable ajouté.

## Preuves

- Régression transport : échec avant correction avec l’erreur exacte ; réussite
  après correction avec 35 lectures réelles pour 70 consommateurs et nouveau
  message accepté. Tests de récupération après échec et d’isolation par workspace.
- Deux régressions de recherche : échec avant correction, réussite après.
- Recherche réelle après correction : deux URL officielles OpenAI reçues, sans
  modification ni exposition des identifiants de la connexion habituelle.
- 76 tests ciblés réussis sur transport, icônes, sécurité et recherche.
- Le contrôle TypeScript Electron passe. Le package Pi utilise sa commande
  officielle `tsconfig.typecheck.json` ; `tsconfig.json` est sa configuration de
  construction et n’est pas une commande de vérification équivalente.

L’installation, les essais de démarrage et les nouvelles missions complètes sont
à consigner dans les preuves de livraison locale ; un commit seul ne les prouve pas.

## Signature macOS et autorisations

Le candidat ad hoc `48b04e18` a accepté trois nouvelles demandes dès le premier
envoi, y compris pendant une autre mission. Sa recherche WebSearch native a
réussi. Les commandes de fichiers ont ensuite attendu macOS : `tccd` rapporte
une non-correspondance des exigences de code pour Full Disk Access et Documents,
bien que le réglage d’accès complet apparaisse encore activé.

La cause récurrente est le build local qui imposait une identité ad hoc à chaque
reconstruction. Un Developer ID Application valide existe dans le trousseau de
ce Mac. Le staging avec le profil réel exige désormais cette identité stable,
sélectionnée explicitement par la variable standard `CSC_NAME`. Le build de
développement isolé garde son mode ad hoc. Le pré-vol refuse un nouveau candidat
de staging ad hoc, mais continue de vérifier les anciennes sauvegardes pour le
retour arrière. Aucun contrôle de signature n’est affaibli.

La notarisation et la publication restent désactivées pour ce staging local.
Une réautorisation macOS est nécessaire pour passer de l’ancienne identité ad hoc
à l’identité Developer ID ; les identités doivent ensuite rester stables entre
les mises à jour signées avec ce même certificat.

## Blocage Inqom distinct

La mission visible de dédoublonnage des fournisseurs utilise un connecteur
comptable distant. Son manifeste annonce des mutations désactivées par défaut,
avec gardes et approbations dédiées. La mission a effectivement recensé les
comptes puis s’est déclarée bloquée, sans annoncer un regroupement accompli.
Le guide local décrit aussi des capacités qui ne sont pas toutes disponibles via
le routage exposé. Ce constat ne donne aucune autorisation de changer les droits,
d’activer globalement les écritures ou de transférer/supprimer des données
comptables réelles. Les corrections du client ne doivent pas masquer ce blocage
ni fabriquer une réussite. Aucune opération comptable n’a été exécutée ici.
