import { parseRecoveryJournalObservation } from './testing/recovery-journal-observation.ts';
import type { PendingTurnRecovery } from '../../../shared/src/sessions/types/turn-recovery.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { objectiveReviewBinding } from "./objective-contract";
import { PiEventAdapter } from "../../../shared/src/agent/backend/pi/event-adapter";
import { cleanupRestartRecovery, deferred, harness, prepareStartedRecoveryAdmission, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('adopts the exact current Pi tool_start before the automatic-recovery durability ACK', async () => {
    const h = harness()
    const { managed, runtimeAgent } = await prepareStartedRecoveryAdmission(
      h, 'automatic-admission-after-pi-tool-start', 22,
    )
    await h.runtime.processEvent(managed, {
      type: 'tool_start', toolUseId: 'pi-prestarted-read', toolName: 'Read',
      input: { file_path: '/fixture/provider-path.txt' },
      intent: 'Inspect the bounded recovery target.', displayName: 'Read target',
    }, 22)

    await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, {
      toolUseId: 'pi-prestarted-read', toolName: 'Read',
      // PreToolUse may normalize the input after tool_execution_start.
      toolInput: { file_path: '/fixture/approved-path.txt' },
    })).resolves.toBeUndefined()

    const receipts = managed.messages.filter(message => message.toolUseId === 'pi-prestarted-read')
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      role: 'tool', toolName: 'Read', toolStatus: 'executing',
      toolInput: { file_path: '/fixture/approved-path.txt' },
      toolIntent: 'Inspect the bounded recovery target.',
      toolDisplayName: 'Read target',
    })
    const stored = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(parseRecoveryJournalObservation)
    expect<unknown>(stored.filter(message => message.toolUseId === 'pi-prestarted-read')).toEqual([
      (expect.objectContaining({
        type: 'tool', toolName: 'Read', toolStatus: 'executing',
        toolInput: { file_path: '/fixture/approved-path.txt' },
      }) as unknown),
    ])
  })

  it('admits and persists a Pi cat read once with its actual Bash identity', async () => {
    const h = harness()
    const { managed, runtimeAgent } = await prepareStartedRecoveryAdmission(
      h, 'pi-prestarted-cat-read', 22,
    )
    const adapter = new PiEventAdapter()
    const toolUseId = 'pi-prestarted-cat'
    const input = { command: 'cat /fixture/measurements.csv' }
    const start = [...adapter.adaptEvent({
      type: 'tool_execution_start', toolCallId: toolUseId, toolName: 'bash', args: input,
    } as Parameters<PiEventAdapter['adaptEvent']>[0])][0]!
    await h.runtime.processEvent(managed, start, 22)
    const request = { toolUseId, toolName: 'Bash', toolInput: input }
    await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(
      managed, runtimeAgent, request,
    )).resolves.toBeUndefined()
    await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(
      managed, runtimeAgent, request,
    )).rejects.toThrow('identity already belongs')

    const result = [...adapter.adaptEvent({
      type: 'tool_execution_end', toolCallId: toolUseId, isError: false,
      result: { content: [{ type: 'text', text: 'month,value\n1,1' }], details: { executed: true } },
    } as Parameters<PiEventAdapter['adaptEvent']>[0])][0]!
    await h.runtime.processEvent(managed, result, 22)
    await h.save(managed)
    const receipts = managed.messages.filter(message => message.toolUseId === toolUseId)
    expect<unknown>(receipts).toEqual([(expect.objectContaining({
      toolName: 'Bash', toolInput: input, toolResult: 'month,value\n1,1',
      toolStatus: 'completed', toolExecuted: true, toolDisplayName: 'Read File',
    }) as unknown)])
    const stored = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(parseRecoveryJournalObservation)
    expect<unknown>(stored.filter(message => message.toolUseId === toolUseId)).toEqual([
      (expect.objectContaining({ type: 'tool', toolName: 'Bash', toolInput: input,
        toolResult: 'month,value\n1,1', toolExecuted: true }) as unknown),
    ])
  })

  it('consumes the current Pi tool_start admission exactly once', async () => {
    const h = harness()
    const { managed, runtimeAgent } = await prepareStartedRecoveryAdmission(
      h, 'pi-prestarted-one-shot-admission', 23,
    )
    const request = {
      toolUseId: 'pi-prestarted-one-shot-read', toolName: 'Read',
      toolInput: { file_path: '/fixture/approved-once.txt' },
    }
    await h.runtime.processEvent(managed, {
      type: 'tool_start', toolUseId: request.toolUseId, toolName: request.toolName,
      input: { file_path: '/fixture/provider-once.txt' },
    }, 23)

    await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(
      managed, runtimeAgent, request,
    )).resolves.toBeUndefined()
    await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(
      managed, runtimeAgent, request,
    )).rejects.toThrow('identity already belongs')

    expect(managed.messages.filter(message => message.toolUseId === request.toolUseId))
      .toHaveLength(1)
    expect(managed.autonomyEvents?.findLast(event => event.toolName === request.toolName))
      .toMatchObject({ phase: 'diagnosis', message: 'Blocked a reused tool execution identity before execution.' })
  })

  it('does not let a late duplicate Pi tool_start rewrite the approved durable input', async () => {
    const h = harness()
    const { managed, runtimeAgent } = await prepareStartedRecoveryAdmission(
      h, 'pi-prestarted-late-provider-input', 26,
    )
    const toolUseId = 'pi-prestarted-late-provider-read'
    await h.runtime.processEvent(managed, {
      type: 'tool_start', toolUseId, toolName: 'Read', input: {},
    }, 26)
    await h.runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, {
      toolUseId, toolName: 'Read', toolInput: { file_path: '/fixture/approved-late.txt' },
    })

    // Pi can publish a second, input-complete start after PreToolUse returned.
    await h.runtime.processEvent(managed, {
      type: 'tool_start', toolUseId, toolName: 'Read',
      input: { file_path: '/fixture/unapproved-provider-late.txt' },
      intent: 'Inspect the target.', displayName: 'Read target',
    }, 26)

    expect<unknown>(managed.messages.filter(message => message.toolUseId === toolUseId)).toEqual([
      (expect.objectContaining({
        toolStatus: 'executing',
        toolInput: { file_path: '/fixture/approved-late.txt' },
        toolIntent: 'Inspect the target.',
        toolDisplayName: 'Read target',
      }) as unknown),
    ])
    await h.manager.flushSession(managed.id)
    const stored = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(parseRecoveryJournalObservation)
    expect<unknown>(stored.filter(message => message.toolUseId === toolUseId)).toEqual([
      (expect.objectContaining({
        type: 'tool', toolStatus: 'executing',
        toolInput: { file_path: '/fixture/approved-late.txt' },
      }) as unknown),
    ])
  })

  it('serializes duplicate current Pi tool_start admissions and acknowledges only the first', async () => {
    const h = harness()
    const { managed, runtimeAgent } = await prepareStartedRecoveryAdmission(
      h, 'pi-prestarted-concurrent-one-shot', 24,
    )
    const request = {
      toolUseId: 'pi-prestarted-concurrent-read', toolName: 'Read',
      toolInput: { file_path: '/fixture/concurrent-approved.txt' },
    }
    await h.runtime.processEvent(managed, {
      type: 'tool_start', toolUseId: request.toolUseId, toolName: request.toolName,
      input: { file_path: '/fixture/concurrent-provider.txt' },
    }, 24)

    const entered = deferred(); const release = deferred()
    const originalFlush = h.runtime.flushSession.bind(h.manager)
    let held = false
    h.runtime.flushSession = async (sessionId: string) => {
      if (!held && managed.messages.some(message => (
        message.toolUseId === request.toolUseId
        && message.toolInput?.["file_path"] === '/fixture/concurrent-approved.txt'
      ))) {
        held = true
        entered.resolve()
        await release.promise
      }
      return originalFlush(sessionId)
    }

    const first = h.runtime.durablyRecordAutomaticRecoveryToolAdmission(
      managed, runtimeAgent, request,
    )
    await entered.promise
    let duplicateSettled = false
    const duplicate = h.runtime.durablyRecordAutomaticRecoveryToolAdmission(
      managed, runtimeAgent, request,
    ).finally(() => { duplicateSettled = true })
    await tick()
    expect(duplicateSettled).toBe(false)

    release.resolve()
    const outcomes = await Promise.allSettled([first, duplicate])
    expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'rejected'])
    expect(outcomes[1]?.status === 'rejected' ? String(outcomes[1].reason) : '')
      .toContain('identity already belongs')
    expect(managed.messages.filter(message => message.toolUseId === request.toolUseId))
      .toHaveLength(1)
  })

  it('keeps a claimed Pi tool_start fail-closed when its durability flush fails', async () => {
    const h = harness()
    const { managed, runtimeAgent } = await prepareStartedRecoveryAdmission(
      h, 'pi-prestarted-failed-flush-one-shot', 25,
    )
    const request = {
      toolUseId: 'pi-prestarted-failed-flush-read', toolName: 'Read',
      toolInput: { file_path: '/fixture/failed-flush-approved.txt' },
    }
    await h.runtime.processEvent(managed, {
      type: 'tool_start', toolUseId: request.toolUseId, toolName: request.toolName,
      input: { file_path: '/fixture/failed-flush-provider.txt' },
    }, 25)

    const originalFlush = h.runtime.flushSession.bind(h.manager)
    let failAdmissionFlush = true
    h.runtime.flushSession = async (sessionId: string) => {
      if (failAdmissionFlush) {
        failAdmissionFlush = false
        throw new Error('simulated admission fsync failure')
      }
      return originalFlush(sessionId)
    }

    await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(
      managed, runtimeAgent, request,
    )).rejects.toThrow('simulated admission fsync failure')
    await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(
      managed, runtimeAgent, request,
    )).rejects.toThrow('identity already belongs')

    const receipts = managed.messages.filter(message => message.toolUseId === request.toolUseId)
    expect<unknown>(receipts).toEqual([(expect.objectContaining({
      toolStatus: 'executing',
      toolInput: { file_path: '/fixture/failed-flush-approved.txt' },
    }) as unknown)])
    expect(receipts[0]).not.toHaveProperty('toolExecuted')
  })

  it('consumes Pi admission before fsync even when its start row is still resolving', async () => {
    const h = harness()
    const { managed, runtimeAgent } = await prepareStartedRecoveryAdmission(
      h, 'pi-start-owner-before-row-failed-flush', 27,
    )
    const request = {
      toolUseId: 'pi-start-owner-before-row-read', toolName: 'Read',
      toolInput: { file_path: '/fixture/approved-before-row.txt' },
    }
    const objective = managed.activeObjective!
    sessionRuntimeStateForTest(h.runtime).checkpointToolStarts.set(managed, {
      generation: 27,
      calls: new Map([[request.toolUseId, {
        objective,
        objectiveId: objective.userMessageId,
        acceptanceRevision: objective.acceptanceRevision ?? objective.userMessageId,
        acceptanceSha256: objectiveReviewBinding(objective).acceptanceSha256,
        authorityEpoch: sessionRuntimeStateForTest(h.runtime).objectiveAuthorityEpochs.get(managed) ?? 0,
        toolName: request.toolName,
      }]]),
    })
    expect(managed.messages.some(message => message.toolUseId === request.toolUseId)).toBe(false)

    const originalFlush = h.runtime.flushSession.bind(h.manager)
    let failAdmissionFlush = true
    h.runtime.flushSession = async (sessionId: string) => {
      if (failAdmissionFlush) {
        failAdmissionFlush = false
        throw new Error('simulated pre-row admission fsync failure')
      }
      return originalFlush(sessionId)
    }

    await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(
      managed, runtimeAgent, request,
    )).rejects.toThrow('simulated pre-row admission fsync failure')
    await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(
      managed, runtimeAgent, request,
    )).rejects.toThrow('identity already belongs')
    expect<unknown>(managed.messages.filter(message => message.toolUseId === request.toolUseId)).toEqual([
      (expect.objectContaining({
        toolStatus: 'executing',
        toolInput: { file_path: '/fixture/approved-before-row.txt' },
      }) as unknown),
    ])
  })

  it('serializes concurrent recovery mutation admissions so exactly one external effect can start', async () => {
    process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"] = '1'
    const h = harness()
    const { managed, runtimeAgent } = await prepareStartedRecoveryAdmission(h, 'concurrent-mutation-admission', 17)
    const entered = deferred(); const release = deferred()
    const originalFlush = h.runtime.flushSession.bind(h.manager)
    let held = false
    h.runtime.flushSession = async (sessionId: string) => {
      if (!held && managed.messages.some(message => message.toolUseId === 'concurrent-edit-a')) {
        held = true
        entered.resolve()
        await release.promise
      }
      return originalFlush(sessionId)
    }
    const first = h.runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, {
      toolUseId: 'concurrent-edit-a', toolName: 'Edit',
      toolInput: { file_path: '/fixture/concurrent.json', old_string: 'a', new_string: 'b' },
    })
    await entered.promise
    let secondSettled = false
    const second = h.runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, {
      toolUseId: 'concurrent-write-b', toolName: 'Write',
      toolInput: { file_path: '/fixture/other.json', content: 'other' },
    }).finally(() => { secondSettled = true })
    await tick()
    expect(secondSettled).toBe(false)
    release.resolve()
    const results = await Promise.allSettled([first, second])
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(managed.messages.filter(message => (
      message.toolUseId === 'concurrent-edit-a' || message.toolUseId === 'concurrent-write-b'
    ))).toHaveLength(1)
    const stored = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
    expect([stored.includes('concurrent-edit-a'), stored.includes('concurrent-write-b')]
      .filter(Boolean)).toHaveLength(1)
  })

  it('releases the admission transaction after failure and admits concurrent recovery reads in order', async () => {
    const h = harness()
    const firstSetup = await prepareStartedRecoveryAdmission(h, 'admission-failure-release', 18)
    const failed = h.runtime.durablyRecordAutomaticRecoveryToolAdmission(
      firstSetup.managed,
      firstSetup.runtimeAgent,
      { toolName: 'Read', toolInput: { file_path: '/fixture/missing-id.txt' } },
    )
    const afterFailure = h.runtime.durablyRecordAutomaticRecoveryToolAdmission(
      firstSetup.managed,
      firstSetup.runtimeAgent,
      { toolUseId: 'read-after-failed-admission', toolName: 'Read', toolInput: { file_path: '/fixture/after.txt' } },
    )
    const failureResults = await Promise.allSettled([failed, afterFailure])
    expect(failureResults.map(result => result.status)).toEqual(['rejected', 'fulfilled'])

    const secondSetup = await prepareStartedRecoveryAdmission(h, 'concurrent-read-admission', 19)
    await expect(Promise.all([
      h.runtime.durablyRecordAutomaticRecoveryToolAdmission(secondSetup.managed, secondSetup.runtimeAgent, {
        toolUseId: 'concurrent-read-a', toolName: 'Read', toolInput: { file_path: '/fixture/a.txt' },
      }),
      h.runtime.durablyRecordAutomaticRecoveryToolAdmission(secondSetup.managed, secondSetup.runtimeAgent, {
        toolUseId: 'concurrent-read-b', toolName: 'Read', toolInput: { file_path: '/fixture/b.txt' },
      }),
    ])).resolves.toEqual([undefined, undefined])
    expect(secondSetup.managed.messages.filter(message => (
      message.toolUseId === 'concurrent-read-a' || message.toolUseId === 'concurrent-read-b'
    ))).toHaveLength(2)
  })

  it('keeps a started recovery dispatch after a permission wait snapshot is persisted', async () => {
    const h = harness()
    const { managed, runtimeAgent } = await prepareStartedRecoveryAdmission(h, 'permission-snapshot-admission', 21)
    const startedDispatch = managed.pendingTurnRecovery!.recoveryDispatch
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      waitingForPermission: { requestId: 'approval-1', requestedAt: Date.now(), toolName: 'Read' },
    }
    expect(managed.pendingTurnRecovery.recoveryDispatch).toBe(startedDispatch)
    await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, {
      toolUseId: 'read-after-approval', toolName: 'Read', toolInput: { file_path: '/fixture/after.txt' },
    })).resolves.toBeUndefined()
    managed.pendingTurnRecovery = omitUndefined<PendingTurnRecovery>({ ...managed.pendingTurnRecovery!, recoveryDispatch: undefined })
    await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, {
      toolUseId: 'read-after-revocation', toolName: 'Read', toolInput: { file_path: '/fixture/later.txt' },
    })).rejects.toThrow('no longer owns its started dispatch')
  })

  it('reuses bounded Orion reads and retries only a test that never launched its missing runner', async () => {
    process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"] = '1'
    const h = harness()
    const { managed, runtimeAgent } = await prepareStartedRecoveryAdmission(h, 'orion-read-and-test-retry', 22)
    const cwd = '/opt/ia-webdev/agent-dev/worktrees/orion/scotland-ai-executive-day-20260930'
    const readInput = { server: 'dev', cwd, command: "sed -n '1,180p' AGENTS.md" }
    managed.messages.push({
      id: 'earlier-read', role: 'tool', content: '', timestamp: Date.now(),
      toolName: 'mcp__rbw-servers__ssh_execute', toolUseId: 'earlier-read-call',
      toolInput: readInput, toolStatus: 'completed', toolExecuted: true,
      toolResult: JSON.stringify({ server: 'dev', command: `cd ${cwd} && ${readInput.command}`, stdout: 'rules', stderr: '', code: 0, success: true }),
    })
    await h.save(managed)
    await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, {
      toolUseId: 'repeat-read-call', toolName: 'mcp__rbw-servers__ssh_execute', toolInput: readInput,
    })).resolves.toBeUndefined()

    const testInput = { server: 'dev', cwd, command: 'bun run test:scotland-campaign' }
    managed.messages.push({
      id: 'missing-vitest', role: 'tool', content: '', timestamp: Date.now(),
      toolName: 'mcp__rbw-servers__ssh_execute', toolUseId: 'missing-vitest-call',
      toolInput: testInput, toolStatus: 'completed', toolExecuted: true,
      toolResult: JSON.stringify({
        server: 'dev', command: `cd ${cwd} && ${testInput.command}`,
        stdout: '', stderr: '$ vitest run tests/scotland-ai-executive-day.test.ts\n/usr/bin/bash: line 1: vitest: command not found\nerror: script "test:scotland-campaign" exited with code 127\n',
        code: 127, success: false,
      }),
    })
    await h.save(managed)
    await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, {
      toolUseId: 'test-after-install-call', toolName: 'mcp__rbw-servers__ssh_execute', toolInput: testInput,
    })).resolves.toBeUndefined()

    const executedTest = managed.messages.find(message => message.toolUseId === 'test-after-install-call')!
    executedTest.toolStatus = 'completed'
    executedTest.toolExecuted = true
    executedTest.toolResult = JSON.stringify({ server: 'dev', command: `cd ${cwd} && ${testInput.command}`, stdout: 'tests passed', stderr: '', code: 0, success: true })
    await h.save(managed)
    await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, {
      toolUseId: 'repeat-successful-test-call', toolName: 'mcp__rbw-servers__ssh_execute', toolInput: testInput,
    })).rejects.toThrow('equivalent durable tool receipt already completed')
  })

  it('revalidates authority after waiting for the admission transaction', async () => {
    const h = harness()
    const { managed, runtimeAgent } = await prepareStartedRecoveryAdmission(h, 'queued-admission-stop', 20)
    const entered = deferred(); const release = deferred()
    const originalFlush = h.runtime.flushSession.bind(h.manager)
    let held = false
    h.runtime.flushSession = async (sessionId: string) => {
      if (!held && managed.messages.some(message => message.toolUseId === 'stop-race-read-a')) {
        held = true
        entered.resolve()
        await release.promise
      }
      return originalFlush(sessionId)
    }
    const first = h.runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, {
      toolUseId: 'stop-race-read-a', toolName: 'Read', toolInput: { file_path: '/fixture/a.txt' },
    }).then(() => ({ status: 'fulfilled' as const }), (error: Error) => ({ status: 'rejected' as const, error }))
    await entered.promise
    const second = h.runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, {
      toolUseId: 'stop-race-read-b', toolName: 'Read', toolInput: { file_path: '/fixture/b.txt' },
    }).then(() => ({ status: 'fulfilled' as const }), (error: Error) => ({ status: 'rejected' as const, error }))
    managed.stopRequested = true
    release.resolve()
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.status).toBe('rejected')
    expect(firstResult.status === 'rejected' ? firstResult.error.message : '').toContain('superseded during durability flush')
    expect(secondResult.status).toBe('rejected')
    expect(secondResult.status === 'rejected' ? secondResult.error.message : '').toContain('no longer owns')
    expect(managed.messages.some(message => message.toolUseId === 'stop-race-read-b')).toBe(false)
  })
});
