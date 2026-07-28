# Preuve de paquet macOS arm64 — 2026-07-27

## Périmètre

Construction locale non signée destinée uniquement à la qualification du
contenu, du montage et du démarrage. Aucun artefact n'a été publié ni présenté
comme installateur de production.

Commande exécutée :

```bash
ROBB_PACKAGE_LAUNCH_SMOKE=1 bash apps/electron/scripts/build-dmg.sh arm64
```

## Résultats observés

- installation figée : 1 448 installations contrôlées, aucun changement ;
- runtime Bun arm64 : archive officielle vérifiée par SHA-256 ;
- build Electron : processus principal, preload, renderer, ressources,
  serveur Pi/Vibe ACP et worker WhatsApp générés ;
- paquet : 947 fichiers, 734,8 MiB décompressés ;
- métadonnées : `Robb Agents`, identifiant `io.robinswood.robbagents` ;
- architecture : arm64 ;
- DMG : 258,0 MiB, montage en lecture seule réussi ;
- ZIP : 258,7 MiB ;
- lancement : application maintenue active 12 secondes dans un profil isolé,
  puis arrêtée proprement ;
- résultat du smoke test : code retour 0.

Empreintes locales :

```text
0d19b5a3fbd1e0ffa3ff99ddc17661ff29d03e32809f29d6334853a3d2610dbb  Robb-Agents-arm64.dmg
d0963a492af7a17a4916bd1fbf56b7521b6a6778151e4ee64266df19c0da15d4  Robb-Agents-arm64.zip
```

## Signature et secrets

Le paquet utilise une signature ad hoc locale. Le pré-vol confirme la présence
de la configuration hardened runtime, des entitlements et de `notarytool`, mais
aucune identité Developer ID valide, aucun `APPLE_TEAM_ID` et aucune
authentification de notarisation ne sont disponibles.

Gitleaks 8.30.1 a signalé une seule correspondance `gcp-api-key` dans le worker
WhatsApp généré. L'origine a été tracée au dictionnaire de tokens du protocole
binaire de `@whiskeysockets/baileys` 6.7.23. Il ne s'agit ni d'une variable de
configuration Robb Agents ni d'un secret fourni par un opérateur. L'exception
est limitée à cette règle et à ce seul chemin de paquet ; les autres règles et
fichiers restent contrôlés. Après cette qualification ciblée, le nouveau scan
des 346,99 MB de contenu pertinent du paquet retourne zéro fuite.

## Limite

La distribution à des utilisateurs finaux reste interdite tant que la chaîne
`--release` n'a pas produit et vérifié une signature Developer ID, une
notarisation Apple et un ticket agrafé.
