import { describe, expect, it } from 'bun:test';
import type { Message } from '@craft-agent/core/types';
import {
  classifyLatestTurnTerminalState,
  looksLikePrematureFinalAssistant,
} from './turn-completion.ts';

const message = (
  role: Message['role'],
  timestamp: number,
  options: Partial<Message> = {},
): Message => ({
  id: `${role}-${timestamp}`,
  role,
  content: role,
  timestamp,
  ...options,
});

describe('classifyLatestTurnTerminalState', () => {
  it('accepts a final assistant response after the latest user message', () => {
    expect(classifyLatestTurnTerminalState([
      message('user', 1),
      message('assistant', 2),
    ])).toBe('final-assistant');
  });

  it('does not treat commentary followed by a tool result as completion', () => {
    expect(classifyLatestTurnTerminalState([
      message('assistant', 1),
      message('user', 2),
      message('assistant', 3, { isIntermediate: true }),
      message('tool', 4, { toolName: 'Bash' }),
    ])).toBe('incomplete');
  });

  it('accepts a visible error as a terminal outcome', () => {
    expect(classifyLatestTurnTerminalState([
      message('user', 1),
      message('tool', 2, { toolName: 'Read' }),
      message('error', 3),
    ])).toBe('error');
  });

  it('does not reuse a final response from a previous turn', () => {
    expect(classifyLatestTurnTerminalState([
      message('user', 1),
      message('assistant', 2),
      message('user', 3),
      message('tool', 4, { toolName: 'Edit' }),
    ])).toBe('incomplete');
  });

  it('accepts a final response with the same timestamp as the user message', () => {
    expect(classifyLatestTurnTerminalState([
      message('user', 1),
      message('assistant', 1),
    ])).toBe('final-assistant');
  });

  it('rejects a final response that ends by announcing concrete remaining work', () => {
    expect(classifyLatestTurnTerminalState([
      message('user', 1),
      message('assistant', 2, {
        content: 'Le diagnostic est posé. Je poursuis l’implantation du correctif.',
      }),
    ])).toBe('premature-final-assistant');

    expect(looksLikePrematureFinalAssistant('Je vérifie maintenant le CI HEAD.')).toBe(true);
    expect(looksLikePrematureFinalAssistant(
      'Je vais maintenant vérifier les données internes réellement disponibles.',
    )).toBe(true);
  });

  it('accepts an explicit human handoff as a legitimate final response', () => {
    expect(looksLikePrematureFinalAssistant(
      'Je vais relancer la publication quand vous aurez renseigné OPENAI_API_KEY.',
    )).toBe(false);
    expect(looksLikePrematureFinalAssistant(
      'Je vais continuer après votre connexion. Connectez-vous puis dites-moi quand c’est fait.',
    )).toBe(false);
    expect(looksLikePrematureFinalAssistant(
      'Je vais créer les deux scènes. Il me manque seulement la composition exacte du groupe.',
    )).toBe(false);
  });

  it('does not reject a completed report because its introduction announced the work', () => {
    const completedReport = [
      'Je vais maintenant analyser les journaux.',
      'x'.repeat(750),
      'Analyse terminée : la cause est identifiée et le correctif a été vérifié.',
    ].join(' ');
    expect(looksLikePrematureFinalAssistant(completedReport)).toBe(false);
  });
});
