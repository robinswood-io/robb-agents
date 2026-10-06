import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupModeState,
  deriveTerminalReconciliationInvocationCapability,
  TERMINAL_RECONCILIATION_CAPABILITY_FIELD,
  type PermissionMode,
} from '@craft-agent/shared/agent';
import { pickSessionFields, type SessionDelegation } from '@craft-agent/shared/sessions';
import { createSession as createStoredSession, loadSession, listSessions } from '@craft-agent/shared/sessions/storage';
import { createManagedSession, SessionManager } from './SessionManager.ts';
import { objectiveReviewBinding, transitionObjectiveContract } from './objective-contract.ts';
import { HOST_DELEGATED_REVIEWER_PREFIX } from './delegated-review-outcome.ts';

type Managed = ReturnType<typeof createManagedSession>;
type CreateOptions = NonNullable<Parameters<SessionManager['createSession']>[1]>;
const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });

function harness(permissionMode: PermissionMode = 'allow-all') {
  const rootPath = mkdtempSync(join(tmpdir(), 'robb-delegation-host-'));
  const workspace = { id: 'workspace', name: 'Test', slug: 'test', rootPath, createdAt: 1 };
  const parent = createManagedSession({ id: 'root', permissionMode, projectId: 'project-1',
    llmConnection: 'test-connection', model: 'test-model', enabledSourceSlugs: ['documents'] }, workspace);
  parent.isProcessing = true;
  parent.activeObjective = transitionObjectiveContract({ messageId: 'root-request', text: 'Vérifie les documents fournis.', nowMs: 1 });
  const manager = new SessionManager();
  const internals = manager as unknown as {
    sessions: Map<string, Managed>;
    spawnDelegatedSession: (parent: Managed, input: unknown) => Promise<{ sessionId: string; status: string }>;
    createSession: (workspaceId: string, options: CreateOptions, internal: { delegation: SessionDelegation }) => Promise<unknown>;
    flushSession: (sessionId: string) => Promise<void>;
    persistSession: (session: Managed) => void;
    sendMessage: (sessionId: string, prompt: string, ...args: unknown[]) => Promise<void>;
    sendEvent: () => void;
    resolveObjectiveMutationAuthority: (managed: Managed, objective: Managed['activeObjective']) => {
      terminalReconciliationPolicy?: {
        invocationCapabilityKey?: string;
        waitReviewerSessionIds: string[];
      };
    };
    consumeTerminalInvocationCapability: (
      managed: Managed,
      toolName: string,
      input: Record<string, unknown>,
      presented?: string,
    ) => boolean;
  };
  internals.sessions.set(parent.id, parent);
  const creations: Array<{ options: CreateOptions; delegation: SessionDelegation }> = [];
  const sent: Array<{ sessionId: string; prompt: string; permissionMode?: PermissionMode }> = [];
  const persisted: Array<Pick<Managed, 'id' | 'permissionMode' | 'delegation'>> = [];
  internals.persistSession = session => { persisted.push(JSON.parse(JSON.stringify(pickSessionFields(session)))); };
  internals.flushSession = async () => {};
  internals.sendEvent = () => {};
  internals.sendMessage = async (sessionId, prompt, ...args) => {
    sent.push({ sessionId, prompt, permissionMode: internals.sessions.get(sessionId)?.permissionMode });
    const acknowledge = args[5] as ((messageId: string) => void) | undefined;
    acknowledge?.(`${sessionId}-durable-dispatch`);
  };
  // Only external boundaries are replaced: exercise the real host admission, budget,
  // request parsing, route inheritance, review binding, and dispatch method.
  internals.createSession = async (_workspaceId, options, internal) => {
    creations.push({ options, delegation: internal.delegation });
    const child = createManagedSession({ id: `child-${creations.length}`, ...options,
      delegation: internal.delegation } as never, workspace);
    internals.sessions.set(child.id, child);
    internals.persistSession(child);
    return child;
  };
  cleanup.push(() => {
    for (const id of internals.sessions.keys()) cleanupModeState(id);
    rmSync(rootPath, { recursive: true, force: true });
  });
  const spawn = (input: Record<string, unknown> = { prompt: 'Inspecte la cible précise.' }) => {
    const policy = parent.activeObjective
      ? internals.resolveObjectiveMutationAuthority(parent, parent.activeObjective)
        .terminalReconciliationPolicy
      : undefined;
    const capability = deriveTerminalReconciliationInvocationCapability(
      policy?.invocationCapabilityKey,
      'mcp__session__spawn_session',
      input,
    );
    return internals.spawnDelegatedSession(parent, capability ? {
      ...input,
      [TERMINAL_RECONCILIATION_CAPABILITY_FIELD]: capability,
    } : input);
  };
  return { parent, manager, internals, creations, sent, persisted, spawn };
}

