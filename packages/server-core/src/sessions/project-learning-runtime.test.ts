import * as configStorage from '@craft-agent/shared/config/storage';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@craft-agent/core/types';
import { clearObjectiveEvidenceGate } from '@craft-agent/shared/agent';
import { createProject, loadProjectMemoryJournal, loadProjectMemoryV2Context } from '@craft-agent/shared/projects';
import { createDefaultWorkspaceGovernance, WorkspaceGovernanceStore } from '@craft-agent/shared/governance';
import { createManagedSession, SessionManager } from './SessionManager.ts';
import { transitionObjectiveContract } from './objective-contract.ts';
import { registerObjectiveAcceptanceCriteria } from './objective-acceptance-criteria.ts';

type Managed = ReturnType<typeof createManagedSession>;
const fixtures: Array<{ root: string; id: string }> = [];
afterEach(() => {
  for (const { root, id } of fixtures.splice(0)) {
    clearObjectiveEvidenceGate(id);
    rmSync(root, { recursive: true, force: true });
  }
});

function harness(stream: AgentEvent[] = [], beforeChat?: () => void) {
  const root = mkdtempSync(join(tmpdir(), 'robb-learning-runtime-'));
  const id = `learning-runtime-${fixtures.length}`;
  fixtures.push({ root, id });
  const project = createProject(root, { name: 'Isolated learning fixture' });
  const manager = new SessionManager();
  const managed = createManagedSession({ id, projectId: project.id }, {
    id: 'learning-workspace', slug: 'learning-workspace', name: 'Learning fixture', rootPath: root, createdAt: 1,
  }, { messagesLoaded: true });
  managed.lastUsedByApp = { appVersion: 'test', buildCommit: 'fixture-build', buildChannel: 'development', buildDirty: false, isPackaged: false };
  managed.messages = [
    { id: 'objective', role: 'user', content: 'Prépare puis vérifie le document.', timestamp: 1 },
    { id: 'answer', role: 'assistant', content: 'Le document est complet.', timestamp: 2 },
  ];
  managed.activeObjective = transitionObjectiveContract({ messageId: 'objective', text: managed.messages[0]!.content, nowMs: 1 });
  const runtime = manager as unknown as {
    sessions: Map<string, Managed>; enqueuePersist: () => void; persistSession: () => boolean; flushSession: () => Promise<void>;
    sendEvent: () => void; emitExecutionTelemetry: () => void; startGenerationTelemetry: () => void; finishGenerationTelemetry: () => void;
    beginAutomaticSessionStatusLifecycle: () => Promise<void>; finishAutomaticSessionStatusLifecycle: () => Promise<void>;
    isSessionBeingViewed: () => boolean; markSessionRead: () => Promise<void>; processNextQueuedMessage: () => void;
    disposeManagedAgentRuntime: () => Promise<void>; getOrCreateAgent: (m: Managed) => Promise<unknown>;
    enqueueAutomaticTurnRecovery: () => Promise<boolean>;
    processEvent: (m: Managed, event: AgentEvent) => Promise<void>;
    onProcessingStopped: (id: string, reason: 'error') => Promise<void>;
  };
  runtime.sessions.set(id, managed);
  // Stub UI/session IO and the provider only. Real sendMessage, objective
  // transition, event processing, policy reads and project journal writes run.
  runtime.enqueuePersist = () => {}; runtime.persistSession = () => true; runtime.flushSession = async () => {};
  runtime.sendEvent = () => {}; runtime.emitExecutionTelemetry = () => {};
  runtime.startGenerationTelemetry = () => {}; runtime.finishGenerationTelemetry = () => {};
  runtime.beginAutomaticSessionStatusLifecycle = async () => {}; runtime.finishAutomaticSessionStatusLifecycle = async () => {};
  runtime.isSessionBeingViewed = () => true; runtime.markSessionRead = async () => {};
  runtime.processNextQueuedMessage = () => {}; runtime.disposeManagedAgentRuntime = async () => { managed.agent = null; };
  runtime.enqueueAutomaticTurnRecovery = async () => false;
  const agent = {
    async *chat(): AsyncGenerator<AgentEvent> { beforeChat?.(); for (const event of stream) yield event; },
    getModel: () => 'fixture/local', getSessionId: () => null, setAllSources: () => {},
    isProcessing: () => false, redirect: () => true,
  };
  managed.agent = agent as never;
  runtime.getOrCreateAgent = async session => { session.agent = agent as never; return agent; };
  return { manager, managed, runtime, root, project };
}

