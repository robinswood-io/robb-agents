import { withScopeReview } from "./__fixtures__/scope-review.ts";
import { describe, expect, it } from "bun:test";
import type { Message } from "@craft-agent/core/types";
import { extractObjectiveOutcome, validateObjectiveOutcome } from "./objective-outcome.ts";
import { registerObjectiveAcceptanceCriteria } from "./objective-acceptance-criteria.ts";
import { objective } from "./testing/objective-outcome-fixture.ts";

describe('objective outcome receipt', () => {

  it('resolves tool:<name> evidence aliases when multiple registered acceptance criteria pass with the same observation tool', () => {
    const multiReadObjective = registerObjectiveAcceptanceCriteria(
      { ...objective, requiresAcceptanceCriteria: true },
      [
        {
          id: 'csv-check',
          description: 'Read generated CSV.',
          toolName: 'Read',
          input: { file_path: '/tmp/mesures.csv' },
          checks: [{ path: '$text', equals: 'mois,valeur\njan,10' }],
        },
        {
          id: 'report-check',
          description: 'Read generated report.',
          toolName: 'Read',
          input: { file_path: '/tmp/rapport.md' },
          checks: [{ path: '$text', equals: '# Rapport\nTotal: 10' }],
        },
      ],
      10,
    );
    const multiReadMessages: Message[] = [
      { id: 'u1', role: 'user', content: 'Génère mesures.csv et rapport.md puis vérifie-les.', timestamp: 1 },
      {
        id: 'write-csv', role: 'tool', content: '', timestamp: 11,
        toolName: 'Write', toolUseId: 'write-csv-call', toolStatus: 'completed', toolExecuted: true,
        toolInput: { file_path: '/tmp/mesures.csv', content: 'mois,valeur\njan,10' }, toolResult: 'written',
      },
      {
        id: 'write-report', role: 'tool', content: '', timestamp: 12,
        toolName: 'Write', toolUseId: 'write-report-call', toolStatus: 'completed', toolExecuted: true,
        toolInput: { file_path: '/tmp/rapport.md', content: '# Rapport\nTotal: 10' }, toolResult: 'written',
      },
      {
        id: 'read-csv', role: 'tool', content: '', timestamp: 13,
        toolName: 'Read', toolUseId: 'read-csv-call', toolStatus: 'completed', toolExecuted: true,
        toolInput: { file_path: '/tmp/mesures.csv' }, toolResult: 'mois,valeur\njan,10\n',
      },
      {
        id: 'read-report', role: 'tool', content: '', timestamp: 14,
        toolName: 'Read', toolUseId: 'read-report-call', toolStatus: 'completed', toolExecuted: true,
        toolInput: { file_path: '/tmp/rapport.md' }, toolResult: '# Rapport\nTotal: 10\n',
      },
    ];
    const declaration = extractObjectiveOutcome(
      `Terminé.\n<!-- robb_objective_outcome ${JSON.stringify({
        state: 'complete_verified',
        criteria: [
          { id: 'requested-outcome-delivered', satisfied: true, evidence: ['tool:Read'] },
          { id: 'relevant-checks-passed', satisfied: true, evidence: ['tool:Read'] },
          { id: 'no-safe-work-remaining', satisfied: true, evidence: ['tool:Read'] },
          { id: 'csv-check', satisfied: true, evidence: ['tool:Read'] },
          { id: 'report-check', satisfied: true, evidence: ['tool:Read'] },
        ],
        remainingWork: [],
        blocker: null,
      })} -->`,
    ).declaration;
    expect(validateObjectiveOutcome(declaration, {
      objective: multiReadObjective,
      messages: withScopeReview(multiReadObjective, multiReadMessages),
    })).toEqual({ state: 'complete_verified', valid: true, gaps: [] });
  });
});
