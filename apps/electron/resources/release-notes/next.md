# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- **Robb Agents Remote sur mobile** — le mode serveur embarque désormais l’app web mobile, génère un QR code à usage unique depuis les réglages, limite chaque téléphone aux espaces présents sur l’ordinateur et permet de révoquer son accès immédiatement.
- **Tâches Robb durables** — les workflows affichent désormais leur contrat canonique, graphe de dépendances, sessions liées, preuves, prochaine action et réparation ciblée, avec archive réversible et projections Craft Tasks, Google Tasks et Temporal.

## Improvements

- **Mises à jour proposées avant téléchargement** — Robb Agents vérifie les nouvelles versions stables au démarrage, affiche la version disponible et attend une confirmation explicite avant de télécharger puis d’installer la mise à jour.
- **Santé des serveurs long-running** — les processus agents et WhatsApp ont une limite d’inactivité, un nettoyage d’arbre, un suivi CPU/mémoire, une détection d’orphelins et un rapport de santé récurrent.

## Bug Fixes

- **Sessions locales avec accès distant TLS** — l’app de bureau utilise désormais `wss://` pour son propre serveur lorsque le mode distant TLS est activé, au lieu d’échouer au chargement des sessions avec une connexion `ws://` incompatible.

## Breaking Changes
