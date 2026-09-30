import { describe, expect, it } from 'bun:test';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import fixtures from './__fixtures__/review-recursion-20260909.json';
import { getDelegatedReviewRequest, HOST_PARENT_REVIEW_INSTRUCTION, prependHostDelegatedReviewerScope } from './delegated-review-outcome.ts';
import { ActiveDelegationDeduplicator, evaluateReviewDelegation, makeActiveDelegationKey } from './review-delegation-policy.ts';

const sources = ['rbw-servers'];
function objective(index = 0): ActiveSessionObjective {
  return { schemaVersion: 1, userMessageId: fixtures[index]!.objectiveId, objectiveId: fixtures[index]!.objectiveId,
    originalText: fixtures[index]!.prompt, startedAt: 1, budgetBaselineUsd: 0, tokenBaseline: 0,
    continuationCount: 0, orchestrationMode: 'mission', risk: 'high-stakes', requiresExecutionEvidence: true,
    completionCriteria: [], terminalState: 'active' };
}

describe('semantic review delegation admission — sanitized 24h chain', () => {
  it('recognizes all five exact-shaped review requests and prevents their review-of-review links', () => {
    for (let index = 0; index < fixtures.length; index++) {
      const request = getDelegatedReviewRequest(fixtures[index]!.prompt, sources);
      expect(request).toMatchObject({ target: '/srv/review-target', remote: { source: 'rbw-servers', server: 'dev' }, revision: 'a'.repeat(40) });
      if (index + 1 < fixtures.length) expect(evaluateReviewDelegation({ parentSessionId: 'parent', objective: objective(index),
        prompt: fixtures[index + 1]!.prompt, sourceSlugs: sources })).toMatchObject({ allowed: false, reason: 'review-of-review' });
    }
  });
  it('preserves ordinary delegation, changed targets/versions and host-verified arbitration', () => {
    const base = { parentSessionId: 'parent', objective: objective(), prompt: fixtures[1]!.prompt, sourceSlugs: sources };
    for (const prompt of ['Inspecte le fichier source et retourne les dépendances utilisées.',
      base.prompt.replace('/srv/review-target', '/srv/different-target'),
      base.prompt.replace(`HEAD ${'a'.repeat(40)}`, `HEAD ${'b'.repeat(40)}`),
      base.prompt.replaceAll('objective-0', 'distinct-evidence-objective')]) {
      expect(evaluateReviewDelegation({ ...base, prompt }).allowed).toBe(true);
    }
    expect(evaluateReviewDelegation({ ...base, parentSessionId: undefined }).allowed).toBe(true);
    expect(evaluateReviewDelegation({ ...base, arbitration: { verifiedConflictingReviewIds: ['review-a', 'review-b'] } }).allowed).toBe(true);
    expect(evaluateReviewDelegation({ ...base, arbitration: { verifiedConflictingReviewIds: ['review-a', 'review-a'] } }).allowed).toBe(false);
  });
  it('never lets a host-bound reviewer create a review-of-review by changing its declared target', () => {
    const current = objective();
    current.delegatedRole = 'reviewer';
    current.originalText = `${prependHostDelegatedReviewerScope('Inspect the immutable host target.')}

<host_parent_review_contract>${JSON.stringify({
      protocol: 'host-review-v2',
      objectiveId: 'parent-objective',
      acceptanceSha256: 'b'.repeat(64),
      criteria: ['requested-outcome-delivered'],
      targetChecks: [],
      singleTarget: { target: '/srv/review-target', revision: 'a'.repeat(40) },
      instruction: HOST_PARENT_REVIEW_INSTRUCTION,
    })}</host_parent_review_contract>`;
    const changedTarget = fixtures[1]!.prompt.replace('/srv/review-target', '/srv/different-target');
    expect(evaluateReviewDelegation({ parentSessionId: 'parent', objective: current,
      prompt: changedTarget, sourceSlugs: sources })).toMatchObject({ allowed: false, reason: 'review-of-review' });
    expect(evaluateReviewDelegation({ parentSessionId: 'parent', objective: current,
      prompt: 'Inspecte en lecture seule une autre cible.', proposedRole: 'reviewer',
      sourceSlugs: sources })).toMatchObject({ allowed: false, reason: 'review-of-review' });
    expect(evaluateReviewDelegation({ parentSessionId: 'parent', objective: current,
      prompt: 'Extrais les métadonnées nécessaires.', proposedRole: 'worker',
      sourceSlugs: sources }).allowed).toBe(true);
    expect(evaluateReviewDelegation({ parentSessionId: 'parent', objective: current,
      prompt: changedTarget, sourceSlugs: sources,
      proposedRole: 'reviewer',
      arbitration: { verifiedConflictingReviewIds: ['review-a', 'review-b'] } }).allowed).toBe(true);
  });
  it('does not qualify ambiguous bindings, optional reading, or actual corrective work as terminal reviews', () => {
    for (const prompt of [fixtures[0]!.prompt + ' Puis corrige le code.',
      fixtures[0]!.prompt + ' Apporte les corrections.',
      fixtures[0]!.prompt.replace('en lecture seule', 'en lecture seule si possible'),
      fixtures[0]!.prompt + ` {"objectiveId":"other","acceptanceSha256":"${'b'.repeat(64)}"}`]) {
      expect(getDelegatedReviewRequest(prompt, sources)).toBeUndefined();
    }
  });
});

