import { describe, it, expect, beforeEach } from 'bun:test';
import { resetPreToolUseFixture, runPreToolUseChecks, resolveBrowserChannelDirective, createInput } from './pre-tool-use-fixture.ts';

describe('runPreToolUseChecks', () => {
  beforeEach(resetPreToolUseFixture);



  describe('host browser channel constraint', () => {
    it('blocks canonical browser fallback for an explicit browser ban or non-browser channel binding', () => {
      for (const currentUserRequest of [
        "N'utilise pas le navigateur.",
        'Do not use the browser.',
        "Utilise l'API et non l'interface.",
        'Concentre toi sur la partie API via le serveur.',
        "N'utilise pas le navigateur; passe par l'API.",
        "N'utilise jamais le navigateur; utilise l'API.",
        "N'utilise plus le navigateur; passe par SSH.",
        "Ne pas utiliser l'interface; utilise le connecteur.",
        "Ne jamais ouvrir l'interface; passe via le serveur.",
        "Ne plus ouvrir le navigateur; utilise l'API.",
      ]) {
        const result = runPreToolUseChecks(createInput({
          toolName: 'mcp__session__browser_tool',
          input: { command: 'snapshot' },
          currentUserRequest,
          objectiveAuthorizationSegments: [currentUserRequest],
        }));

        expect(result.type).toBe('block');
        if (result.type === 'block') {
          expect(result.reason).toContain('latest applicable human instruction');
          expect(result.reason).toContain('browser_tool is disabled');
          expect(result.reason).toContain('requested non-browser channel');
        }
      }
    });

    it('recognizes structured non-browser paths and unavailable browser fallbacks', () => {
      for (const currentUserRequest of [
        'Use the API because the browser is unavailable.',
        'Use the API; the browser is broken.',
        'The browser is unavailable. Use the API.',
        'Call the API directly.',
        'Execute this on the server.',
        'Use the API interface directly.',
      ]) {
        const result = runPreToolUseChecks(createInput({
          toolName: 'browser_tool',
          input: { command: 'open' },
          currentUserRequest,
          objectiveAuthorizationSegments: [currentUserRequest],
        }));
        expect(result.type).toBe('block');
      }
    });

    it('uses only the latest persisted objective segment when no current request is available', () => {
      const blocked = runPreToolUseChecks(createInput({
        toolName: 'browser_tool',
        input: { command: 'open' },
        objectiveAuthorizationSegments: [
          'Open the browser and inspect the public page.',
          'Use the connector only; do not use the browser interface.',
        ],
      }));
      expect(blocked.type).toBe('block');

      const superseded = runPreToolUseChecks(createInput({
        toolName: 'browser_tool',
        input: { command: 'open --foreground' },
        objectiveAuthorizationSegments: [
          'Use the connector only; do not use the browser interface.',
          'Reopen the browser so I can sign in for the authentication handoff.',
        ],
      }));
      expect(superseded.type).toBe('allow');
    });

    it('keeps the last explicit API constraint through a generic continue instruction', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'browser_tool',
        input: { command: 'snapshot' },
        currentUserRequest: 'Continue.',
        objectiveAuthorizationSegments: [
          'Use the API only; do not use the browser.',
          'Continue.',
        ],
      }));

      expect(result.type).toBe('block');
    });

    it('does not let a model-authored delegated child prompt override the authenticated root constraint', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'browser_tool',
        input: { command: 'open --foreground' },
        // A child receives this as its current turn, but it is not an
        // authenticated human objective segment and cannot grant itself a new
        // channel that the persisted root objective explicitly forbids.
        currentUserRequest: 'Open the browser and use the interface to finish the delegated task.',
        objectiveAuthorizationSegments: [
          'Use the API only; do not use the browser interface.',
        ],
      }));

      expect(result.type).toBe('block');
    });

    it('lets a later authenticated human instruction stop the API path and explicitly switch to the browser', () => {
      for (const currentUserRequest of [
        "N'utilise plus l'API, ouvre le navigateur.",
        "N'utilise pas l'API; utilise le navigateur.",
        "N'utilise jamais l'API; ouvre l'interface.",
        'Do not use the API; use the browser.',
        'Avoid the API; open the browser.',
        "Évite l'API; ouvre le navigateur.",
      ]) {
        const result = runPreToolUseChecks(createInput({
          toolName: 'browser_tool',
          input: { command: 'open --foreground' },
          currentUserRequest,
          objectiveAuthorizationSegments: [
            'Use the API only; do not use the browser.',
            currentUserRequest,
          ],
        }));

        expect(result.type).toBe('allow');
      }
    });

    it('uses the last explicit directive inside a correcting human segment', () => {
      const correction = 'Correction: ignore the earlier phrase do not use the browser; use the browser now.';
      const result = runPreToolUseChecks(createInput({
        toolName: 'browser_tool',
        input: { command: 'open --foreground' },
        currentUserRequest: correction,
        objectiveAuthorizationSegments: [
          'Use the API only; do not use the browser.',
          correction,
        ],
      }));

      expect(result.type).toBe('allow');
    });

    it('keeps browser lifecycle cleanup and help available under the channel constraint', () => {
      for (const command of ['help', '--help', '-h', 'release all', 'close window-1', 'hide']) {
        const result = runPreToolUseChecks(createInput({
          toolName: 'browser_tool',
          input: { command },
          currentUserRequest: 'Passe uniquement par SSH via le serveur, sans navigateur.',
        }));
        expect(result.type).toBe('allow');
      }

      const batched = runPreToolUseChecks(createInput({
        toolName: 'browser_tool',
        input: { command: 'release all; open' },
        currentUserRequest: 'Passe uniquement par SSH via le serveur, sans navigateur.',
      }));
      expect(batched.type).toBe('block');
    });

    it('honors an explicit browser authentication or visual-validation handoff in the latest request', () => {
      for (const currentUserRequest of [
        "Utilise l'API pour le travail, puis réouvre le navigateur afin que je puisse m'authentifier.",
        "Passe par le connecteur, puis ouvre l'interface pour une validation visuelle.",
        'Do not use the browser for work; then open it for visual validation.',
      ]) {
        const result = runPreToolUseChecks(createInput({
          toolName: 'browser_tool',
          input: { command: 'open --foreground' },
          currentUserRequest,
          objectiveAuthorizationSegments: [
            'Use the API only; do not use the browser.',
            currentUserRequest,
          ],
        }));
        expect(result.type).toBe('allow');
        expect(resolveBrowserChannelDirective(undefined, [currentUserRequest]))
          .toBe('browser-handoff');

        const mutation = runPreToolUseChecks(createInput({
          toolName: 'browser_tool',
          input: { command: 'click @e1' },
          currentUserRequest,
          objectiveAuthorizationSegments: [currentUserRequest],
          objectiveMutationAuthorized: true,
          externalActionPolicy: 'allow-in-execute',
        }));
        expect(mutation).toMatchObject({
          type: 'block',
          reason: expect.stringContaining('not for operational work'),
        });
      }
    });

    it('does not let a final visual-validation allowance become an operational browser fallback', () => {
      const instruction = "Utilise uniquement l'API pour les opérations. Ouvre le navigateur seulement pour la validation visuelle finale.";
      expect(resolveBrowserChannelDirective(undefined, [instruction])).toBe('browser-handoff');

      expect(runPreToolUseChecks(createInput({
        toolName: 'browser_tool',
        input: { command: 'snapshot' },
        objectiveAuthorizationSegments: [instruction],
      }))).toMatchObject({ type: 'allow' });

      for (const [toolName, input] of [
        ['browser_tool', { command: 'fill @e1 bypass-api' }],
        ['browser_click', {}],
      ] as const) {
        expect(runPreToolUseChecks(createInput({
          toolName,
          input,
          objectiveAuthorizationSegments: [instruction],
          objectiveMutationAuthorized: true,
          externalActionPolicy: 'allow-in-execute',
        }))).toMatchObject({
          type: 'block',
          reason: expect.stringContaining('do not use the browser as an API or connector fallback'),
        });
      }
    });

    it('does not block ordinary browser work or a browser used to consult API documentation', () => {
      for (const currentUserRequest of [
        'Ouvre le navigateur et vérifie la page publique.',
        "Utilise le navigateur pour consulter la documentation de l'API.",
        'Use the browser to test the API documentation examples.',
        'Use the API and browser together for this validation.',
        "Contrôle l'API via le navigateur.",
      ]) {
        const result = runPreToolUseChecks(createInput({
          toolName: 'browser_tool',
          input: { command: 'snapshot' },
          currentUserRequest,
        }));
        expect(result.type).toBe('allow');
      }
    });
  });
});
