import { describe, expect, test } from 'bun:test';
import {
  extractRecentUserTexts,
  SourceToolActivationController,
} from './source-tool-activation.ts';

function sourceTools(families: Record<string, number>, source = 'google_workspace'): string[] {
  return Object.entries(families).flatMap(([family, count]) =>
    Array.from({ length: count }, (_, index) => `mcp__${source}__${family}_tool_${index}`));
}

const largeWorkspaceTools = [
  ...sourceTools({
    docs: 29,
    drive: 26,
    gmail: 28,
    contacts: 8,
    calendar: 16,
    meet: 19,
    sheets: 15,
    slides: 16,
    forms: 19,
    chat: 21,
    youtube: 11,
    tasks: 14,
    notes: 7,
  }),
  'mcp__google_workspace__search_all',
  'mcp__google_workspace__google_auth_status',
  'mcp__google_workspace__sync_now',
];

describe('SourceToolActivationController', () => {
  test('keeps builtins, session tools, and small sources fully active', () => {
    const names = [
      'read',
      'mcp__session__call_llm',
      ...sourceTools({ widget: 3 }, 'small_source'),
    ];
    const decision = new SourceToolActivationController().select(names, 'Use a document');
    expect(decision.activeToolNames).toEqual(names);
    expect(decision.filtered).toBe(false);
  });

  test('fails open for an ambiguous first prompt', () => {
    const names = ['read', 'mcp__session__call_llm', ...largeWorkspaceTools];
    const decision = new SourceToolActivationController().select(names, 'Fais-le complètement');
    expect(decision.activeToolNames).toEqual(names);
    expect(decision.filtered).toBe(false);
  });

  test('narrows an NDA task to Docs, Drive, and discovery tools', () => {
    const names = ['read', 'mcp__session__call_llm', ...largeWorkspaceTools];
    const decision = new SourceToolActivationController().select(names, 'Rédige un NDA juridiquement robuste');
    expect(decision.filtered).toBe(true);
    expect(decision.selectedFamilies).toEqual(['docs', 'drive']);
    expect(decision.activeToolNames).toContain('mcp__google_workspace__docs_tool_0');
    expect(decision.activeToolNames).toContain('mcp__google_workspace__drive_tool_0');
    expect(decision.activeToolNames).toContain('mcp__google_workspace__search_all');
    expect(decision.activeToolNames).not.toContain('mcp__google_workspace__gmail_tool_0');
    expect(decision.sourceToolsActive).toBe(58);
    expect(decision.sourceToolsTotal).toBe(232);
  });

  test('adds cross-product dependencies for mail and meetings', () => {
    const controller = new SourceToolActivationController();
    const mail = controller.select(largeWorkspaceTools, 'Envoie un email au contact Martin');
    expect(mail.selectedFamilies).toEqual(['contacts', 'gmail']);
    const meeting = new SourceToolActivationController().select(
      largeWorkspaceTools,
      'Planifie une réunion dans mon agenda',
    );
    expect(meeting.selectedFamilies).toEqual(['calendar', 'contacts', 'meet']);
  });

  test('keeps recognized families sticky for terse follow-ups', () => {
    const controller = new SourceToolActivationController();
    controller.select(largeWorkspaceTools, 'Crée une présentation PowerPoint');
    const followUp = controller.select(largeWorkspaceTools, 'Personnalise-la et vérifie tout');
    expect(followUp.selectedFamilies).toEqual(['drive', 'slides']);
    expect(followUp.activeToolNames).toContain('mcp__google_workspace__slides_tool_0');
    expect(followUp.activeToolNames).not.toContain('mcp__google_workspace__gmail_tool_0');
  });

  test('recovers intent from recent user history after a process restart', () => {
    const decision = new SourceToolActivationController().select(
      largeWorkspaceTools,
      'Continue',
      ['Prépare le rapport dans un Google Doc'],
    );
    expect(decision.selectedFamilies).toEqual(['docs', 'drive']);
    expect(decision.filtered).toBe(true);
  });

  test('does not narrow an unknown large MCP source', () => {
    const unknown = sourceTools({ custom: 100 }, 'custom_suite');
    const decision = new SourceToolActivationController().select(unknown, 'Prépare un document');
    expect(decision.activeToolNames).toEqual(unknown);
    expect(decision.filtered).toBe(false);
  });
});

describe('extractRecentUserTexts', () => {
  test('extracts only recent user text from strings and content blocks', () => {
    expect(extractRecentUserTexts([
      { role: 'user', content: 'Premier message' },
      { role: 'assistant', content: [{ type: 'text', text: 'Réponse' }] },
      { role: 'toolResult', content: [{ type: 'text', text: 'Sortie lourde' }] },
      { role: 'user', content: [{ type: 'text', text: 'Crée le document' }, { type: 'image', data: 'x' }] },
    ])).toEqual(['Premier message', 'Crée le document']);
  });
});