describe('SessionManager runtime project learning', () => {
  it('stops an over-budget autonomous delivery before any provider preparation', async () => {
    const h = harness();
    let providerPreparations = 0;
    h.runtime.getOrCreateAgent = async () => {
      providerPreparations += 1;
      throw new Error('provider preparation must stay unreachable');
    };
    const configSpy = spyOn(configStorage, 'loadStoredConfig').mockReturnValue({ workspaces: [], activeWorkspaceId: null, activeSessionId: null, defaultLlmConnection: 'paid-fixture', llmConnections: [{ slug: 'paid-fixture', name: 'Paid fixture', providerType: 'pi', piAuthProvider: 'openai', authType: 'api_key', models: ['pi/gpt-6.1-sol'], defaultModel: 'pi/gpt-6.1-sol', createdAt: 1 }] } as never);
    h.managed.llmConnection = 'paid-fixture';
    h.managed.tokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 25,
    };

    await h.manager.sendMessage(
      h.managed.id,
      'Résultat interne arrivé après épuisement du budget.',
      undefined,
      undefined,
      { hidden: true, internalOrigin: { kind: 'agent-message' } },
    );

    configSpy.mockRestore();
    expect(providerPreparations).toBe(0);
    expect(h.managed.userInputRequests?.filter(request => request.status === 'pending'))
      .toHaveLength(1);
    expect(h.managed.userInputRequests?.[0]?.questions[0]?.id).toBe('cost-limit-next-step');
  });

  it('binds the selected playbook before chat and refuses closure with only a generic technical check', async () => {
    const stream: AgentEvent[] = [];
    const h = harness(stream, () => {
      expect(h.managed.activeObjective?.procedure).toEqual({ id: 'software-change', version: 1 });
      // The model deliberately omits procedure and business requirement IDs.
      h.managed.activeObjective = registerObjectiveAcceptanceCriteria(h.managed.activeObjective!, [{
        id: 'generic-tests-pass', description: 'The fixture test command succeeds', toolName: 'Bash',
        input: { command: 'bun test fixture.test.ts' }, checks: [{ path: 'passed', equals: true }],
      }], Date.now() - 1);
      const objective = h.managed.activeObjective;
      stream.push(
        { type: 'tool_start', toolName: 'Bash', toolUseId: 'generic-check', input: { command: 'bun test fixture.test.ts' } },
        { type: 'tool_result', toolName: 'Bash', toolUseId: 'generic-check', result: '{"passed":true}', isError: false, executed: true },
        { type: 'text_complete', text: `Les tests passent. <!-- robb_objective_outcome ${JSON.stringify({
          state: 'complete_verified', blocker: null, remainingWork: [],
          criteria: [...objective.completionCriteria, 'generic-tests-pass'].map(id => ({ id, satisfied: true, evidence: ['generic-check'] })),
        })} -->` },
        { type: 'complete' },
      );
    });
    h.managed.playbookSlug = 'verified-software-change';
    await h.manager.sendMessage(h.managed.id, 'Poursuit');
    expect(h.managed.activeObjective?.procedure).toEqual({ id: 'software-change', version: 1 });
    expect(h.managed.activeObjective?.terminalState).toBe('exhausted');
    expect(h.managed.messages.some(message => message.role === 'tool' && message.toolUseId === 'generic-check' && !message.isError)).toBe(true);
    const rejection = h.managed.messages.find(message => message.role === 'error' && message.errorCode === 'objective_validation_failed');
    expect(rejection?.errorDetails).toEqual([
      'Business procedure lacks outcome coverage: requested-behavior',
      'Business procedure lacks outcome coverage: regression-checks',
      'Business procedure lacks outcome coverage: user-journey',
    ]);
  });

  it('persists an actual user correction as a version-bound inactive observation', async () => {
    const h = harness();
    await h.manager.sendMessage(h.managed.id, "Il me semble qu'il manque les pièces jointes.");
    const proposals = loadProjectMemoryJournal(h.root, h.project.slug).entries;
    const correction = proposals.find(p => p.tags.includes('user-correction'));
    expect(correction?.status).toBe('proposed');
    expect(correction?.scope?.version).toBe('fixture-build');
    expect(correction?.provenance.sourceId).toBe(h.managed.messages.find(m => m.role === 'user' && m.id !== 'objective')?.id);
    expect(loadProjectMemoryV2Context(h.root, h.project.slug, { query: 'missing attachments', version: 'fixture-build' })).toBeNull();
  });

  it('captures a correction accepted while an agent is already processing', async () => {
    const h = harness();
    h.managed.isProcessing = true;
    let acknowledgedMessageId: string | undefined;
    await h.manager.sendMessage(
      h.managed.id,
      "C'est trop peu pour les journalistes.",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      messageId => { acknowledgedMessageId = messageId; },
    );
    expect(h.managed.messages.at(-1)?.isQueued).toBe(false);
    expect(h.managed.messageQueue).toHaveLength(0);
    expect(acknowledgedMessageId).toBe(h.managed.messages.at(-1)?.id);
    const entries = loadProjectMemoryJournal(h.root, h.project.slug).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.tags).toContain('user-correction');
    expect(entries[0]?.provenance.sourceId).toBe(h.managed.messages.at(-1)?.id);
    expect(entries[0]?.status).toBe('proposed');
  });

  it('captures the exhausted terminal error through real event processing, never as a learned rule', async () => {
    const h = harness([
      { type: 'tool_start', toolName: 'Bash', toolUseId: 'failed-render', input: { command: 'fixture-render' } },
      { type: 'tool_result', toolName: 'Bash', toolUseId: 'failed-render', result: 'Fixture renderer unavailable', isError: true, executed: true },
      { type: 'text_complete', text: 'Le document est prêt.' },
      { type: 'complete' },
    ]);
    await h.manager.sendMessage(h.managed.id, 'Poursuit');
    expect(h.managed.activeObjective?.terminalState).toBe('exhausted');
    const entries = loadProjectMemoryJournal(h.root, h.project.slug).entries;
    expect(entries.some(e => e.provenance.sourceId === 'failed-render')).toBe(true);
    expect(entries.some(e => e.content.includes('host:objective_validation_failed'))).toBe(true);
    expect(entries.every(e => e.status === 'proposed' && e.scope?.version === 'fixture-build')).toBe(true);
  });

  it('captures a terminal transport failure even when no complete event was emitted', async () => {
    const h = harness();
    h.managed.isProcessing = true;
    h.managed.activeObjective!.terminalState = 'exhausted';
    await h.runtime.processEvent(h.managed, { type: 'error', message: 'Fixture stream ended after bounded retries.' });
    await h.runtime.onProcessingStopped(h.managed.id, 'error');
    const entries = loadProjectMemoryJournal(h.root, h.project.slug).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.content).toContain('host:unclassified-error');
    expect(entries[0]?.status).toBe('proposed');
    expect(entries[0]?.provenance.sourceId).toBe(h.managed.messages.findLast(message => message.role === 'error')?.id);
    await h.runtime.onProcessingStopped(h.managed.id, 'error');
    expect(loadProjectMemoryJournal(h.root, h.project.slug).entries).toHaveLength(1);
  });

  it('keeps synthetic feedback and disabled workspace memory out of the journal', async () => {
    const h = harness();
    await h.manager.sendMessage(h.managed.id, "Il manque les pièces jointes.", undefined, undefined, { hidden: true, internalOrigin: { kind: 'agent-message' } });
    const beforeDisabled = loadProjectMemoryJournal(h.root, h.project.slug).entries;
    expect(beforeDisabled.filter(entry => entry.tags.includes('user-correction'))).toHaveLength(0);
    const profile = createDefaultWorkspaceGovernance({ workspaceId: 'learning-workspace', workspaceName: 'Learning fixture', createdAt: new Date().toISOString() });
    profile.space.memory = { enabled: false, retentionDays: 7 };
    await new WorkspaceGovernanceStore(h.root).loadOrCreate(profile);
    await h.manager.sendMessage(h.managed.id, "Il manque les pièces jointes.");
    expect(loadProjectMemoryJournal(h.root, h.project.slug).entries).toEqual(beforeDisabled);
  });
});