const keyInput = { workspaceId: 'workspace', rootObjectiveId: 'root-goal', parentObjectiveId: 'parent-goal', prompt: 'Exact task',
  targetConfiguration: { connection: 'current', model: 'current', permissionMode: 'safe', sources: ['source'], attachments: [] } };
describe('exact active child deduplication', () => {
  it('binds every effective configuration field and objective without normalizing prompt prose', () => {
    const key = makeActiveDelegationKey(keyInput);
    expect(key).toHaveLength(64);
    for (const changed of [{ rootObjectiveId: 'new-root' }, { parentObjectiveId: 'new-parent' }, { workspaceId: 'other' },
      { prompt: 'Exact task ' }, { targetConfiguration: { ...keyInput.targetConfiguration, permissionMode: 'allow-all' } },
      { targetConfiguration: { ...keyInput.targetConfiguration, attachments: [{ sha256: 'changed-content' }] } }]) {
      expect(makeActiveDelegationKey({ ...keyInput, ...changed })).not.toBe(key);
    }
    expect(makeActiveDelegationKey({ ...keyInput, targetConfiguration: { invalid: undefined } })).toBeUndefined();
    expect(makeActiveDelegationKey({ ...keyInput, targetConfiguration: { get secret() { throw new Error('must not run'); } } })).toBeUndefined();
  });
  it('shares concurrent creation and active work, never reuses a completed result', async () => {
    const cache = new ActiveDelegationDeduplicator<{ sessionId: string }>();
    let calls = 0; let active = true;
    const create = async () => ({ sessionId: `child-${++calls}` });
    const key = makeActiveDelegationKey(keyInput);
    const [first, duplicate] = await Promise.all([cache.run(key, create, () => active), cache.run(key, create, () => active)]);
    expect(calls).toBe(1); expect(first.reused).toBe(false); expect(duplicate.reused).toBe(true);
    expect(duplicate.value).toEqual(first.value);
    expect((await cache.run(key, create, () => active)).reused).toBe(true);
    active = false;
    expect((await cache.run(key, create, () => active)).value.sessionId).toBe('child-2');
    expect(calls).toBe(2);
  });
  it('releases failures so a genuine retry can make progress', async () => {
    const cache = new ActiveDelegationDeduplicator<{ sessionId: string }>();
    let calls = 0;
    const create = async () => { if (!calls++) throw new Error('transport unavailable'); return { sessionId: 'recovered' }; };
    const key = makeActiveDelegationKey(keyInput);
    await expect(cache.run(key, create, () => true)).rejects.toThrow('transport unavailable');
    expect((await cache.run(key, create, () => true)).value.sessionId).toBe('recovered');
    cache.release('recovered');
    expect((await cache.run(key, create, () => true)).reused).toBe(false);
  });
});
