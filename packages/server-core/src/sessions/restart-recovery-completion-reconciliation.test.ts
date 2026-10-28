import { parseRecoveryJournalObservation } from './testing/recovery-journal-observation.ts';
import type { PendingTurnRecovery } from '../../../shared/src/sessions/types/turn-recovery.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import { withSessionOperationsForTest } from './testing/session-operation-access.ts';
import { sessionManagerForTest } from "./testing/private-runtime-access.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as config from "@craft-agent/shared/config";
import { getSessionFilePath, listSessions } from "@craft-agent/shared/sessions/storage";
import { SessionManager } from "./SessionManager";
import { registerObjectiveAcceptanceCriteria } from "./objective-acceptance-criteria";
import { cleanupRestartRecovery, harness, managers, spies, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('durably reopens an older false completion when the lazy-loaded final says sends remain', async () => {
    const h = harness()
    const managed = h.make('false-completion-on-disk')
    managed.pendingTurnRecovery = undefined
    managed.activeObjective!.terminalState = 'complete_verified'
    managed.activeObjective!.completedAt = 5
    managed.lastFinalMessageId = 'unfinished-final'
    managed.messages.push({
      id: 'unfinished-final', role: 'assistant', content: 'Two messages remain unsent.',
      timestamp: 4,
      objectiveOutcome: {
        state: 'continue',
        criteria: [
          { id: 'requested-outcome-delivered', satisfied: false, evidence: ['assistant-final'] },
          { id: 'no-safe-work-remaining', satisfied: false, evidence: ['assistant-final'] },
        ],
        remainingWork: ['Send and verify the first message.', 'Send and verify the second message.'],
        blocker: null,
      },
    })
    await h.save(managed)
    const cold = h.cold()
    const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    expect(requiredTestValue(restored.activeObjective).terminalState).toBe('complete_verified')
    await cold.runtime.ensureMessagesLoaded(restored)
    expect(restored.activeObjective).toMatchObject({
      terminalState: 'exhausted',
      lastOutcome: { state: 'continue', remainingWork: [
        'Send and verify the first message.', 'Send and verify the second message.',
      ] },
    })
    expect(requiredTestValue(restored.activeObjective).completedAt).toBeUndefined()
    const saved = listSessions(h.rootPath).find(meta => meta.id === managed.id)
    expect(saved?.activeObjective?.terminalState).toBe('exhausted')
  })

  it('reconciles a false completion before the restored chat list is published', async () => {
    const h = harness()
    const managed = h.make('false-completion-on-startup')
    managed.pendingTurnRecovery = undefined
    managed.activeObjective!.terminalState = 'complete_verified'
    managed.activeObjective!.completedAt = 5
    managed.lastFinalMessageId = 'unfinished-startup-final'
    managed.messages.push({
      id: 'unfinished-startup-final', role: 'assistant', content: 'Two messages remain unsent.',
      timestamp: 4,
      objectiveOutcome: {
        state: 'continue',
        criteria: [
          { id: 'requested-outcome-delivered', satisfied: false, evidence: ['assistant-final'] },
          { id: 'no-safe-work-remaining', satisfied: false, evidence: ['assistant-final'] },
        ],
        remainingWork: ['Send and verify the first message.', 'Send and verify the second message.'],
        blocker: null,
      },
    })
    await h.save(managed)
    spies.push(spyOn(config, 'getWorkspaces').mockReturnValue([h.workspace] as never))
    const restarted = withSessionOperationsForTest(new SessionManager()); managers.push(restarted)
    const runtime = sessionManagerForTest(restarted)
    runtime.sendEvent = (event) => h.events.push(event)
    runtime.loadSessionsFromDisk()
    const restored = sessionRuntimeStateForTest(restarted).sessions.get(managed.id)!
    expect(restored.activeObjective).toMatchObject({
      terminalState: 'exhausted',
      lastOutcome: { state: 'continue', remainingWork: [
        'Send and verify the first message.', 'Send and verify the second message.',
      ] },
    })
    await restarted.flushSession(restored.id)
    const header = parseRecoveryJournalObservation(readFileSync(getSessionFilePath(h.rootPath, restored.id), 'utf8').split('\n')[0]!)
    expect(requiredTestValue(header.activeObjective).terminalState).toBe('exhausted')
  })

  it('retires only a proven obsolete Read amendment question and resumes its reviewer', async () => {
    const h = harness()
    const makeReviewer = async (id: string, suffix: string) => {
      const managed = h.make(id)
      const readInput = { path: '/tmp/review-source.txt', offset: 23, limit: 3 }
      managed.activeObjective = registerObjectiveAcceptanceCriteria(
        managed.activeObjective!, [{
          id: 'exact-read', description: 'The selected source lines match.',
          toolName: 'functions.read', input: readInput,
          checks: [{ path: '$text', equals: 'alpha\nbeta\ngamma' }],
        }], 2,
      )
      managed.activeObjective.lastOutcome = {
        state: 'continue', blocker: null,
        criteria: [{ id: 'exact-read', satisfied: false, evidence: ['read-result'] }],
        remainingWork: ['Recheck the immutable Read criterion'],
      }
      managed.pendingTurnRecovery = {
        ...managed.pendingTurnRecovery!, attempts: 2,
        lastCause: 'objective_continue',
        continuationOrigin: 'objective_continue',
        continuationWork: ['Recheck the immutable Read criterion'],
      }
      managed.messages.push({
        id: `${id}-read-result`, toolUseId: `${id}-read-use`, role: 'tool',
        content: '', toolName: 'Read', toolStatus: 'completed',
        toolExecuted: true, timestamp: 10, toolInput: readInput,
        toolResult: 'alpha\nbeta\ngamma' + suffix,
      })
      managed.userInputRequests = [{
        id: `${id}-question`, sessionId: managed.id,
        originWorkspaceId: managed.workspace.id,
        objectiveUserMessageId: managed.activeObjective.userMessageId,
        status: 'pending', createdAt: 20,
        questions: [{ id: 'amend-static-checks',
          question: 'Autorisez-vous un amendement technique des contrôles Read ?',
          options: [{ id: 'yes', label: 'Oui' }] }],
      }]
      await h.save(managed)
      return managed
    }
    const proven = await makeReviewer(
      'cold-proven-read-amendment',
      '\n\n[350 more lines in file. Use offset=26 to continue.]',
    )
    const unproven = await makeReviewer(
      'cold-unproven-read-amendment',
      '\n\n[350 more lines in file. Use offset=27 to continue.]',
    )

    spies.push(spyOn(config, 'getWorkspaces').mockReturnValue([h.workspace] as never))
    const restarted = withSessionOperationsForTest(new SessionManager()); managers.push(restarted)
    const runtime = sessionManagerForTest(restarted)
    runtime.sendEvent = (event) => h.events.push(event)
    runtime.processNextQueuedMessage = () => {}
    runtime.loadSessionsFromDisk()
    const recovered = requiredTestValue(sessionRuntimeStateForTest(restarted).sessions.get(proven.id))
    const retained = requiredTestValue(sessionRuntimeStateForTest(restarted).sessions.get(unproven.id))

    expect(requiredTestValue(requiredTestValue(recovered.userInputRequests)[0]).status).toBe('cancelled')
    expect(recovered.pendingTurnRecovery).toBeDefined()
    expect(requiredTestValue(requiredTestValue(retained.userInputRequests)[0]).status).toBe('pending')
    await restarted.flushSession(proven.id)
    const header = parseRecoveryJournalObservation(readFileSync(getSessionFilePath(h.rootPath, proven.id), 'utf8').split('\n')[0]!)
    expect(requiredTestValue(requiredTestValue(header.userInputRequests)[0]).status).toBe('cancelled')
    await tick(); await tick()
    expect(retained.messageQueue).toEqual([])
  })

  it('retires a legacy generic exhaustion question and exposes the child terminal state at startup', async () => {
    const h = harness()
    const managed = h.make('legacy-generic-exhaustion', 'review-parent')
    managed.messages[0]!.internalOrigin = { kind: 'spawned-session', senderSessionId: 'review-parent' }
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, attempts: 6, lastCause: 'objective_continue',
      continuationOrigin: 'objective_continue', continuationWork: ['Run the exact read-only check'],
    }
    managed.userInputRequests = [{
      id: 'legacy-exhaustion-question', sessionId: managed.id,
      originWorkspaceId: h.workspace.id, objectiveUserMessageId: managed.activeObjective!.userMessageId,
      status: 'pending', createdAt: 8, questions: [{
        id: 'automatic-recovery-next-step',
        question: 'Les stratégies autonomes sûres ont été épuisées sans preuve suffisante pour terminer. Quelle suite souhaitez-vous ?',
        options: [
          { id: 'resume-with-guidance', label: 'Préciser puis reprendre',
            description: 'Ajoutez l’information ou le choix manquant afin que la mission reprenne sur le même objectif.', recommended: true },
          { id: 'stop-objective', label: 'Arrêter cette mission',
            description: 'Conserver les résultats actuels et ne plus lancer de tentative automatique.' },
        ],
      }],
    }]
    await h.save(managed)
    spies.push(spyOn(config, 'getWorkspaces').mockReturnValue([h.workspace] as never))
    const restarted = withSessionOperationsForTest(new SessionManager()); managers.push(restarted)
    const runtime = sessionManagerForTest(restarted)
    runtime.sendEvent = (event) => h.events.push(event)
    runtime.loadSessionsFromDisk()
    const restored = sessionRuntimeStateForTest(restarted).sessions.get(managed.id)!
    expect(requiredTestValue(restored.userInputRequests![0]).status).toBe('cancelled')
    expect(restored.activeObjective!.terminalState).toBe('exhausted')
    expect(restored.activeObjective!.interruptedTurnRecovery?.recovery).toMatchObject({
      attempts: 6, validationExhausted: true,
      continuationWork: ['Run the exact read-only check'],
    })
    expect(restored.pendingTurnRecovery).toBeUndefined()
    await restarted.flushSession(restored.id)
    const header = parseRecoveryJournalObservation(readFileSync(getSessionFilePath(h.rootPath, restored.id), 'utf8').split('\n')[0]!)
    expect(requiredTestValue(requiredTestValue(header.userInputRequests)[0]).status).toBe('cancelled')
    expect(requiredTestValue(header.activeObjective).terminalState).toBe('exhausted')
  })

  it('stops at the automatic retry ceiling without creating a generic user question', async () => {
    const h = harness()
    const managed = h.make('retry-ceiling-no-question')
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, attempts: 256, stagnantAttempts: 0,
      cleanContinuationCount: 1, lastProgressFingerprint: 'unchanged',
    }
    expect(await h.runtime.enqueueAutomaticTurnRecovery(
      managed, 'objective_incomplete', ['The exact read-only check was denied by policy'],
    )).toBe(false)
    expect(managed.pendingTurnRecovery?.exhaustedAt).toBeNumber()
    expect(managed.userInputRequests ?? []).toEqual([])
  })

  it('upgrades the exact legacy Retry restart record without replaying its untracked attempt', async () => {
    const h = harness(); const managed = h.make('legacy-retry-replay')
    writeFileSync(join(h.rootPath, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      id: h.workspace.id,
      name: h.workspace.name,
      slug: 'legacy-retry-replay',
      createdAt: 1,
      updatedAt: 1,
      costControl: { recovery: { maxAutomaticAttempts: 4 } },
    }))
    managed.pendingTurnRecovery = omitUndefined<PendingTurnRecovery>({
      ...managed.pendingTurnRecovery!,
      attempts: 2,
      stagnantAttempts: 0,
      leaseExpiresAt: Date.now() + 60_000,
      lastCause: 'user_retry',
      continuationWork: ['Inspect the remaining user-visible check'],
      continuationOrigin: 'objective_continue',
      // Exact pre-fix shape: the Retry cause was persisted, while its generated
      // attempt=3 prompt had no durable dispatch descriptor.
      recoveryDispatch: undefined,
    })
    await h.save(managed)
    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    let directRetryReplays = 0; let scheduled = 0
    cold.runtime.retryTurnInternal = async () => { directRetryReplays++; return { status: 'started' } }
    cold.runtime.processNextQueuedMessage = () => { scheduled++ }

    await cold.runtime.resumePendingTurnAfterRestart(restored.id)
    expect(directRetryReplays).toBe(0)
    expect(scheduled).toBe(1)
    expect(restored.pendingTurnRecovery).toMatchObject({
      attempts: 3,
      leaseExpiresAt: managed.pendingTurnRecovery!.leaseExpiresAt,
      lastCause: 'app_restart',
      recoveryDispatch: {
        schemaVersion: 1,
        attempt: 4,
        cause: 'app_restart',
        origin: 'restart',
        phase: 'allocated',
      },
    })
    const dispatch = requiredTestValue(structuredClone(requiredTestValue(restored.pendingTurnRecovery).recoveryDispatch))
    expect(dispatch.id).toBeString()
    expect(restored.messageQueue).toHaveLength(1)
    expect(requiredTestValue(restored.messageQueue[0]).message).toContain('attempt="4"')
    expect(requiredTestValue(restored.messageQueue[0]).options?.automaticRecovery).toMatchObject({
      dispatchId: dispatch.id,
      dispatchAttempt: 4,
      dispatchOrigin: 'restart',
    })
    const header = parseRecoveryJournalObservation(readFileSync(getSessionFilePath(h.rootPath, restored.id), 'utf8').split('\n')[0]!)
    expect(requiredTestValue(header.pendingTurnRecovery).recoveryDispatch).toEqual(dispatch)

    // A second startup wake sees the same transient FIFO and must not spend a
    // second attempt or mint another identity.
    await cold.runtime.resumePendingTurnAfterRestart(restored.id)
    expect(requiredTestValue(restored.pendingTurnRecovery).recoveryDispatch).toEqual(dispatch)
    expect(requiredTestValue(restored.pendingTurnRecovery).attempts).toBe(3)
    expect(restored.messageQueue).toHaveLength(1)
    expect(scheduled).toBe(1)
  })
});
