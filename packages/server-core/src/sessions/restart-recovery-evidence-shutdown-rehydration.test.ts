import { sessionManagerForTest } from "./testing/private-runtime-access.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { rehydrateObjectiveEvidence as policyRehydrateObjectiveEvidence } from "./SessionManager/policy.ts";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import * as config from "@craft-agent/shared/config";
import { getObjectiveEvidenceCompletionGap } from "@craft-agent/shared/agent";
import { getSessionFilePath, listSessions } from "@craft-agent/shared/sessions/storage";
import { SessionManager } from "./SessionManager";
import { delegatedReviewFixture } from "./__fixtures__/delegated-review";
import { objectiveReviewBinding } from "./objective-contract";
import { cleanupRestartRecovery, harness, managers, spies, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('reconciles a persisted negative review after restart without a provider call or a new message', async () => {
    const h = harness(); const managed = h.make('review-child', 'review-parent')
    const f = delegatedReviewFixture('review-child-user')
    managed.activeObjective = f.objective
    managed.messages[0]!.content = f.scope
    managed.messages.push(f.observation, { id: 'review-final', role: 'assistant', content: f.finalText, timestamp: 30 })
    await h.save(managed)
    const cold = h.cold(); let resumed = 0
    cold.runtime.enqueueAutomaticTurnRecovery = async () => { resumed++; return false }
    cold.runtime.getOrCreateAgent = async () => { throw new Error('No provider may run for a persisted final review') }
    await cold.runtime.resumePendingTurnAfterRestart(managed.id)
    const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    expect(resumed).toBe(0)
    expect(restored.activeObjective).toMatchObject({ terminalState: 'complete_verified', budgetBaselineUsd: 12, tokenBaseline: 300 })
    expect(restored.messages.map((message: { id: string }) => message.id)).toEqual(['review-child-user', 'review-observation', 'review-final'])
    expect(requiredTestValue(restored.messages.at(-1)).content).toBe(f.finalText)
    expect(restored.pendingTurnRecovery).toBeUndefined()
    expect(h.events.some(event => event.type === 'objective_changed' && event.sessionId === managed.id && event.activeObjective?.terminalState === 'complete_verified')).toBe(true)
  })

  it('invalidates a persisted PASS when a later executed mutation with no output is rehydrated after restart', async () => {
    const h = harness(); const managed = h.make('stale-review-after-restart')
    // Keep the source relevant to the accepted objective: the evidence gate
    // now binds provider documentation to the provider named by the user.
    const objectiveText = 'Corrige la politique de securite secret-scanning GitHub de la cible.'
    managed.messages[0]!.content = objectiveText
    managed.activeObjective = {
      ...managed.activeObjective!,
      originalText: objectiveText,
      risk: 'high-stakes',
      evidenceDomain: 'security',
      evidenceRequirement: 'authoritative-sources-before-mutation',
      requiresExecutionEvidence: true,
      completionCriteria: ['requested-outcome-delivered', 'independent-review-passed'],
    }
    const binding = objectiveReviewBinding(managed.activeObjective)
    const reviewReceipt = JSON.stringify({
      ...binding,
      verdict: 'PASS',
      criteria: [{ id: 'requested-outcome-delivered', passed: true }],
      findings: [],
    })
    managed.messages.push(
      {
        id: 'official-source', role: 'tool', content: '', timestamp: 2,
        toolName: 'WebFetch', toolUseId: 'source-call', toolStatus: 'completed', toolExecuted: true,
        toolInput: { url: 'https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning' },
        toolResult: 'Official GitHub documentation describing the current secret-scanning security policy for this change.',
      },
      {
        id: 'passing-review', role: 'tool', content: '', timestamp: 3,
        toolName: 'mcp__session__wait_sessions', toolUseId: 'review-call', toolStatus: 'completed', toolExecuted: true,
        toolInput: { sessionIds: ['independent-reviewer'] },
        toolResult: JSON.stringify({
          outcome: 'completed',
          sessions: [{ sessionId: 'independent-reviewer', state: 'idle', reason: 'complete', changed: true, finalText: reviewReceipt }],
        }),
      },
      {
        id: 'later-mutation', role: 'tool', content: '', timestamp: 4,
        toolName: 'Bash', toolUseId: 'bash-call', toolStatus: 'completed', toolExecuted: true,
        toolInput: { command: "printf '%s' 'updated permissions' > /tmp/security-policy" },
        toolResult: '',
      },
    )
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    await cold.runtime.ensureMessagesLoaded(restored)
    policyRehydrateObjectiveEvidence(restored)

    expect(getObjectiveEvidenceCompletionGap(restored.id)).toBe(
      'independent review must be repeated after subsequent mutation (Bash)',
    )
  })

  it('checkpoints root and child work through shutdown, retains late tool receipts, and never resumes during teardown', async () => {
    const h = harness()
    const sessions = [h.make('root'), h.make('child', 'root')]
    let redirects = 0, disposals = 0
    const original = sessions.map(session => structuredClone(session.pendingTurnRecovery))
    for (const managed of sessions) {
      managed.isProcessing = true
      managed.messages.push({ id: `${managed.id}-tool`, role: 'tool', toolName: 'mcp__work_api__read', toolUseId: `${managed.id}-call`,
        content: 'Running', toolStatus: 'executing', timestamp: 2 })
      managed.agent = { redirect: () => { redirects++; return true }, disposeForRestart: async () => {
        disposals++
        await h.runtime.processEvent(managed, { type: 'tool_result', toolName: 'mcp__work_api__read', toolUseId: `${managed.id}-call`, result: managed.id === 'root' ? 'Already verified' : 'Error: service unavailable', isError: managed.id !== 'root' })
        await h.runtime.processEvent(managed, { type: 'complete' })
        await h.runtime.processEvent(managed, { type: 'error', message: 'Connection closed' })
        await h.runtime.onProcessingStopped(managed.id, 'complete')
      } } as never
      await h.save(managed)
    }
    await Promise.all([h.manager.cleanup(), h.manager.cleanup()])
    expect(disposals).toBe(2)
    expect(redirects).toBe(0)
    expect(h.events.filter(event => event.type === 'complete')).toHaveLength(0)
    for (const [index, managed] of sessions.entries()) {
      const disk = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(disk[0].pendingTurnRecovery).toEqual(original[index])
      expect(disk.find(message => message.toolUseId === `${managed.id}-call`).toolResult).toBe(managed.id === 'root' ? 'Already verified' : 'Error: service unavailable')
      expect(managed.messageQueue).toHaveLength(0)
      expect(managed.activeObjective?.terminalState).toBe('active')
    }
  })

  it('starts a cold human FIFO without opening a chat, preserving IDs exactly once under concurrent hydration', async () => {
    const h = harness(); const managed = h.make('inbox')
    managed.pendingTurnRecovery = undefined
    managed.messages.push(...['a', 'b'].map((id, i) => ({ id, role: 'user' as const, content: `Instruction ${id}`, timestamp: i + 2, isQueued: true })))
    await h.save(managed)
    expect(listSessions(h.rootPath)[0]?.pendingQueuedMessageIds).toEqual(['a', 'b'])
    spies.push(spyOn(config, 'getWorkspaces').mockReturnValue([h.workspace] as never))
    const restarted = new SessionManager(); managers.push(restarted)
    const runtime = sessionManagerForTest(restarted)
    const delivered: string[] = []
    runtime.sendMessage = async (id: string, _text: string, _attachments: unknown, _stored: unknown, _options: unknown, messageId: string) => {
      delivered.push(messageId)
      const session = requiredTestValue(sessionRuntimeStateForTest(restarted).sessions.get(id))
      requiredTestValue(session.messages.find((message) => message.id === messageId)).isQueued = false
      sessionRuntimeStateForTest(restarted).queuedMessageDispatches.delete(id)
      runtime.processNextQueuedMessage(id)
    }
    runtime.loadSessionsFromDisk()
    const restored = requiredTestValue(sessionRuntimeStateForTest(restarted).sessions.get('inbox'))
    await Promise.all([runtime.ensureMessagesLoaded(restored), runtime.ensureMessagesLoaded(restored)])
    for (let i = 0; i < 5; i++) await tick()
    expect(delivered).toEqual(['a', 'b'])
    expect(restored.messages.filter((message) => ['a', 'b'].includes(message.id))).toHaveLength(2)
  })
});
