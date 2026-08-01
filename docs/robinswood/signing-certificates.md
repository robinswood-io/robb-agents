# Certificats de signature des releases desktop

Ce guide décrit la configuration attendue par
[`release.yml`](../../.github/workflows/release.yml). Les secrets restent dans
GitHub Actions : aucun certificat, mot de passe ou fichier de clé privée ne doit
être ajouté au dépôt.

## Contrat de la release automatique

Une release publique exige :

- macOS : un certificat **Developer ID Application** et une authentification de
  notarisation Apple ;
- Windows : soit un certificat Authenticode PFX, soit **Microsoft Artifact
  Signing** (anciennement Trusted Signing) ;
- un tag stable `vX.Y.Z` correspondant exactement à la version Electron.

La voie recommandée est une clé App Store Connect pour Apple et Artifact
Signing Public Trust pour Microsoft. Le workflow reconstruit la clé Apple dans
un fichier temporaire, signe et notarise les artefacts, vérifie les signatures,
puis supprime le fichier. Artifact Signing conserve la clé de certificat dans
le service Microsoft : aucun certificat Windows privé n'est téléchargé.

## Apple : Developer ID Application

### 1. Prérequis

1. Inscrire l'organisation à l'Apple Developer Program.
2. Utiliser le compte **Account Holder** : Apple réserve la création des
   certificats Developer ID à ce rôle.
3. Noter le Team ID de dix caractères depuis le compte Apple Developer.

### 2. Créer le certificat

1. Sur le Mac qui conservera la clé privée, ouvrir **Trousseaux d'accès**.
2. Choisir **Assistant de certification > Demander un certificat à une autorité
   de certification**.
3. Renseigner l'e-mail et un nom commun, laisser l'adresse de l'autorité vide,
   sélectionner **Enregistrée sur le disque**, puis enregistrer le fichier
   `.certSigningRequest`.
4. Ouvrir [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list),
   cliquer sur `+`, choisir **Developer ID**, puis **Developer ID Application**.
   Le certificat Developer ID Installer n'est pas nécessaire pour les DMG/ZIP
   produits par Robb Agents.
5. Envoyer le CSR, télécharger le `.cer`, puis le double-cliquer. Dans
   **Mes certificats**, le certificat doit apparaître avec sa clé privée.
6. Exporter le certificat **et sa clé privée** au format `.p12`, avec un mot de
   passe fort. Conserver une copie chiffrée hors du dépôt.

Vérification locale :

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
```

### 3. Créer la clé de notarisation

1. Dans [App Store Connect](https://appstoreconnect.apple.com/access/integrations/api),
   ouvrir **Users and Access > Integrations > App Store Connect API > Team
   Keys**. Si nécessaire, l'Account Holder demande d'abord l'accès à l'API.
2. Générer une **Team Key** avec le rôle **App Manager**.
3. Noter l'Issuer ID et le Key ID, puis télécharger le fichier
   `AuthKey_<KEY_ID>.p8`. Apple n'autorise ce téléchargement qu'une seule fois.

La clé doit être une Team Key : le pipeline utilise l'Issuer ID et reste
compatible avec les runners Xcode actuels.

### 4. Configurer les secrets GitHub

Depuis la racine du dépôt :

```bash
base64 -i /chemin/DeveloperIDApplication.p12 | tr -d '\n' \
  | gh secret set MAC_CSC_LINK --repo robinswood-io/robb-agents

base64 -i /chemin/AuthKey_XXXXXXXXXX.p8 | tr -d '\n' \
  | gh secret set APPLE_API_KEY_BASE64 --repo robinswood-io/robb-agents

gh secret set MAC_CSC_KEY_PASSWORD --repo robinswood-io/robb-agents
gh secret set APPLE_TEAM_ID --repo robinswood-io/robb-agents
gh secret set APPLE_API_KEY_ID --repo robinswood-io/robb-agents
gh secret set APPLE_API_ISSUER --repo robinswood-io/robb-agents
```

Les quatre dernières commandes demandent la valeur de façon interactive. Ne
pas passer un mot de passe ou une clé directement dans la ligne de commande.

L'alternative Apple ID reste supportée avec `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` et `APPLE_TEAM_ID`, mais la Team Key est mieux
adaptée à l'automatisation.

## Microsoft : Artifact Signing Public Trust (recommandé)

Artifact Signing est le nom actuel du service Azure auparavant appelé Trusted
Signing. Pour une application Win32 publique, choisir **Public Trust**, jamais
Public Trust Test ni Private Trust.

### 1. Créer le compte et valider l'identité

1. Disposer d'un tenant Microsoft Entra ID et d'une souscription Azure. Pour
   Public Trust, Microsoft accepte actuellement les organisations des États-Unis,
   du Canada, de l'Union européenne et du Royaume-Uni. Les développeurs
   individuels ne sont acceptés qu'aux États-Unis et au Canada.
2. Vérifier que le nom légal et l'adresse du compte de facturation Azure
   correspondent exactement à l'identité qui doit figurer dans le certificat.
3. Dans Azure Portal, enregistrer le fournisseur de ressources
   `Microsoft.CodeSigning`.
4. Créer un compte **Artifact Signing**, puis une validation d'identité
   **Organization / Public**. Fournir les justificatifs demandés et attendre
   l'approbation.
5. Créer un profil de certificat **Public Trust**. Copier :
   - l'endpoint régional `https://<région>.codesigning.azure.net/` ;
   - le nom du compte ;
   - le nom du profil ;
   - le Subject/Publisher exact affiché dans l'aperçu du certificat.

