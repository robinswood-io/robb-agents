import { afterEach, describe, expect, it } from 'bun:test';
import {
  beginObjectiveEvidenceGate,
  checkObjectiveEvidenceBeforeMutation,
  clearObjectiveEvidenceGate,
  getObjectiveEvidenceCompletionGap,
  recordObjectiveEvidence,
  parseIndependentReviewReceipt,
} from '../objective-evidence-gate.ts';

describe('high-stakes objective evidence gate', () => {
  afterEach(() => clearObjectiveEvidenceGate('s1'));

  it('blocks legal mutation until an official source was observed', () => {
    beginObjectiveEvidenceGate('s1', 'u1', 'Fais évoluer notre NDA puis rédige le document.');
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write').allowed).toBe(false);
    recordObjectiveEvidence('s1', 'web_search', 'Résultat de blog secondaire suffisamment long mais sans URL institutionnelle.', false);
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write').allowed).toBe(false);
    recordObjectiveEvidence(
      's1',
      'web_fetch',
      'Texte en vigueur consulté sur https://www.legifrance.gouv.fr/codes/article_lc/ARTICLE',
      false,
    );
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write').allowed).toBe(true);
  });

  it('requires independent review before high-stakes completion', () => {
    beginObjectiveEvidenceGate('s1', 'u1', 'Corrige ce contrat juridique.');
    recordObjectiveEvidence('s1', 'web_fetch', 'Source officielle https://eur-lex.europa.eu/legal-content/FR/TXT', false);
    expect(getObjectiveEvidenceCompletionGap('s1')).toContain('independent review');
    recordObjectiveEvidence('s1', 'mcp__session__call_llm', 'Revue indépendante complète et exploitable.', false);
    expect(getObjectiveEvidenceCompletionGap('s1')).toContain('structured PASS receipt');
    recordObjectiveEvidence('s1', 'mcp__session__call_llm', JSON.stringify({
      verdict: 'PASS',
      criteria: [
        { id: 'requested-outcome-delivered', passed: true },
        { id: 'relevant-checks-passed', passed: true },
      ],
      findings: [],
    }), false);
    expect(getObjectiveEvidenceCompletionGap('s1')).toBeUndefined();
  });

  it('invalidates an earlier PASS when a later mutation is authorized', () => {
    beginObjectiveEvidenceGate('s1', 'u1', 'Corrige ce contrat juridique.');
    recordObjectiveEvidence('s1', 'web_fetch', 'Source officielle https://eur-lex.europa.eu/legal-content/FR/TXT', false);
    recordObjectiveEvidence('s1', 'mcp__session__call_llm', JSON.stringify({
      verdict: 'PASS',
      criteria: [{ id: 'requested-outcome-delivered', passed: true }],
      findings: [],
    }), false);
    expect(getObjectiveEvidenceCompletionGap('s1')).toBeUndefined();

    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(true);
    expect(getObjectiveEvidenceCompletionGap('s1')).toContain(
      'independent review must be repeated after subsequent mutation (Write)',
    );

    recordObjectiveEvidence('s1', 'mcp__session__call_llm', JSON.stringify({
      verdict: 'PASS',
      criteria: [{ id: 'requested-outcome-delivered', passed: true }],
      findings: [],
    }), false);
    expect(getObjectiveEvidenceCompletionGap('s1')).toBeUndefined();
  });

  it('does not invalidate review for a typed read and does not trust a read-like unknown name', () => {
    beginObjectiveEvidenceGate('s1', 'u1', 'Corrige ce contrat juridique.');
    recordObjectiveEvidence('s1', 'web_fetch', 'Source officielle https://eur-lex.europa.eu/legal-content/FR/TXT', false);
    recordObjectiveEvidence('s1', 'mcp__session__call_llm', JSON.stringify({
      verdict: 'PASS',
      criteria: [{ id: 'requested-outcome-delivered', passed: true }],
      findings: [],
    }), false);

    expect(checkObjectiveEvidenceBeforeMutation('s1', 'WebFetch', 'read').allowed).toBe(true);
    expect(getObjectiveEvidenceCompletionGap('s1')).toBeUndefined();

    clearObjectiveEvidenceGate('s1');
    beginObjectiveEvidenceGate('s1', 'u2', 'Corrige ce contrat juridique.');
    expect(checkObjectiveEvidenceBeforeMutation(
      's1',
      'mcp__crm__search_and_delete',
      'unknown',
    ).allowed).toBe(false);
  });

  it('does not accept a failed or incomplete reviewer receipt', () => {
    beginObjectiveEvidenceGate('s1', 'u1', 'Corrige ce contrat juridique.');
    recordObjectiveEvidence('s1', 'web_fetch', 'Source officielle https://eur-lex.europa.eu/legal-content/FR/TXT', false);
    recordObjectiveEvidence('s1', 'mcp__session__call_llm', JSON.stringify({
      verdict: 'FAIL',
      criteria: [{ id: 'requested-outcome-delivered', passed: false }],
      findings: ['La clause 4 reste ambiguë.'],
    }), false);
    expect(getObjectiveEvidenceCompletionGap('s1')).toContain('latest verdict: FAIL');
  });

  it('parses only schema-complete independent review receipts', () => {
    expect(parseIndependentReviewReceipt('PASS')).toBeUndefined();
    expect(parseIndependentReviewReceipt('{"verdict":"PASS"}')).toBeUndefined();
    expect(parseIndependentReviewReceipt(`\`\`\`json
{"verdict":"PASS","criteria":[{"id":"checks","passed":true}],"findings":[]}
\`\`\``)).toEqual({
      verdict: 'PASS',
      criteria: [{ id: 'checks', passed: true }],
      findings: [],
    });
  });

  it('accepts first-party financial evidence and rejects an unrelated generic read', () => {
    beginObjectiveEvidenceGate('s1', 'u1', 'Corrige cette écriture comptable.');
    recordObjectiveEvidence('s1', 'Read', 'Un texte générique assez long mais sans provenance financière de première partie.', false);
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write').allowed).toBe(false);
    recordObjectiveEvidence(
      's1',
      'mcp__inqom__inqom_get_ledger',
      'Grand livre Inqom vérifié pour la période, avec identifiant de dossier et écritures détaillées.',
      false,
    );
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write').allowed).toBe(true);
  });

  it('does not activate for a non-mutating legal explanation', () => {
    expect(beginObjectiveEvidenceGate('s1', 'u1', 'Explique le principe juridique de bonne foi.')).toBeUndefined();
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write').allowed).toBe(true);
  });
});
