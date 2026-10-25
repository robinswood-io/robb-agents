import { afterEach, describe, expect, it } from "bun:test";
import { beginObjectiveEvidenceGate as beginAuthorizedObjectiveEvidenceGate, checkObjectiveEvidenceBeforeMutation, clearObjectiveEvidenceGate, getObjectiveEvidenceCompletionGap, recordObjectiveEvidence, parseIndependentReviewReceipt } from "../objective-evidence-gate.ts";
import { beginObjectiveEvidenceGate } from "./testing/objective-evidence-gate-fixture.ts";

describe('high-stakes objective evidence gate', () => {
  afterEach(() => clearObjectiveEvidenceGate('s1'));

  it.each([
    {
      label: 'GitHub Docs browser navigation',
      objective: 'Correct the GitHub secret-scanning security policy.',
      toolName: 'mcp__session__browser_tool',
      input: { command: 'navigate https://docs.github.com/en/code-security/concepts/secret-security/secret-scanning' },
      result: 'Navigated to the current GitHub Docs secret-scanning documentation successfully.',
    },
    {
      label: 'OpenAI Model Spec host',
      objective: 'Correct the OpenAI agent security policy and secret handling.',
      toolName: 'WebFetch',
      input: { url: 'https://model-spec.openai.com/2026-08-18.html' },
      result: 'Fetched the dated OpenAI Model Spec document from the requested first-party URL.',
    },
    {
      label: 'bounded official OpenAI repository document',
      objective: 'Correct the OpenAI agent security policy and Model Spec handling.',
      toolName: 'WebFetch',
      input: { url: 'https://raw.githubusercontent.com/openai/model_spec/main/model_spec.md' },
      result: 'Fetched the current Model Spec file from the exact official OpenAI repository path.',
    },
    {
      label: 'official OpenAI Model Spec repository root',
      objective: 'Correct the OpenAI agent policy using the Model Spec.',
      toolName: 'WebFetch',
      input: { url: 'https://github.com/openai/model_spec' },
      result: 'Fetched the official OpenAI Model Spec repository root from the requested target.',
    },
    {
      label: 'official Microsoft Learn security documentation',
      objective: 'Correct Microsoft Graph security authorization.',
      toolName: 'WebFetch',
      input: { url: 'https://learn.microsoft.com/en-us/graph/security-authorization' },
      result: 'Fetched the current Microsoft Graph security authorization documentation.',
    },
    {
      label: 'official Docker documentation',
      objective: 'Harden Docker bind mounts for the production container.',
      toolName: 'WebFetch',
      input: { url: 'https://docs.docker.com/engine/storage/bind-mounts/' },
      result: 'Fetched the current official Docker bind-mount security documentation.',
    },
    {
      label: 'official systemd manual on freedesktop.org',
      objective: 'Harden the systemd service unit and verify its sandbox directives.',
      toolName: 'WebFetch',
      input: { url: 'https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html' },
      result: 'Fetched the current systemd.exec manual from the bounded official systemd manual tree.',
    },
    {
      label: 'official systemd repository manual',
      objective: 'Harden the systemd service unit and verify systemd.exec directives.',
      toolName: 'WebFetch',
      input: { url: 'https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.exec.xml' },
      result: 'Fetched the current systemd.exec manual source from the exact official repository path.',
    },
  ])('accepts $label as first-party security evidence', ({ objective, toolName, input, result }) => {
    const state = beginAuthorizedObjectiveEvidenceGate('s1', 'u1', objective, {
      risk: 'high-stakes',
      evidenceRequirement: 'authoritative-sources-before-mutation',
      domain: 'security',
    });
    expect(state).toBeDefined();
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(false);
    recordObjectiveEvidence('s1', toolName, result, false, undefined, input);
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(true);
  });

  it.each([
    {
      label: 'unrelated Docker page',
      objective: 'Correct the OpenAI agent security policy and secret handling.',
      url: 'https://docs.docker.com/engine/storage/bind-mounts/',
      result: 'Fetched the current official Docker bind-mount documentation successfully.',
    },
    {
      label: 'unrelated systemd page',
      objective: 'Correct Microsoft Graph security authorization.',
      url: 'https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html',
      result: 'Fetched the current systemd.exec documentation successfully from the target.',
    },
    {
      label: 'unbounded Docker path',
      objective: 'Harden Docker bind mounts for the production container.',
      url: 'https://docs.docker.com/engine/',
      result: 'Fetched a generic Docker Engine landing page from the requested target.',
    },
    {
      label: '404 result envelope',
      objective: 'Harden Docker bind mounts for the production container.',
      url: 'https://docs.docker.com/engine/storage/bind-mounts/',
      result: '404 Not Found: the requested official documentation page was unavailable.',
    },
    {
      label: 'structured JSON failure envelope',
      objective: 'Harden Docker bind mounts for the production container.',
      url: 'https://docs.docker.com/engine/storage/bind-mounts/',
      result: JSON.stringify({ success: false, status: 404, error: 'Not Found: official page unavailable' }),
    },
    {
      label: 'prose request failure envelope',
      objective: 'Harden Docker bind mounts for the production container.',
      url: 'https://docs.docker.com/engine/storage/bind-mounts/',
      result: 'Request failed with HTTP 404 while fetching the requested official documentation page.',
    },
    {
      label: 'unrelated GitHub billing documentation',
      objective: 'Correct the GitHub secret-scanning security policy.',
      url: 'https://docs.github.com/en/billing/managing-your-billing/about-billing-for-github-accounts',
      result: 'Fetched the current GitHub billing documentation successfully from the requested target.',
    },
    {
      label: 'unrelated Microsoft VBA documentation',
      objective: 'Correct Microsoft Graph security authorization.',
      url: 'https://learn.microsoft.com/en-us/office/vba/api/overview/',
      result: 'Fetched the current Microsoft VBA documentation successfully from the requested target.',
    },
    {
      label: 'unrelated OpenAI help page',
      objective: 'Correct the OpenAI agent security policy and secret handling.',
      url: 'https://help.openai.com/en/articles/6825453-chatgpt-release-notes',
      result: 'Fetched the current OpenAI product release notes successfully from the requested target.',
    },
  ])('rejects $label as authoritative security evidence', ({ label, objective, url, result }) => {
    const sessionId = `provider-negative-${label.replace(/\s+/g, '-')}`;
    const state = beginAuthorizedObjectiveEvidenceGate(sessionId, 'u1', objective, {
      risk: 'high-stakes',
      evidenceRequirement: 'authoritative-sources-before-mutation',
      domain: 'security',
    });
    expect(state).toBeDefined();
    recordObjectiveEvidence(sessionId, 'WebFetch', result, false, undefined, { url });
    expect(checkObjectiveEvidenceBeforeMutation(sessionId, 'Write', 'local-write').allowed).toBe(false);
  });

  it('does not confuse a successful error-handling document with a failed fetch envelope', () => {
    beginAuthorizedObjectiveEvidenceGate('s1', 'u1', 'Correct the GitHub secret-scanning security policy.', {
      risk: 'high-stakes', evidenceRequirement: 'authoritative-sources-before-mutation', domain: 'security',
    });
    recordObjectiveEvidence(
      's1', 'WebFetch',
      'Error handling guidance was fetched successfully from the official GitHub code-security documentation.',
      false, undefined,
      { url: 'https://docs.github.com/en/code-security/guides/error-handling' },
    );
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(true);
  });

  it.each([
    'https://docs.github.com.attacker.example/en/code-security',
    'https://github.com/Aoleon/rulebook-ai',
    'https://github.com/openai/not-the-model-spec',
    'https://github.com/openai/model_spec/issues/1',
    'https://raw.githubusercontent.com/attacker/model_spec/main/model_spec.md',
    'https://raw.githubusercontent.com/openai/model_spec-fork/main/model_spec.md',
    'https://raw.githubusercontent.com/openai/model_spec/main/docs/security.md',
    'https://docs.docker.com.attacker.example/engine/security/',
    'https://www.freedesktop.org/software/other-project/man/latest/security.html',
    'https://raw.githubusercontent.com/attacker/systemd/main/man/systemd.exec.xml',
    'https://raw.githubusercontent.com/systemd/systemd-fork/main/man/systemd.exec.xml',
    'https://raw.githubusercontent.com/systemd/systemd/main/src/core/main.c',
    'https://github.com/systemd/systemd/issues/1',
    'https://community.openai.com/t/user-authored-security-post/1',
    'https://learn.microsoft.com/en-us/answers/questions/123456/community-security-advice',
    'https://openai.com.attacker.example/security',
    'https://learn.microsoft.com.attacker.example/en-us/graph/security-authorization',
    'https://model-spec.openai.com:444/2026-08-18.html',
  ])('does not treat a lookalike or third-party provider URL as authoritative: %s', url => {
    beginAuthorizedObjectiveEvidenceGate('s1', 'u1', 'Correct the agent security policy and secret handling.', {
      risk: 'high-stakes',
      evidenceRequirement: 'authoritative-sources-before-mutation',
      domain: 'security',
    });
    recordObjectiveEvidence('s1', 'WebFetch', 'A sufficiently long fetched page that claims to be official provider documentation.', false,
      undefined, { url });
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(false);
  });

  it('does not let provider security documentation satisfy another high-stakes domain', () => {
    beginObjectiveEvidenceGate('s1', 'u1', 'Corrige ce contrat juridique.');
    recordObjectiveEvidence('s1', 'WebFetch', 'Fetched current GitHub security documentation from the requested target URL.', false,
      undefined, { url: 'https://docs.github.com/en/code-security' });
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(false);
  });

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

  it('lets the exact host registration protocol run without satisfying or bypassing the evidence gate', () => {
    // Sanitized replay of repeated legal-source refusals on a validation task:
    // registration itself does not create or alter a legal deliverable.
    beginObjectiveEvidenceGate('s1', 'u1', 'Corrige ce contrat juridique.');
    const gap = getObjectiveEvidenceCompletionGap('s1');
    for (const name of ['set_completion_criteria', 'session__set_completion_criteria', 'mcp__session__set_completion_criteria',
      'mcp__session__update_plan', 'mcp__session__wait_sessions']) {
      expect(checkObjectiveEvidenceBeforeMutation('s1', name, 'local-write').allowed).toBe(true);
      expect(getObjectiveEvidenceCompletionGap('s1')).toBe(gap);
    }
    for (const name of ['Write', 'spawn_session', 'session__spawn_session', 'mcp__session__spawn_session',
      'mcp__legal__set_completion_criteria', 'mcp__session__set_completion_criteria_and_write', 'mcp__other__update_plan']) {
      expect(checkObjectiveEvidenceBeforeMutation('s1', name, 'local-write').allowed).toBe(false);
    }
    recordObjectiveEvidence('s1', 'mcp__session__set_completion_criteria',
      '{"registered":true,"source":"https://www.legifrance.gouv.fr"}', false);
    expect(getObjectiveEvidenceCompletionGap('s1')).toBe(gap);
  });

  it('preserves a valid review across host registration while target mutation still invalidates it', () => {
    beginObjectiveEvidenceGate('s1', 'u1', 'Corrige ce contrat juridique.');
    recordObjectiveEvidence('s1', 'web_fetch', 'Source officielle https://eur-lex.europa.eu/legal-content/FR/TXT', false);
    recordObjectiveEvidence('s1', 'mcp__session__call_llm', JSON.stringify({
      verdict: 'PASS', criteria: [{ id: 'requested-outcome-delivered', passed: true }], findings: [],
    }), false);
    expect(getObjectiveEvidenceCompletionGap('s1')).toBeUndefined();
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'mcp__session__set_completion_criteria', 'local-write').allowed).toBe(true);
    expect(getObjectiveEvidenceCompletionGap('s1')).toBeUndefined();
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'Write', 'local-write').allowed).toBe(true);
    expect(getObjectiveEvidenceCompletionGap('s1')).toContain('review must be repeated');
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

  it('preserves the high-stakes review when delivering an internal report but invalidates it for an external send', () => {
    beginObjectiveEvidenceGate('s1', 'u1', 'Corrige ce contrat juridique.');
    recordObjectiveEvidence('s1', 'web_fetch', 'Source officielle https://eur-lex.europa.eu/legal-content/FR/TXT', false);
    recordObjectiveEvidence('s1', 'mcp__session__call_llm', JSON.stringify({
      verdict: 'PASS', criteria: [{ id: 'requested-outcome-delivered', passed: true }], findings: [],
    }), false);
    for (const tool of ['send_agent_message', 'session__send_agent_message', 'mcp__session__send_agent_message']) {
      expect(checkObjectiveEvidenceBeforeMutation('s1', tool, 'external-mutation').allowed).toBe(true);
      expect(getObjectiveEvidenceCompletionGap('s1')).toBeUndefined();
    }
    expect(checkObjectiveEvidenceBeforeMutation('s1', 'mcp__external__send_agent_message', 'external-mutation').allowed).toBe(true);
    expect(getObjectiveEvidenceCompletionGap('s1')).toContain('independent review must be repeated');
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

  it('reads only a requested completed review bound to the current objective and version', () => {
    const binding = { objectiveId: 'u1', acceptanceSha256: 'current-version' };
    const context = { ...binding, toolName: 'mcp__session__wait_sessions', sessionIds: ['reviewer'] };
    const receipt = { ...binding, verdict: 'PASS' as const, criteria: [{ id: 'checks', passed: true }], findings: [] };
    const snapshot: { sessionId: string; state: string; reason: string; finalText: string; finalMessageId?: string } = {
      sessionId: 'reviewer', state: 'idle', reason: 'complete', finalText: JSON.stringify(receipt),
    };
    const envelope = (sessions = [snapshot], outcome = 'completed') => JSON.stringify({ outcome, sessions });
    expect(parseIndependentReviewReceipt(envelope(), context)).toEqual(receipt);
    expect(parseIndependentReviewReceipt(envelope())).toBeUndefined();
    expect(parseIndependentReviewReceipt(JSON.stringify(receipt), context)).toBeUndefined();
    expect(parseIndependentReviewReceipt(envelope(), { ...context, sessionIds: [] })).toBeUndefined();
    expect(parseIndependentReviewReceipt(envelope(), { ...context, toolName: 'mcp__other__wait_sessions' })).toBeUndefined();
    for (const changes of [
      { sessionId: 'unrequested-reviewer' }, { state: 'active' }, { reason: 'error' }, { reason: undefined },
      { finalText: JSON.stringify({ ...receipt, objectiveId: 'old-objective' }) },
      { finalText: JSON.stringify({ ...receipt, acceptanceSha256: 'old-version' }) },
      { finalText: JSON.stringify({ verdict: 'PASS', criteria: receipt.criteria, findings: [] }) },
    ]) expect(parseIndependentReviewReceipt(envelope([{ ...snapshot, ...changes } as typeof snapshot]), context)).toBeUndefined();
    for (const flag of [{ finalTextTruncated: true }, { needsAttention: true }, { changed: false }]) {
      expect(parseIndependentReviewReceipt(envelope([{ ...snapshot, ...flag }]), context)).toBeUndefined();
    }
    expect(parseIndependentReviewReceipt(envelope([snapshot], 'timeout'), context)).toBeUndefined();
    expect(parseIndependentReviewReceipt(envelope([snapshot, snapshot]), context)).toBeUndefined();
    expect(parseIndependentReviewReceipt(envelope([snapshot, { ...snapshot, sessionId: 'second-reviewer' }]), {
      ...context, sessionIds: ['reviewer', 'second-reviewer'],
    })).toBeUndefined();
    // An unrelated snapshot cannot supply review evidence or make a current,
    // uniquely bound review disappear. A FAIL must remain a FAIL.
    expect(parseIndependentReviewReceipt(envelope([{ ...snapshot, sessionId: 'unrequested-reviewer' }, snapshot]), context)).toEqual(receipt);
    const hostFinalMessageId = 'msg-1789696901350-ac8dc51e3b062469960c0d6ad1a4b524';
    expect(parseIndependentReviewReceipt(envelope([{
      ...snapshot, finalMessageId: hostFinalMessageId,
    }]), context)).toEqual({ ...receipt, reviewMessageId: hostFinalMessageId });
    expect(parseIndependentReviewReceipt(envelope([{
      ...snapshot, finalMessageId: 'attacker-selected-parent-id',
    }]), context)).toEqual(receipt);
    const failed = { ...receipt, verdict: 'FAIL', findings: ['Target is not ready'] };
    expect(parseIndependentReviewReceipt(envelope([{ ...snapshot, finalText: JSON.stringify(failed) }]), context)?.verdict).toBe('FAIL');
    for (const finalText of [
      `Example:\n\`\`\`json\n${JSON.stringify(receipt)}\n\`\`\`\nActual review:\n\`\`\`json\n${JSON.stringify(failed)}\n\`\`\``,
      `Example:\n\`\`\`json\n${JSON.stringify(receipt)}\n\`\`\`\n${JSON.stringify(failed)}`,
      JSON.stringify(receipt).replace('"verdict":"PASS"', '"verdict":"FAIL","verdict":"PASS"'),
    ]) expect(parseIndependentReviewReceipt(envelope([{ ...snapshot, finalText }]), context)).toBeUndefined();
  });

  it('credits the bound wait envelope in the high-stakes gate without accepting an arbitrary bare PASS', () => {
    beginObjectiveEvidenceGate('s1', 'u1', 'Corrige cette écriture comptable.');
    recordObjectiveEvidence('s1', 'mcp__inqom__inqom_get_ledger', 'Grand livre vérifié : source comptable de première partie et écritures détaillées.', false);
    const context = { objectiveId: 'u1', acceptanceSha256: 'current-version', sessionIds: ['reviewer'] };
    const receipt = { objectiveId: 'u1', acceptanceSha256: 'current-version', verdict: 'PASS', criteria: [{ id: 'checks', passed: true }], findings: [] };
    recordObjectiveEvidence('s1', 'mcp__session__wait_sessions', JSON.stringify(receipt), false);
    expect(getObjectiveEvidenceCompletionGap('s1')).toBeDefined();
    const result = JSON.stringify({ outcome: 'completed', sessions: [{ sessionId: 'reviewer', state: 'idle', reason: 'complete', finalText: JSON.stringify(receipt) }] });
    recordObjectiveEvidence('s1', 'mcp__session__wait_sessions', result, false, context);
    expect(getObjectiveEvidenceCompletionGap('s1')).toBeUndefined();
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