### 2. Créer l'identité CI

1. Dans Microsoft Entra ID, créer une **App registration** dédiée à Robb Agents.
2. Créer un client secret à durée limitée et noter immédiatement : Tenant ID,
   Client ID et valeur du secret.
3. Sur le profil de certificat, attribuer au service principal le rôle
   **Artifact Signing Certificate Profile Signer**. Le scope au niveau du profil
   est préférable au niveau de toute la souscription.

Le workflow actuel utilise l'authentification `EnvironmentCredential` prise en
charge par electron-builder 26. Un passage ultérieur à l'OIDC GitHub/Azure
permettra de supprimer le client secret, après validation d'une version de la
chaîne de signature qui le supporte de bout en bout.

### 3. Configurer GitHub Actions

Variables non sensibles :

```bash
gh variable set WINDOWS_SIGNING_MODE --body azure --repo robinswood-io/robb-agents
gh variable set WINDOWS_AZURE_ENDPOINT --body "https://<region>.codesigning.azure.net/" --repo robinswood-io/robb-agents
gh variable set WINDOWS_AZURE_ACCOUNT_NAME --body "<account>" --repo robinswood-io/robb-agents
gh variable set WINDOWS_AZURE_CERTIFICATE_PROFILE_NAME --body "<profile>" --repo robinswood-io/robb-agents
gh variable set WINDOWS_AZURE_PUBLISHER_NAME --body "<subject exact>" --repo robinswood-io/robb-agents
```

Secrets, saisis interactivement :

```bash
gh secret set AZURE_TENANT_ID --repo robinswood-io/robb-agents
gh secret set AZURE_CLIENT_ID --repo robinswood-io/robb-agents
gh secret set AZURE_CLIENT_SECRET --repo robinswood-io/robb-agents
```

Microsoft gère la création, la rotation et le stockage HSM du certificat. Il
n'existe donc pas de `.pfx` à récupérer dans cette voie.

## Microsoft : certificat Authenticode PFX (alternative)

Cette voie est utile si l'organisation n'est pas éligible à Artifact Signing :

1. Acheter un certificat de signature de code **Organization Validation (OV)**
   auprès d'une autorité de certification reconnue par Microsoft.
2. Suivre la validation d'identité de l'autorité. Si elle autorise l'export,
   exporter le certificat et sa clé privée au format PFX/P12 avec mot de passe.
   Certains fournisseurs imposent un token matériel ou une signature distante ;
   dans ce cas, vérifier leur compatibilité CI avant l'achat.
3. Configurer :

```bash
gh variable set WINDOWS_SIGNING_MODE --body pfx --repo robinswood-io/robb-agents

base64 -i /chemin/RobbAgents-CodeSigning.pfx | tr -d '\n' \
  | gh secret set WINDOWS_CSC_LINK --repo robinswood-io/robb-agents

gh secret set WINDOWS_CSC_KEY_PASSWORD --repo robinswood-io/robb-agents
```

Un certificat auto-signé n'est pas acceptable pour une distribution publique :
Windows ne lui accorde pas une confiance publique et SmartScreen continuera à
avertir les utilisateurs.

## Contrôle et publication

Vérifier la présence des noms, jamais les valeurs :

```bash
gh secret list --repo robinswood-io/robb-agents
gh variable list --repo robinswood-io/robb-agents
```

Lancer ensuite **Build signed desktop release** dans GitHub Actions avec
`release_mode=publish-signed` et un tag existant correspondant à la version.
Le pipeline bloque automatiquement si une route est incomplète, si une clé
Apple n'est pas un PKCS#8 base64 valide, si une signature ne se vérifie pas ou
si la notarisation n'est pas agrafée au DMG.

Contrôles finaux :

```bash
# macOS
codesign --verify --deep --strict --verbose=2 "/Applications/Robb Agents.app"
spctl --assess --type execute --verbose=4 "/Applications/Robb Agents.app"
xcrun stapler validate "/Applications/Robb Agents.app"

# Windows PowerShell
Get-AuthenticodeSignature .\Robb-Agents-x64.exe | Format-List Status,StatusMessage,SignerCertificate
```

Références officielles :

- [Apple — créer un certificat Developer ID](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
- [Apple — créer une clé App Store Connect](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)
- [Apple — notariser un logiciel macOS](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Microsoft — démarrage rapide Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
- [Microsoft — rôles Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles)
- [Microsoft — modèles de confiance](https://learn.microsoft.com/en-us/azure/artifact-signing/concept-trust-models)
