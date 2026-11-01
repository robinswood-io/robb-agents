# Aperçu Markdown vide — correction locale ciblée

## Cause établie

`useLinkInterceptor` lit le fichier avant d'afficher l'aperçu. Si la lecture échoue,
il conserve `content: ''` et `error: <message>`. Dans `FilePreviewRenderer`, le cas
Markdown transmettait le contenu vide, mais omettait `state.error`. Le composant
`DocumentFormattedMarkdownOverlay` savait déjà afficher cette erreur : elle ne lui
parvenait donc jamais. L'utilisateur voyait uniquement une carte vide.

Reproduction réelle avant correction, dans l'application installée : le rapport
QA a été temporairement renommé, son lien ouvert, puis le rapport restauré avec
son empreinte inchangée. L'échec réel de lecture affichait un aperçu vide, sans
erreur. Aucun fichier utilisateur métier n'a été modifié.

Le premier échec observé après déverrouillage n'a pas conservé son diagnostic.
Son déclencheur exact ne peut pas être établi rétroactivement. Le transport peut
notamment rejeter une lecture lors d'une déconnexion ou d'un délai dépassé ; cela
reste une possibilité, pas une cause constatée de cet épisode.

## Correction

Deux lignes fonctionnelles dans deux composants existants :

- transmettre `error={state.error}` à l'aperçu Markdown ;
- remplacer son titre « Write Failed » par « Document unavailable », adapté à une
  erreur de lecture comme d'écriture. Le diagnostic original reste visible.

Aucun nouveau composant, état, stockage, mécanisme de reconnexion ou de retry.
La fermeture puis réouverture du lien utilise déjà la lecture normale du fichier.

## Validation

Commandes exécutées avec succès sur le checkout isolé :

```sh
rtk node scripts/run-typescript.mjs native --noEmit -p apps/electron/tsconfig.json
rtk bun test packages/ui/src/components/overlay/__tests__/rich-block-parity.test.ts packages/ui/src/components/overlay/__tests__/fullscreen-overlay-escape-stack.test.ts packages/ui/src/components/overlay/__tests__/useRichBlockInteractions.test.ts apps/electron/src/renderer/lib/__tests__/overlay-detection.test.ts
rtk git diff --check
```

Les quatre fichiers de tests totalisent 11 réussites et aucun échec. La livraison
doit aussi vérifier le cas d'erreur réel dans le bundle corrigé, la restauration
du fichier, puis une mission complète avec le modèle réel et l'ouverture de ses
livrables depuis leurs liens. Le compte rendu local distingue ces résultats de
la seule construction du paquet.

Cible : staging local sur ce Mac, profil habituel explicitement autorisé.
Rattachement Work non résolu : note versionnée et preuves locales conservées.