function makeInitialTerminalReviewReady(parent: Managed): void {
  const objective = parent.activeObjective!;
  parent.activeObjective = {
    ...objective,
    risk: 'high-stakes',
    requiresAcceptanceCriteria: true,
    completionCriteria: [...objective.completionCriteria, 'independent-review-passed'],
    acceptanceCriteria: [{
      id: 'target-observed',
      description: 'The exact target state is observed.',
      toolName: 'mcp__documents__inspect',
      input: { target: 'document-1' },
      checks: [{ path: '$.ok', equals: true }],
    }],
    acceptanceRegisteredRevision: objective.acceptanceRevision ?? objective.userMessageId,
    acceptanceRegisteredAt: 3,
    terminalReconciliation: {
      messageId: 'terminal-close',
      timestamp: 2,
      initialAcceptanceRegistrationRequired: true,
    },
  };
}

describe('real host delegated-session dispatch', () => {
  it('rejects invalid aliases and model-supplied lineage before any child exists', async () => {
    const h = harness();
    for (const extra of [{ permissionMode: 'execute' }, { permissionMode: 'read-only' }, { depth: 0 }, { rootSessionId: 'fake' }]) {
      await expect(h.spawn({ prompt: 'Inspecte.', ...extra })).rejects.toMatchObject({
        code: 'invalid_spawn_session_arguments', retryable: false,
      });
    }
    expect(h.creations).toHaveLength(0); expect(h.sent).toHaveLength(0);
    await expect(h.spawn({ prompt: 'Inspecte une cible non précisée.', role: 'reviewer' }))
      .rejects.toThrow('one explicit, unambiguous inspection target');
    expect(h.creations).toHaveLength(0); expect(h.sent).toHaveLength(0);
    for (const prompt of [
      'Inspecte la cible /srv/review, commit aaaaaaa puis commit bbbbbbb.',
      'Inspecte la cible /srv/review. Le commit hôte 7ca5804f ne constitue pas la révision de la cible.',
    ]) {
      await expect(h.spawn({ prompt, role: 'reviewer' }))
        .rejects.toThrow('one explicit, unambiguous inspection target');
    }
    expect(h.creations).toHaveLength(0); expect(h.sent).toHaveLength(0);
    await expect(h.spawn()).resolves.toMatchObject({ status: 'started' });
  });

  it('passes host lineage into initial creation, preserves it on hydration, and binds a safe reviewer to its parent', async () => {
    const h = harness();
    const result = await h.spawn({ prompt: 'Contrôle la cible /srv/review et rends PASS ou FAIL.', role: 'reviewer', permissionMode: 'allow-all' });
    const creation = h.creations[0]!;
    expect(creation.options).toMatchObject({ permissionMode: 'safe', projectId: 'project-1', parentSessionId: 'root', enabledSourceSlugs: ['documents'] });
    expect(creation.delegation).toMatchObject({ rootSessionId: 'root', rootObjectiveId: 'root-request', parentObjectiveId: 'root-request', depth: 1, role: 'reviewer' });
    const restored = createManagedSession(h.persisted[0] as never, h.parent.workspace);
    expect(restored.delegation).toEqual(creation.delegation);
    expect(h.sent[0]).toMatchObject({ sessionId: result.sessionId, permissionMode: 'safe' });
    expect(h.sent[0]!.prompt.startsWith(`${HOST_DELEGATED_REVIEWER_PREFIX}\n\n`)).toBe(true);
    expect(h.sent[0]!.prompt).toContain('"protocol":"host-review-v2"');
    expect(h.sent[0]!.prompt).toContain('"singleTarget":{"target":"/srv/review"}');
    // The origin record remains current; a reviewer cannot delegate again.
    restored.isProcessing = true; h.internals.sessions.set(restored.id, restored);
    await expect(h.internals.spawnDelegatedSession(restored, { prompt: 'Sous-revue.' })).rejects.toThrow('reviewer');
  });

  it('admits exactly one host-bound initial reviewer during terminal reconciliation', async () => {
    const blocked = harness();
    blocked.parent.activeObjective = {
      ...blocked.parent.activeObjective!,
      terminalReconciliation: { messageId: 'terminal-close', timestamp: 2 },
    };
    await expect(blocked.spawn({ prompt: 'Review.', role: 'reviewer' }))
      .rejects.toThrow('terminal reviewer-dispatch capability is missing');
    expect(blocked.creations).toHaveLength(0);

    const stale = harness();
    makeInitialTerminalReviewReady(stale.parent);
    stale.parent.activeObjective!.acceptanceRegisteredRevision = 'stale-revision';
    await expect(stale.spawn({ prompt: 'Review stale binding.', role: 'reviewer' }))
      .rejects.toThrow('terminal reviewer-dispatch capability is missing');
    expect(stale.creations).toHaveLength(0);

    const h = harness();
    makeInitialTerminalReviewReady(h.parent);
    await expect(h.spawn({ prompt: 'Inspect the exact target.', role: 'reviewer' }))
      .resolves.toMatchObject({ status: 'started' });
    expect(h.sent[0]!.prompt.startsWith(`${HOST_DELEGATED_REVIEWER_PREFIX}\n\n`)).toBe(true);
    expect(h.sent[0]!.prompt).toContain('<host_parent_review_context_base64url>');
    expect(h.sent[0]!.prompt).toContain('<host_parent_review_contract>');
    expect(h.sent[0]!.prompt).toContain('"protocol":"host-review-v2"');
    expect(h.sent[0]!.prompt).toContain('root-request');
    const dispatched = h.internals.sessions.get('child-1');
    dispatched!.activeObjective = transitionObjectiveContract({
      messageId: 'review-root',
      text: 'Review the exact host-bound target in read-only mode.',
      nowMs: 4,
      delegatedRole: 'reviewer',
    });
    await expect(h.spawn({ prompt: 'Try a differently worded second review.', role: 'reviewer' }))
      .rejects.toThrow('terminal reviewer-dispatch capability is missing');
    expect(h.creations).toHaveLength(1);
  });

  it('serializes concurrent terminal reviewer dispatches by the host binding', async () => {
    const h = harness();
    makeInitialTerminalReviewReady(h.parent);
    const results = await Promise.allSettled([
      h.spawn({ prompt: 'Review route A.', role: 'reviewer' }),
      h.spawn({ prompt: 'Review route B.', role: 'reviewer', name: 'alternate' }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(h.creations).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
  });

  it('retires a reviewer whose parent binding changes while the child prompt is hydrating', async () => {
    const h = harness();
    makeInitialTerminalReviewReady(h.parent);
    let releaseHydration!: () => void;
    let markHydrationEntered!: () => void;
    const hydrationEntered = new Promise<void>(resolve => { markHydrationEntered = resolve; });
    const hydrationGate = new Promise<void>(resolve => { releaseHydration = resolve; });
    const host = h.manager as unknown as {
      ensureMessagesLoaded: (managed: Managed) => Promise<void>;
      getOrCreateAgent: () => Promise<never>;
      sendMessage: SessionManager['sendMessage'];
    };
    host.sendMessage = SessionManager.prototype.sendMessage.bind(h.manager);
    host.ensureMessagesLoaded = async managed => {
      if (managed.id === 'child-1') {
        markHydrationEntered();
        await hydrationGate;
      }
      managed.messagesLoaded = true;
    };
    let childFlushes = 0;
    h.internals.flushSession = async sessionId => {
      if (sessionId === 'child-1') childFlushes++;
    };
    let providerStarts = 0;
    host.getOrCreateAgent = async () => {
      providerStarts++;
      throw new Error('A stale delegated prompt must not reach runtime preparation');
    };

    const spawning = h.spawn({ prompt: 'Review target A.', role: 'reviewer' });
    await Promise.race([
      hydrationEntered,
      Bun.sleep(1_000).then(() => { throw new Error('Child hydration was not reached'); }),
    ]);
    h.parent.activeObjective = transitionObjectiveContract({
      messageId: 'target-b',
      text: 'Inspect target B instead.',
      nowMs: 10,
    });
    releaseHydration();
    await expect(spawning).rejects.toThrow('superseded');

    const child = h.internals.sessions.get('child-1')!;
    for (let attempt = 0; attempt < 50
      && (!child.delegation?.finishedAt || childFlushes < 2); attempt++) {
      await Bun.sleep(2);
    }
    expect(providerStarts).toBe(0);
    expect(child.messages.some(message => message.internalOrigin?.kind === 'spawned-session')).toBe(false);
    expect(child.isProcessing).toBe(false);
    expect(child.delegation?.finishedAt).toBeNumber();
    expect(childFlushes).toBeGreaterThanOrEqual(2);
    expect(h.persisted.at(-1)?.delegation?.finishedAt).toBeNumber();
  });

  it('rejects one-shot terminal coordination capabilities after an objective amendment', async () => {
    const h = harness();
    makeInitialTerminalReviewReady(h.parent);
    const spawnInput = { prompt: 'Review target A.', role: 'reviewer' as const, permissionMode: 'safe' as const };
    const policy = h.internals.resolveObjectiveMutationAuthority(
      h.parent,
      h.parent.activeObjective,
    ).terminalReconciliationPolicy!;
    const capability = deriveTerminalReconciliationInvocationCapability(
      policy.invocationCapabilityKey,
      'mcp__session__spawn_session',
      spawnInput,
    )!;
    const objectiveA = h.parent.activeObjective!;
    h.parent.activeObjective = {
      ...objectiveA,
      lastUserMessageId: 'amend-target-b',
      acceptanceRevision: 'amend-target-b',
      acceptanceNeedsReview: true,
    };

    await expect(h.internals.spawnDelegatedSession(h.parent, {
      ...spawnInput,
      [TERMINAL_RECONCILIATION_CAPABILITY_FIELD]: capability,
    })).rejects.toThrow('missing, stale, or belongs to another objective revision');
    expect(h.creations).toHaveLength(0);

    const registration = harness();
    const registrationObjective = registration.parent.activeObjective!;
    registration.parent.activeObjective = {
      ...registrationObjective,
      requiresAcceptanceCriteria: true,
      acceptanceCriteria: undefined,
      terminalReconciliation: {
        messageId: 'terminal-before-registration',
        timestamp: 2,
        initialAcceptanceRegistrationRequired: true,
      },
    };
    const criteriaPolicy = registration.internals.resolveObjectiveMutationAuthority(
      registration.parent,
      registration.parent.activeObjective,
    ).terminalReconciliationPolicy!;
    const criteriaInput = {
      criteria: [{
        id: 'target-b', description: 'Target B is current', toolName: 'mcp__documents__inspect',
        input: { target: 'document-b' }, checks: [{ path: '$.ok', equals: true }],
      }],
    };
    const staleCriteriaCapability = deriveTerminalReconciliationInvocationCapability(
      criteriaPolicy.invocationCapabilityKey,
      'mcp__session__set_completion_criteria',
      criteriaInput,
    )!;
    registration.parent.activeObjective = {
      ...registration.parent.activeObjective!,
      lastUserMessageId: 'amend-registration-target',
      acceptanceRevision: 'amend-registration-target',
    };
    expect(registration.internals.consumeTerminalInvocationCapability(
      registration.parent,
      'mcp__session__set_completion_criteria',
      {
        ...criteriaInput,
        [TERMINAL_RECONCILIATION_CAPABILITY_FIELD]: staleCriteriaCapability,
      },
      staleCriteriaCapability,
    )).toBe(false);
  });

  it('binds explicit wait modes into one-shot terminal capabilities', () => {
    const h = harness();
    makeInitialTerminalReviewReady(h.parent);
    const binding = objectiveReviewBinding(h.parent.activeObjective!);
    const reviewer = createManagedSession({
      id: 'bound-reviewer',
      parentSessionId: h.parent.id,
      delegation: {
        rootSessionId: h.parent.id,
        rootObjectiveId: binding.objectiveId,
        parentObjectiveId: binding.objectiveId,
        depth: 1,
        role: 'reviewer',
        reviewBinding: binding,
      },
    } as never, h.parent.workspace, { messagesLoaded: true });
    reviewer.activeObjective = transitionObjectiveContract({
      messageId: 'reviewer-objective', text: 'Inspect the bound target.', nowMs: 4,
    });
    h.internals.sessions.set(reviewer.id, reviewer);

    const consume = (mode: 'first' | 'all', presentedInput?: Record<string, unknown>) => {
      const policy = h.internals.resolveObjectiveMutationAuthority(
        h.parent,
        h.parent.activeObjective,
      ).terminalReconciliationPolicy!;
      expect(policy.waitReviewerSessionIds).toEqual([reviewer.id]);
      const input = { sessionIds: [reviewer.id], mode };
      const capability = deriveTerminalReconciliationInvocationCapability(
        policy.invocationCapabilityKey,
        'mcp__session__wait_sessions',
        input,
      )!;
      const operational = presentedInput ?? input;
      return {
        capability,
        accepted: h.internals.consumeTerminalInvocationCapability(
          h.parent,
          'mcp__session__wait_sessions',
          {
            ...operational,
            [TERMINAL_RECONCILIATION_CAPABILITY_FIELD]: capability,
          },
          capability,
        ),
      };
    };

    const first = consume('first');
    expect(first.accepted).toBe(true);
    expect(h.internals.consumeTerminalInvocationCapability(
      h.parent,
      'mcp__session__wait_sessions',
      {
        sessionIds: [reviewer.id], mode: 'first',
        [TERMINAL_RECONCILIATION_CAPABILITY_FIELD]: first.capability,
      },
      first.capability,
    )).toBe(false);
    expect(consume('all').accepted).toBe(true);
    expect(consume('first', { sessionIds: [reviewer.id] }).accepted).toBe(false);
  });

  it('retires a cold orphan created before reviewer prompt dispatch but keeps a durable attempt', async () => {
    const orphaned = harness();
    makeInitialTerminalReviewReady(orphaned.parent);
    const lineage: SessionDelegation = {
      rootSessionId: orphaned.parent.id,
      rootObjectiveId: orphaned.parent.activeObjective!.objectiveId!,
      parentObjectiveId: orphaned.parent.activeObjective!.objectiveId!,
      depth: 1,
      role: 'reviewer',
    };
    const orphan = createManagedSession({
      id: 'cold-orphan', parentSessionId: orphaned.parent.id, createdAt: 4, delegation: lineage,
    } as never, orphaned.parent.workspace, { messagesLoaded: false });
    orphaned.internals.sessions.set(orphan.id, orphan);
    await expect(orphaned.spawn({ prompt: 'Dispatch the recoverable review.', role: 'reviewer' }))
      .resolves.toMatchObject({ status: 'started' });
    expect(orphan.delegation?.finishedAt).toBeNumber();
    expect(orphaned.creations).toHaveLength(1);

    const durable = harness();
    makeInitialTerminalReviewReady(durable.parent);
    const persisted = createManagedSession({
      id: 'cold-durable-review', parentSessionId: durable.parent.id, createdAt: 4,
      delegation: {
        rootSessionId: durable.parent.id,
        rootObjectiveId: durable.parent.activeObjective!.objectiveId!,
        parentObjectiveId: durable.parent.activeObjective!.objectiveId!,
        depth: 1,
        role: 'reviewer',
        finishedAt: 5,
      },
      activeObjective: transitionObjectiveContract({
        messageId: 'durable-review-root',
        text: 'Review the exact host-bound target in read-only mode.',
        nowMs: 4,
        delegatedRole: 'reviewer',
      }),
    } as never, durable.parent.workspace, { messagesLoaded: false });
    durable.internals.sessions.set(persisted.id, persisted);
    await expect(durable.spawn({ prompt: 'Do not duplicate the durable review.', role: 'reviewer' }))
      .rejects.toThrow('already dispatched the reviewer');
    expect(durable.creations).toHaveLength(0);
  });

  it('writes lineage in the first real storage record before dispatch or a later metadata save', async () => {
    const h = harness();
    h.internals.createSession = async (_workspaceId, options, internal) => {
      const stored = await createStoredSession(h.parent.workspace.rootPath, { ...options, delegation: internal.delegation } as never);
      // Read the real JSONL immediately after creation: no host persist/flush has occurred.
      expect(loadSession(h.parent.workspace.rootPath, stored.id)?.delegation).toEqual(internal.delegation);
      expect(listSessions(h.parent.workspace.rootPath).find(item => item.id === stored.id)?.delegation).toEqual(internal.delegation);
      const child = createManagedSession(stored, h.parent.workspace);
      h.internals.sessions.set(child.id, child);
      return child;
    };
    const result = await h.spawn({ prompt: 'Examine le document cible /srv/document.', role: 'reviewer' });
    expect(h.persisted).toHaveLength(0);
    const { messages: _messages, ...metadata } = loadSession(h.parent.workspace.rootPath, result.sessionId)!;
    const restored = createManagedSession(metadata, h.parent.workspace);
    expect(restored.delegation).toMatchObject({ rootSessionId: 'root', depth: 1, role: 'reviewer' });
    expect(restored.permissionMode).toBe('safe');
  });

  it('caps an explicit worker mode at its parent and applies a revocation during asynchronous preparation', async () => {
    const h = harness('ask');
    await h.spawn({ prompt: 'Inspecte.', permissionMode: 'allow-all' });
    expect(h.sent[0]!.permissionMode).toBe('ask');
    h.parent.permissionMode = 'allow-all';
    h.internals.flushSession = async () => { h.parent.permissionMode = 'safe'; };
    await h.spawn({ prompt: 'Inspecte une autre cible.', permissionMode: 'allow-all' });
    expect(h.sent[1]!.permissionMode).toBe('safe');
    expect(h.persisted.at(-1)).toMatchObject({ permissionMode: 'safe' });
  });

  it('reserves parallel child creation before its first asynchronous boundary', async () => {
    const h = harness();
    const create = h.internals.createSession;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    h.internals.createSession = async (...args) => { await pending; return create(...args); };
    // The historical root envelope counts the processing parent: three slots remain.
    const children = Array.from({ length: 3 }, (_, i) => h.spawn({ prompt: `Inspecte la cible ${i}.` }));
    await expect(h.spawn({ prompt: 'Inspecte la quatrième cible.' })).rejects.toThrow('root_capacity');
    expect(h.creations).toHaveLength(0);
    release(); await Promise.all(children);
    expect(h.creations).toHaveLength(3); expect(h.sent).toHaveLength(3);
  });

  it('releases every failed creation reservation without dispatching or consuming child count', async () => {
    const h = harness(); const create = h.internals.createSession;
    h.internals.createSession = async () => { throw new Error('Local creation unavailable'); };
    for (let i = 0; i < 5; i++) await expect(h.spawn()).rejects.toThrow('Local creation unavailable');
    expect(h.sent).toHaveLength(0);
    h.internals.createSession = create;
    await expect(h.spawn()).resolves.toMatchObject({ status: 'started' });
  });

  it('marks an inert child finished when persistence fails before dispatch', async () => {
    const h = harness();
    h.internals.flushSession = async () => { throw new Error('Persistence unavailable'); };
    await expect(h.spawn()).rejects.toThrow('Persistence unavailable');
    expect(h.sent).toHaveLength(0);
    expect(h.persisted.at(-1)?.delegation?.finishedAt).toBeNumber();
    h.internals.flushSession = async () => {};
    await expect(h.spawn()).resolves.toMatchObject({ status: 'started' });
  });

  it('blocks stale dispatch when the originating objective changes during flush', async () => {
    const h = harness();
    h.internals.flushSession = async () => {
      h.parent.activeObjective = transitionObjectiveContract({ messageId: 'new-request', text: 'Autre objectif.', nowMs: 2 });
    };
    await expect(h.spawn()).rejects.toThrow('no longer current');
    expect(h.sent).toHaveLength(0);
    expect(h.persisted.at(-1)?.delegation?.finishedAt).toBeNumber();
  });

  it('never acknowledges started when dispatch fails and persists a consumable child failure', async () => {
    const h = harness();
    h.internals.sendMessage = async () => { throw new Error('Transport unavailable'); };
    await expect(h.spawn()).rejects.toThrow('Transport unavailable');
    expect(h.persisted.at(-1)?.delegation?.finishedAt).toBeNumber();
    expect(h.internals.sessions.get('child-1')?.messages.find(message => (
      message.role === 'error'
      && message.errorCode === 'delegated_dispatch_failed'
    ))).toMatchObject({ errorCanRetry: true });
    expect(h.sent).toHaveLength(0);
  });
});
