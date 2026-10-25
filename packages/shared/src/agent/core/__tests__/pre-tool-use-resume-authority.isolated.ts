import { describe, it, expect, beforeEach } from 'bun:test';
import { preToolUseMocks, resetPreToolUseFixture, runPreToolUseChecks, createInput } from './pre-tool-use-fixture.ts';

describe('runPreToolUseChecks', () => {
  beforeEach(resetPreToolUseFixture);



  describe('signed synthetic resume target authority regressions', () => {
    const runReplay = (
      objective: string | readonly string[],
      toolName: string,
      input: Record<string, unknown>,
      sources = ['rbw-servers'],
      sessionId?: string,
    ) => {
      const objectiveSegments = typeof objective === 'string' ? [objective] : [...objective];
      const markerSessionId = /^\[robb-resume:([a-z0-9]+(?:-[a-z0-9]+)*):/mu
        .exec(objectiveSegments.find(segment => /^\[robb-resume:/mu.test(segment)) ?? '')?.[1];
      preToolUseMocks.permissionMode = 'allow-all';
      return runPreToolUseChecks(createInput({
        toolName,
        input,
        sessionId: sessionId ?? markerSessionId ?? 'test-session',
        currentUserRequest: objectiveSegments.at(-1),
        objectiveAuthorizationSegments: objectiveSegments,
        objectiveMutationAuthorized: true,
        objectiveSensitiveActionAuthorized: true,
        externalActionPolicy: 'allow-in-execute',
        activeSourceSlugs: sources,
        allSourceSlugs: sources,
      }));
    };

    const trueBay = `[robb-resume:260918-true-bay:38940c8bc27546ee414d6e2374737b2c7a6273b5:v1]
Le staging corrigé est actif. Reprends l’objectif initial complet : réactiver sur zero.example.test le dev login à la place du formulaire.
Périmètre autorisé exact : serveur \`dev\`, dépôt \`/srv/workspace/zero\`, services Zero uniquement. Utilise exclusivement la source \`rbw-servers\` et ses outils SSH structurés ; aucun navigateur opérationnel, SSH natif ou Bash local.
Tu es explicitement autorisé à modifier la configuration ou le code Zero, reconstruire/redéployer uniquement Zero et redémarrer uniquement ses services si le diagnostic le rend nécessaire. Ne touche ni Traefik global ni aucun autre projet. Vérifie après changement la révision déployée, la santé, le HTML ou les endpoints d’authentification, et un parcours dev-login fonctionnel sans formulaire de production.`;

    it('allows the exact True Bay relative source read and rejects server/root/path retargeting', () => {
      const exact = {
        server: 'dev', cwd: '/srv/workspace/zero',
        command: "sed -n '1,260p' 'app/(auth)/login/page.tsx'",
      };
      expect(runReplay(trueBay, 'mcp__rbw-servers__ssh_execute', exact)).toMatchObject({ type: 'allow' });
      for (const input of [
        { ...exact, server: 'pns' },
        { ...exact, cwd: '/srv/workspace/orion' },
        { ...exact, command: "sed -n '1,260p' '../orion/page.tsx'" },
        { ...exact, command: 'rm -f app/page.tsx' },
      ]) expect(runReplay(trueBay, 'mcp__rbw-servers__ssh_execute', input).type).not.toBe('allow');
      expect(runReplay(
        `${trueBay}\nN’utilise finalement pas le serveur dev et ne lis rien dans ce dépôt.`,
        'mcp__rbw-servers__ssh_execute',
        exact,
      ).type).not.toBe('allow');
      for (const amendment of [
        'Arrête tout maintenant.',
        'Ne poursuis plus cette mission.',
        'La cible devient Orion.',
        'Utilise désormais le serveur pns.',
        'Travaille plutôt dans /srv/workspace/orion.',
      ]) {
        expect(runReplay(
          [trueBay, amendment],
          'mcp__rbw-servers__ssh_execute',
          exact,
        ).type).not.toBe('allow');
      }
      for (const continuation of [
        'Continue.',
        'Poursuis l’analyse et l’optimisation.',
        'Reprends et va réellement jusqu’au bout de la mission.',
        'Continue sans t’arrêter.',
        'Reprend.',
      ]) {
        expect(runReplay(
          [trueBay, continuation],
          'mcp__rbw-servers__ssh_execute',
          exact,
        )).toMatchObject({ type: 'allow' });
      }
      for (const retargetedContinuation of [
        'Continue sur pns.',
        'Reprends mais sans SSH.',
        'Poursuis sur /srv/workspace/orion.',
      ]) {
        expect(runReplay(
          [trueBay, retargetedContinuation],
          'mcp__rbw-servers__ssh_execute',
          exact,
        ).type).not.toBe('allow');
      }
    });

    const wild = `[robb-resume:260915-wild-plateau:38940c8bc27546ee414d6e2374737b2c7a6273b5:v1]
Périmètre autorisé exact : serveur \`dev\`, dépôt \`/srv/workspace/orion\` et service \`orion-agent-bridge\` uniquement. Utilise exclusivement la source \`rbw-servers\` et ses outils SSH structurés.
URL autorisée : \`https://orion.example.test\`. Réconcilie l’état, lis les règles du dépôt, reproduis le défaut puis corrige le code Orion avec sauvegarde et retour arrière. Redémarre uniquement \`orion-agent-bridge\` si nécessaire ; ne reconstruis ou redéploie Orion que si le diagnostic le rend indispensable.
Vérifie que \`GET /assistant-api/accounts\` répond 200, que \`/parametres\` fonctionne et que \`bun run test:orion-production\` réussit dans \`/srv/workspace/orion\`.`;

    it('allows only the target-bound Wild curl, test, sed and compose reads', () => {
      const inputs = [
        { server: 'dev', cwd: '/srv/workspace/orion', command: 'curl --fail-with-body --silent --show-error --max-time 15 https://orion.example.test/assistant-api/accounts' },
        { server: 'dev', cwd: '/srv/workspace/orion', command: 'curl --fail-with-body --silent --show-error --max-time 15 https://orion.example.test/parametres' },
        { server: 'dev', cwd: '/srv/workspace/orion', command: 'bun run test:orion-production' },
        { server: 'dev', cwd: '/srv/workspace/orion', command: "sed -n '1,220p' apps/agent-bridge/server.mjs" },
        { server: 'dev', cwd: '/srv/workspace/orion', command: 'readlink -f apps/agent-bridge/server.mjs' },
        { server: 'dev', cwd: '/srv/workspace/orion', command: 'docker compose -f docker-compose.orion.yml ps' },
        { server: 'dev', cwd: '/srv/workspace/orion', command: "docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' orion-web | sed 's/=.*//' | sort" },
        { server: 'dev', cwd: '/srv/workspace/orion', command: "git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager log -1 --format='%H %cI %s'" },
      ];
      for (const input of inputs) {
        const result = runReplay(wild, 'mcp__rbw-servers__ssh_execute', input);
        if (result.type !== 'allow') throw new Error(`${input.command}: ${JSON.stringify(result)}`);
      }
      for (const input of [
        { ...inputs[0], command: 'curl --fail-with-body --silent --show-error --max-time 15 https://attacker.example/assistant-api/accounts' },
        { ...inputs[0], command: 'curl --fail-with-body --silent --show-error --max-time 15 https://orion.example.test.attacker.example/assistant-api/accounts' },
        { ...inputs[0], command: 'curl --fail-with-body --silent --show-error --max-time 15 https://orion.example.test/admin' },
        { ...inputs[2], command: 'bun run test:orion-destructive' },
        { ...inputs[3], cwd: '/srv/workspace/zero' },
        { ...inputs[6], command: "docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' zero-web | sed 's/=.*//' | sort" },
      ]) expect(runReplay(wild, 'mcp__rbw-servers__ssh_execute', input).type).not.toBe('allow');
      const negatedChecks = `${wild}\nN’exécute pas \`bun run test:orion-production\` et ne lance pas \`GET /assistant-api/accounts\`; vérifie autrement.`;
      expect(runReplay(negatedChecks, 'mcp__rbw-servers__ssh_execute', inputs[0]!).type).not.toBe('allow');
      expect(runReplay(negatedChecks, 'mcp__rbw-servers__ssh_execute', inputs[2]!).type).not.toBe('allow');
    });

    const silver = `[robb-resume:260916-silver-orchid:38940c8bc27546ee414d6e2374737b2c7a6273b5:v1]
Nouvel objectif opérationnel : reprends et termine réellement la résolution e-doc PNS du contrat \`3602\`, job \`16\`, corrélation \`85236791-757d-463a-bd53-c1f72197feb0\`.
Utilise exclusivement les API et la source \`rbw-servers\` avec ses outils SSH structurés. La cible PNS réellement observée est la révision \`fc5eb77c8b2063d825dd3779061cb8a949e77632\`, image \`registry.robinswood.io/pns-gen:prod-latest\`.
Pour toute lecture SQL minimale, cible seulement la clé primaire exacte (\`SELECT c.id FROM contracts c WHERE c.id=3602 LIMIT 1\`) puis préfère API, journaux et vérificateurs nommés pour l’état enrichi.`;

    it('does not infer database or container execution authority from a historical resume marker', () => {
      const sql = 'docker exec pnsgen-db psql -U postgres -d pnsgen -tAc "SELECT c.id FROM contracts c WHERE c.id=3602 LIMIT 1"';
      expect(runReplay(silver, 'mcp__rbw-servers__ssh_execute', { server: 'pns', command: sql, timeout: 30_000 }))
        .toMatchObject({ type: 'block' });
      expect(runReplay(silver, 'mcp__rbw-servers__ssh_execute', { server: 'pns', command: 'docker exec pnsgen-app ls -la /app', timeout: 30_000 }))
        .toMatchObject({ type: 'block' });
      for (const input of [
        { server: 'dev', command: sql },
        { server: 'pns', command: sql.replace('c.id=3602', 'c.id=3603') },
        { server: 'pns', command: sql.replace('-d pnsgen', '-d postgres') },
        { server: 'pns', command: 'docker exec pnsgen-app rm -rf /app/cache' },
      ]) expect(runReplay(silver, 'mcp__rbw-servers__ssh_execute', input).type).not.toBe('allow');
      for (const amendment of [
        'Arrête tout maintenant.',
        'Ne lis plus la base PNS.',
        'N’utilise plus rbw-servers ni SSH.',
        'La cible devient le contrat 3603.',
      ]) expect(runReplay(
        [silver, amendment],
        'mcp__rbw-servers__ssh_execute',
        { server: 'pns', command: sql, timeout: 30_000 },
      ).type).not.toBe('allow');
      const negatedSql = `${silver}\nN’exécute pas la lecture SQL \`SELECT c.id FROM contracts c WHERE c.id=3602 LIMIT 1\`; vérifie autrement.`;
      expect(runReplay(
        negatedSql,
        'mcp__rbw-servers__ssh_execute',
        { server: 'pns', command: sql, timeout: 30_000 },
      ).type).not.toBe('allow');
      for (const continuation of [
        'Continue.',
        'Reprend.',
        'Poursuis l’analyse et l’optimisation.',
        'Reprends et va réellement jusqu’au bout de la mission.',
        'Continue sans t’arrêter.',
      ]) expect(runReplay(
        [silver, continuation],
        'mcp__rbw-servers__ssh_execute',
        { server: 'pns', command: sql, timeout: 30_000 },
      )).toMatchObject({ type: 'block' });
    });

    const gentle = `[robb-resume:260918-gentle-fountain:38940c8bc27546ee414d6e2374737b2c7a6273b5:v1]
Utilise exclusivement Gmail en lecture et la source \`plc-microsoft-365\` via Microsoft Graph / API. Aucun navigateur ni interface. La cible exacte est le site RH privé \`exampleorg.sharepoint.com,06efb18b-29c2-409a-8ef4-d634918a7caa,a833b57e-9482-471b-9aa9-4dad3e78e46d\` (\`Example Org — Onboarding collaborateurs RH\`).
Matérialise le formulaire API-first comme formulaire natif d’une Microsoft List/SharePoint list privée dédiée \`Example RH - Entretiens annuels\`, avec les colonnes et rubriques utiles. Crée par API le rangement documentaire RH nécessaire dans la bibliothèque privée existante, avec une structure sûre et sans élargir les permissions.
Drive documentaire exact : \`b!syntheticDriveIdentifierForPublicFixture0000000000000000000000000\`
Dossier documentaire exact : \`Entretiens annuels\``;
    const site = 'exampleorg.sharepoint.com,06efb18b-29c2-409a-8ef4-d634918a7caa,a833b57e-9482-471b-9aa9-4dad3e78e46d';
    const listBody = {
      displayName: 'Example RH - Entretiens annuels',
      description: 'Liste privée Example Org pour préparer, co-remplir, valider et archiver les entretiens annuels des profils Comptable, Juridique et Gestionnaire de paie / Social.',
      columns: [{
        name: 'ProfilMetier', displayName: 'Profil métier',
        description: 'Sélectionner la trame applicable.', required: true,
        choice: {
          allowTextEntry: false,
          choices: ['Comptable', 'Juridique', 'Gestionnaire de paie / Social'],
          displayAs: 'dropDownMenu',
        },
      }, {
        name: 'Collaborateur', displayName: 'Collaborateur', required: true,
        personOrGroup: {
          allowMultipleSelection: false,
          chooseFromType: 'peopleOnly',
          displayAs: 'nameWithPresence',
        },
      }, {
        name: 'BilanCollab', displayName: 'Bilan collaborateur',
        text: {
          allowMultipleLines: true,
          appendChangesToExistingText: false,
          linesForEditing: 8,
          textType: 'plain',
        },
      }, {
        name: 'DateEntretien', displayName: 'Date de l’entretien',
        dateTime: { displayAs: 'default', format: 'dateOnly' },
      }, {
        name: 'NoteGlobale', displayName: 'Note globale /10',
        number: { decimalPlaces: 'none', displayAs: 'number', minimum: 1, maximum: 10 },
      }, {
        name: 'InformationDonnees', displayName: 'Information confirmée',
        boolean: {},
      }],
      list: { template: 'genericList' },
    };

    it('allows the exact Gentle list and drive-bound folder POSTs and blocks retargeting', () => {
      const list = { method: 'POST', endpoint: `sites/${site}/lists`, body: listBody };
      const folder = {
        method: 'POST', endpoint: 'drives/b!syntheticDriveIdentifierForPublicFixture0000000000000000000000000/root/children',
        body: { name: 'Entretiens annuels', folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
      };
      expect(runReplay(gentle, 'mcp__plc-microsoft-365__graph_request', list, ['plc-microsoft-365']))
        .toMatchObject({ type: 'allow' });
      expect(runReplay(gentle, 'mcp__plc-microsoft-365__graph_request', folder, ['plc-microsoft-365']))
        .toMatchObject({ type: 'allow' });
      const malformedColumns = [
        [...listBody.columns, { name: 'Lookup', displayName: 'Lookup', lookup: {} }],
        listBody.columns.map((column, index) => index === 0
          ? { ...column, text: { allowMultipleLines: false } }
          : column),
        listBody.columns.map((column, index) => index === 4
          ? { ...column, number: { decimalPlaces: 'none', minimum: Number.NaN, maximum: 10 } }
          : column),
        listBody.columns.map((column, index) => index === 4
          ? { ...column, number: { decimalPlaces: 'none', minimum: 11, maximum: 10 } }
          : column),
        listBody.columns.map((column, index) => index === 4
          ? { ...column, number: { decimalPlaces: 'none', minimum: 1, maximum: 10, unit: 'EUR' } }
          : column),
        listBody.columns.map((column, index) => index === 4
          ? { ...column, number: { decimalPlaces: ['none'], minimum: 1, maximum: 10 } }
          : column),
        listBody.columns.map((column, index) => index === 2
          ? { ...column, text: { allowMultipleLines: true, textType: ['plain'] } }
          : column),
        listBody.columns.map((column, index) => index === 5
          ? { ...column, boolean: { default: true } }
          : column),
      ];
      for (const columns of malformedColumns) {
        expect(runReplay(
          gentle,
          'mcp__plc-microsoft-365__graph_request',
          { ...list, body: { ...listBody, columns } },
          ['plc-microsoft-365'],
        ).type).not.toBe('allow');
      }
      expect(runReplay(
        gentle,
        'mcp__plc-microsoft-365__graph_request',
        { ...list, body: { displayName: listBody.displayName, description: listBody.description, list: listBody.list } },
        ['plc-microsoft-365'],
      )).toMatchObject({
        type: 'block',
        reason: expect.stringContaining('empty/partial list'),
      });
      for (const input of [
        { ...list, endpoint: 'sites/attacker.example,06efb18b-29c2-409a-8ef4-d634918a7caa,a833b57e-9482-471b-9aa9-4dad3e78e46d/lists' },
        { ...list, endpoint: `sites/${site}.attacker.example/lists` },
        { ...list, body: { ...listBody, displayName: 'Example RH - Salaires' } },
        { ...folder, endpoint: 'drives/other/root/children' },
        { ...folder, body: { ...folder.body, name: 'Autre dossier' } },
        { ...folder, body: { ...folder.body, '@microsoft.graph.conflictBehavior': 'replace' } },
        { ...folder, body: { ...folder.body, extra: true } },
        { ...list, method: 'DELETE' },
      ]) expect(runReplay(gentle, 'mcp__plc-microsoft-365__graph_request', input, ['plc-microsoft-365']).type).not.toBe('allow');
      expect(runReplay(
        [gentle, 'Ne crée finalement pas la liste ni le dossier.'],
        'mcp__plc-microsoft-365__graph_request',
        list,
        ['plc-microsoft-365'],
      ).type).not.toBe('allow');
      for (const continuation of [
        'Continue.',
        'Reprend.',
        'Poursuis l’analyse et l’optimisation.',
        'Reprends et va réellement jusqu’au bout de la mission.',
        'Continue sans t’arrêter.',
      ]) expect(runReplay(
        [gentle, continuation],
        'mcp__plc-microsoft-365__graph_request',
        list,
        ['plc-microsoft-365'],
      )).toMatchObject({ type: 'allow' });
    });

    const boundedPath = '/srv/rbw-agents-oss/scripts/fixture_paper_metrics_v1.py';
    const boundedWrite = `[robb-resume:test-bounded-write:2222222222222222222222222222222222222222:v2]
Poursuis l’amélioration de la stratégie exclusivement dans l’environnement paper/sandbox via la source structurée \`rbw-agents-oss\`.
Source OSS exacte autorisée : \`rbw-agents-oss\`.
Fichier OSS exact autorisé en écriture atomique : \`${boundedPath}\`.
Lis d’abord son hash, écris uniquement ce fichier et exécute les tests hors réseau. Aucun autre fichier, source, ordre, broker, capital live ou déploiement n’est autorisé.`;

    it('allows only the literal OSS path bound by the latest signed atomic-write contract', () => {
      const toolName = 'mcp__rbw-agents-oss__oss_write_file';
      const exact = {
        path: boundedPath,
        content: '#!/usr/bin/env python3\nprint("bounded")\n',
        _displayName: 'Ajouter métriques nettes',
        _intent: 'Créer le module paper borné et le vérifier hors réseau.',
      };
      expect(runReplay(boundedWrite, toolName, exact, ['rbw-agents-oss']))
        .toMatchObject({
          type: 'modify',
          input: { path: boundedPath, content: exact.content },
        });
      expect(runReplay(
        [boundedWrite, 'Continue sans t’arrêter.'],
        toolName,
        exact,
        ['rbw-agents-oss'],
      )).toMatchObject({
        type: 'modify',
          input: { path: boundedPath, content: exact.content },
      });
      expect(runReplay(
        boundedWrite,
        toolName,
        exact,
        ['rbw-agents-oss'],
        'test-copied-session',
      )).toMatchObject({
        type: 'block',
        reason: expect.stringContaining('belongs to another durable session'),
      });

      for (const [candidateTool, input] of [
        [toolName, { ...exact, path: '/srv/rbw-agents-oss/scripts/fixture_paper_metrics_v2.py' }],
        [toolName, { ...exact, path: '/srv/rbw-agents-oss/scripts/tmp/../fixture_paper_metrics_v1.py' }],
        [toolName, { ...exact, path: '${OSS_ROOT}/scripts/fixture_paper_metrics_v1.py' }],
        [toolName, { ...exact, path: '/srv/rbw-agents-oss/scripts/*.py' }],
        [toolName, { ...exact, sibling: '/srv/rbw-agents-oss/scripts/fixture_paper_metrics_v2.py' }],
        ['mcp__other-source__oss_write_file', exact],
      ] as const) expect(runReplay(
        boundedWrite,
        candidateTool,
        input,
        ['rbw-agents-oss', 'other-source'],
      ).type).not.toBe('allow');

      for (const forbiddenPath of [
        '/etc/sudoers',
        '/root/.ssh/authorized_keys',
        '/srv/rbw-agents-oss/.env',
        '/srv/rbw-agents-oss/scripts/.env',
        '/srv/rbw-agents-oss/scripts/private-key.pem',
      ]) {
        const forbiddenObjective = boundedWrite.replace(boundedPath, forbiddenPath);
        expect(runReplay(
          forbiddenObjective,
          toolName,
          { ...exact, path: forbiddenPath },
          ['rbw-agents-oss'],
        )).toMatchObject({ type: 'block' });
      }

      for (const invalidObjective of [
        `[robb-resume:test-other-mission:2222222222222222222222222222222222222222:v2]\nPoursuis une autre mission dans son propre périmètre.`,
        boundedWrite.replace(boundedPath, '/srv/rbw-agents-oss/scripts/fixture_paper_metrics_v2.py'),
        boundedWrite.replace(boundedPath, '${OSS_ROOT}/scripts/fixture_paper_metrics_v1.py'),
        `${boundedWrite}\nN’écris finalement pas ce fichier.`,
        `${boundedWrite}\nSource OSS exacte autorisée : \`other-source\`.`,
        `${boundedWrite}\nUtilise désormais une autre source.`,
        `${boundedWrite}\nTravaille plutôt sur \`/srv/rbw-agents-oss/scripts/fixture_paper_metrics_v2.py\`.`,
      ]) expect(runReplay(
        invalidObjective,
        toolName,
        exact,
        ['rbw-agents-oss'],
      ).type).not.toBe('allow');

      for (const amendment of [
        'Arrête tout maintenant.',
        'N’écris plus ce fichier.',
        'Travaille plutôt sur un autre projet.',
        'Utilise désormais une autre source.',
      ]) expect(runReplay(
        [boundedWrite, amendment],
        toolName,
        exact,
        ['rbw-agents-oss'],
      ).type).not.toBe('allow');

      const secondPath = '/srv/rbw-agents-oss/scripts/audits/paper_snapshot_v2.py';
      const secondContract = `[robb-resume:test-second-write:3333333333333333333333333333333333333333:v3]
Source OSS exacte autorisée : \`rbw-agents-oss\`.
Fichier OSS exact autorisé en écriture atomique : \`${secondPath}\`.
Écris uniquement cet artefact OSS, puis vérifie-le sans réseau.`;
      const secondInput = { path: secondPath, content: 'print("second contract")\n' };
      expect(runReplay(secondContract, toolName, secondInput, ['rbw-agents-oss']))
        .toMatchObject({ type: 'allow' });
      expect(runReplay(secondContract, toolName, exact, ['rbw-agents-oss']).type)
        .not.toBe('allow');
      expect(runReplay(boundedWrite, toolName, secondInput, ['rbw-agents-oss']).type)
        .not.toBe('allow');
    });
  });
});
