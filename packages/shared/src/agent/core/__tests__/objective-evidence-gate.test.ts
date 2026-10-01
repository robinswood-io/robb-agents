import { afterEach, describe, expect, it } from 'bun:test';
import {
  beginObjectiveEvidenceGate,
  checkObjectiveEvidenceBeforeMutation,
  clearObjectiveEvidenceGate,
  getObjectiveEvidenceCompletionGap,
  recordObjectiveEvidence,
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
    expect(getObjectiveEvidenceCompletionGap('s1')).toBeUndefined();
  });

  it('does not activate for a non-mutating legal explanation', () => {
    expect(beginObjectiveEvidenceGate('s1', 'u1', 'Explique le principe juridique de bonne foi.')).toBeUndefined();
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write').allowed).toBe(true);
  });
});
