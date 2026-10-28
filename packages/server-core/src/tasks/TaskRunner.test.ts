import { omitUndefined } from '@craft-agent/shared/utils/json';
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ExecutionProofIssuer } from "@craft-agent/shared/governance";
import { saveTaskSpec, readRunLog, readNodeOutput } from "@craft-agent/shared/tasks";
import { TaskRunner, type TaskExecutionGuardContext } from "./TaskRunner";
import type { SubagentAutonomyContext } from "../subagents/autonomy-inheritance.ts";
import { MockHost, UniqueSessionHost, inactiveKillSwitch, specOf, tick, tu, waitUntil } from "./testing/TaskRunner-fixture.ts";

describe('TaskRunner (Conductor)', () => {
  let root: string;

  let host: MockHost;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conductor-test-'));
    host = new MockHost();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeRunner(
    executionProofIssuer?: ExecutionProofIssuer,
    autonomyContext: SubagentAutonomyContext = {
      workspacePermissionMode: 'allow-all',
      externalActionPolicy: 'confirm',
    },
    nowMs?: () => number,
  ) {
    return new TaskRunner({
      host,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      now: () => '2026-06-07T00:00:00.000Z',
      ...(nowMs !== undefined ? { nowMs: nowMs } : {}),
      resolveSubagentAutonomyContext: () => autonomyContext,
      ...(executionProofIssuer ? {
        verifyExecutionProof: (proof, binding) => executionProofIssuer.verifyForTask(proof, binding),
      } : {}),
    });
  }

  it('runs a dependency chain, feeding each output into the next', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'demo',
        title: 'Demo',
        goal: 'audit then design then implement',
        nodes: [
          { id: 'audit', prompt: 'Audit the code' },
          { id: 'design', depends_on: ['audit'], prompt: 'Design using ${nodes.audit.output}' },
          { id: 'impl', depends_on: ['design'], prompt: 'Implement ${nodes.design.output}' },
        ],
      }),
    );
    const runner = makeRunner();
    runner.run('demo', { runId: 'r1', orchestratorSessionId: 'orch' });
    await tick();

    expect(host.dispatchedNames()).toEqual(['audit']);
    expect(host.promptFor('audit')?.endsWith('Audit the code')).toBe(true);
    expect(host.sent.find(entry => entry.message.endsWith('Audit the code'))?.options)
      .toMatchObject({ internalOrigin: {
        kind: 'spawned-session', senderSessionId: 'orch', authenticatedTaskText: 'Audit the code',
      } });

    host.complete('audit', { finalText: 'AUDIT', tokenUsage: tu(10, 5) });
    await tick();
    expect(host.dispatchedNames()).toEqual(['audit', 'design']);
    expect(host.promptFor('design')?.endsWith('Design using AUDIT')).toBe(true);

    host.complete('design', { finalText: 'DESIGN', tokenUsage: tu(20, 10) });
    await tick();
    expect(host.promptFor('impl')?.endsWith('Implement DESIGN')).toBe(true);

    host.complete('impl', { finalText: 'IMPL', tokenUsage: tu(5, 5) });
    await tick();

    // All nodes done → the run is verifying until the independent reviewer returns a verdict.
    expect(runner.getRunState('demo', 'r1')!.status).toBe('verifying');
    expect(host.sent.some((s) => s.sessionId === host.reviewerSessionId()
      && s.message.includes('<host_parent_review_contract>'))).toBe(true);

    host.completeReview('pass');
    await tick();

    const snap = runner.getRunState('demo', 'r1')!;
    expect(snap.status).toBe('completed');
    expect(snap.nodes.every((n) => n.state === 'done')).toBe(true);
    expect(snap.tokensUsed).toBe(55);

    // Run-log + node output persisted.
    const log = readRunLog(root, 'demo', 'r1');
    expect(log[0]).toMatchObject({ kind: 'run-started' });
    expect(log.some((e) => e.kind === 'run-completed')).toBe(true);
    expect(readNodeOutput(root, 'demo', 'r1', 'audit')).toEqual({ text: 'AUDIT' });
  });

  it('routes the resolved prompt and does not turn an automatic route into durable pins', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'resolved-routing',
        title: 'Resolved routing',
        goal: 'Route the effective work',
        params: [{ name: 'plan' }],
        nodes: [{ id: 'apply', prompt: 'Apply ${params.plan}' }],
      }),
    );
    let classifiedPrompt = '';
    const runner = new TaskRunner({
      host,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      resolveSubagentAutonomyContext: () => ({
        workspacePermissionMode: 'allow-all',
        externalActionPolicy: 'confirm',
      }),
      resolveNodeRoute: (context) => {
        classifiedPrompt = context.node.prompt ?? '';
        return {
          profile: {
            specialty: 'security',
            difficulty: 'complex',
            modelTier: 'best',
            thinkingLevel: 'xhigh',
            highRisk: true,
          },
          model: 'pi/gpt-6-astra',
          llmConnection: 'primary',
          thinkingLevel: 'xhigh',
          strategy: 'primary',
        };
      },
    });

    runner.run('resolved-routing', {
      runId: 'r1',
      orchestratorSessionId: 'orch',
      params: { plan: 'Delete the production database.' },
    });
    await tick();

    expect(classifiedPrompt).toBe('Apply Delete the production database.');
    expect(host.sent[0]?.options?.internalOrigin?.authenticatedTaskText)
      .toBe('Apply Delete the production database.');
    expect(host.created[0]?.options).toMatchObject({
      model: 'pi/gpt-6-astra',
      llmConnection: 'primary',
      thinkingLevel: 'xhigh',
      modelRoutePinned: false,
      connectionRoutePinned: false,
      thinkingLevelPinned: false,
    });
  });

  it('resolves retry defaults for a durable pinned connection and rejects a model from another provider', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'pinned-connection-retry',
        title: 'Pinned connection retry',
        goal: 'Keep provider-scoped defaults compatible',
        nodes: [{ id: 'a', prompt: 'a' }],
      }),
    );
    const selectedConnections: Array<string | undefined> = [];
    const profile = {
      specialty: 'general' as const,
      difficulty: 'simple' as const,
      modelTier: 'fast' as const,
      thinkingLevel: 'low' as const,
    };
    const runner = new TaskRunner({
      host,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      defaultRetry: { limit: 1, when: 'error' },
      getModelDefaults: (_parentSessionId, selectedConnectionSlug) => {
        selectedConnections.push(selectedConnectionSlug);
        // Deliberately return a stale provider-B snapshot on the retry. The
        // runner must request A and must not combine B's model with A.
        return { llmConnection: 'provider-b', model: 'model-b', thinkingLevel: 'low' };
      },
      resolveNodeRoute: (context) => omitUndefined(context.attempt === 1
        ? {
            profile,
            llmConnection: 'provider-a',
            model: 'model-a',
            thinkingLevel: 'low' as const,
            connectionRoutePinned: true,
            strategy: 'pinned' as const,
          }
        : {
            profile,
            llmConnection: context.defaults?.llmConnection,
            model: context.defaults?.model,
            thinkingLevel: context.defaults?.thinkingLevel ?? 'low',
            connectionRoutePinned: context.defaults?.connectionRoutePinned,
            strategy: 'pinned' as const,
          }),
    });

    runner.run('pinned-connection-retry', { runId: 'r1', verifyOnComplete: false });
    await tick();
    host.complete('a', { reason: 'error' });
    await waitUntil(() => host.created.length === 2);

    expect(selectedConnections).toEqual([undefined, 'provider-a']);
    expect(host.created[1]?.options.llmConnection).toBe('provider-a');
    expect(host.created[1]?.options.model).toBeUndefined();
  });

  it('passes llmConnection (node value, else the task default) to createSession', async () => {
    // Regression: pi/* models complete instantly with empty output unless the child session is
    // created with the connection slug that serves the model.
    saveTaskSpec(
      root,
      specOf({
        id: 'conn',
        title: 'Conn',
        goal: 'g',
        defaults: { llmConnection: 'default-conn' },
        nodes: [
          { id: 'a', prompt: 'a', model: 'pi/gpt-5.6-sol', llmConnection: 'pi-conn' },
          { id: 'b', prompt: 'b', model: 'claude-opus-4-8' }, // inherits the task default
        ],
      }),
    )
    const runner = makeRunner()
    runner.run('conn', { runId: 'r1' })
    await tick()

    const optsA = host.created.find((c) => c.options.name === 'a')?.options
    const optsB = host.created.find((c) => c.options.name === 'b')?.options
    expect(optsA?.llmConnection).toBe('pi-conn')
    expect(optsB?.llmConnection).toBe('default-conn')
  })

  it('resolves permissionMode: node override → task default → child (never the workspace default)', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'perm',
        title: 'Perm',
        goal: 'g',
        defaults: { permissionMode: 'ask' },
        nodes: [
          { id: 'a', prompt: 'a', permissionMode: 'safe' }, // node override wins
          { id: 'b', prompt: 'b' }, // inherits the task default
        ],
      }),
    )
    const runner = makeRunner()
    runner.run('perm', { runId: 'r1' })
    await tick()

    expect(host.created.find((c) => c.options.name === 'a')?.options.permissionMode).toBe('safe')
    expect(host.created.find((c) => c.options.name === 'b')?.options.permissionMode).toBe('ask')
  })

  it('defaults an omitted permission mode to safe for fail-closed autonomy', async () => {
    // A hand-authored spec must opt in explicitly before an unattended child can mutate state.
    saveTaskSpec(
      root,
      specOf({ id: 'perm2', title: 'Perm2', goal: 'g', nodes: [{ id: 'c', prompt: 'c' }] }),
    )
    const runner = makeRunner()
    runner.run('perm2', { runId: 'r1' })
    await tick()

    expect(host.created.find((c) => c.options.name === 'c')?.options.permissionMode).toBe('safe')
  })

  it('inherits full tools and network only from an opted-in Execute parent', async () => {
    saveTaskSpec(
      root,
      specOf({ id: 'autonomous', title: 'Autonomous', goal: 'g', nodes: [{ id: 'work', prompt: 'work' }] }),
    )
    const runner = makeRunner(undefined, {
      workspacePermissionMode: 'allow-all',
      parentPermissionMode: 'allow-all',
      externalActionPolicy: 'allow-in-execute',
    })
    runner.run('autonomous', { runId: 'r1', orchestratorSessionId: 'orch' })
    await tick()

    const created = host.created.find((entry) => entry.options.name === 'work')?.options
    expect(created?.permissionMode).toBe('allow-all')
    expect(created?.executionIsolation).toBeUndefined()
    expect(host.promptFor('work')).toContain('[Inherited execution policy]')
    expect(host.promptFor('work')).toContain('browser, shell, and network')
  })

  it('keeps read-only judges and verifiers Safe and isolated under an opted-in Execute parent', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'isolated-reviewers', title: 'Isolated reviewers', goal: 'Review safely',
        execution: { root_path: root, allowed_write_paths: ['artifacts'] },
        nodes: [
          {
            id: 'judge', kind: 'judge', permissionMode: 'allow-all',
            prompt: 'Déploie la migration en production puis juge le résultat.',
          },
          {
            id: 'verify', kind: 'verify', permissionMode: 'allow-all',
            prompt: 'Delete the production data, then verify the result.',
          },
        ],
      }),
    )
    const guardContexts: TaskExecutionGuardContext[] = []
    const runner = new TaskRunner({
      host,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      resolveSubagentAutonomyContext: () => ({
        workspacePermissionMode: 'allow-all',
        parentPermissionMode: 'allow-all',
        externalActionPolicy: 'allow-in-execute',
      }),
      executionGuard: (context) => {
        guardContexts.push(context)
        return { allowed: true }
      },
    })
    runner.run('isolated-reviewers', { runId: 'r1', orchestratorSessionId: 'orch' })
    await tick()

    expect(host.created).toHaveLength(2)
    for (const child of host.created) {
      expect(child.options.permissionMode).toBe('safe')
      expect(child.options.missionRole).toBe('reviewer')
      expect(child.options.executionIsolation).toMatchObject({
        effect: 'read',
        policy: { allowedWritePaths: [] },
      })
      const prompt = host.sent.find((sent) => sent.sessionId === child.id)?.message ?? ''
      expect(prompt).toContain('[Execution policy]')
      expect(prompt).not.toContain('[Inherited execution policy]')
    }
    expect(guardContexts).toHaveLength(2)
    expect(guardContexts.every((context) => (
      context.reviewOnly
      && context.permissionMode === 'safe'
      && context.fullAutonomyInherited === false
      && context.policy.allowedWritePaths.length === 0
    ))).toBe(true)
  })

  it('keeps every retry of a read-only judge Safe and isolated', async () => {
    const uniqueHost = new UniqueSessionHost()
    saveTaskSpec(
      root,
      specOf({
        id: 'retry-reviewer', title: 'Retry reviewer', goal: 'Review safely',
        execution: { root_path: root, allowed_write_paths: ['artifacts'] },
        nodes: [{
          id: 'judge', kind: 'judge', permissionMode: 'allow-all', retry: { limit: 1 },
          prompt: 'Déploie la migration en production puis juge le résultat.',
        }],
      }),
    )
    const guardContexts: TaskExecutionGuardContext[] = []
    const runner = new TaskRunner({
      host: uniqueHost,
      workspaceId: 'ws',
      workspaceRoot: root,
      getKillSwitch: inactiveKillSwitch,
      resolveSubagentAutonomyContext: () => ({
        workspacePermissionMode: 'allow-all',
        parentPermissionMode: 'allow-all',
        externalActionPolicy: 'allow-in-execute',
      }),
      executionGuard: (context) => {
        guardContexts.push(context)
        return { allowed: true }
      },
    })

    runner.run('retry-reviewer', { runId: 'r1', orchestratorSessionId: 'orch', verifyOnComplete: false })
    await tick()
    uniqueHost.completeSession(uniqueHost.created[0]!.id, { reason: 'error' })
    await waitUntil(() => uniqueHost.created.length === 2)

    expect(uniqueHost.created).toHaveLength(2)
    expect(uniqueHost.created.every(({ options }) => (
      options.permissionMode === 'safe'
      && options.missionRole === 'reviewer'
      && options.executionIsolation?.effect === 'read'
      && options.executionIsolation.policy.allowedWritePaths.length === 0
    ))).toBe(true)
    expect(guardContexts).toHaveLength(2)
    expect(guardContexts.every((context) => (
      context.reviewOnly
      && context.permissionMode === 'safe'
      && context.fullAutonomyInherited === false
      && context.policy.allowedWritePaths.length === 0
    ))).toBe(true)
  })

  it('keeps explicit Ask and a non-Execute parent inside the restrictive envelope', async () => {
    saveTaskSpec(
      root,
      specOf({
        id: 'strict-children', title: 'Strict children', goal: 'g',
        nodes: [
          { id: 'explicit-ask', prompt: 'ask', permissionMode: 'ask' },
          { id: 'requested-execute', prompt: 'execute', permissionMode: 'allow-all' },
        ],
      }),
    )
    const runner = makeRunner(undefined, {
      workspacePermissionMode: 'allow-all',
      parentPermissionMode: 'ask',
      externalActionPolicy: 'allow-in-execute',
    })
    runner.run('strict-children', { runId: 'r1', orchestratorSessionId: 'orch' })
    await tick()

    for (const child of host.created) {
      expect(child.options.permissionMode).toBe('ask')
      expect(child.options.executionIsolation).toBeDefined()
    }
  })
});
