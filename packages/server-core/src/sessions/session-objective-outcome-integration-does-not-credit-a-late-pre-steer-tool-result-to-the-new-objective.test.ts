import { sessionManagerForTest } from "./testing/private-runtime-access.ts";
import { completeSessionAgentFixture } from './testing/scripted-session-agent.ts';
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { messageToStored, storedToMessage, type AgentEvent, type Message, type ObjectiveAcceptanceCriterion, type ObjectiveOutcomeDeclaration } from "@craft-agent/core/types";
import { scopeReviewFixture } from "./__fixtures__/scope-review.ts";
import { registerObjectiveAcceptanceCriteria } from "./objective-acceptance-criteria.ts";
import { readSessionJsonl, writeSessionJsonl } from "@craft-agent/shared/sessions/jsonl";
import { pickSessionFields } from "@craft-agent/shared/sessions/utils";
import { clearObjectiveEvidenceGate, getObjectiveEvidenceCompletionGap } from "@craft-agent/shared/agent";
import { createPendingTurnRecovery } from "./turn-recovery.ts";
import { buildAutonomyStructuredFallbackPrompt } from "./autonomy-browser-fallback.ts";
import { transitionObjectiveContract } from "./objective-contract.ts";
import { incompletePlanSteps } from "./turn-completion.ts";
import { type Managed, activeObjective, enableAutomaticToolFallback, installAgent, makeHarness, outcomeComment, processEvent, roots, sessionIds } from "./testing/session-objective-outcome-integration-fixture.ts";

beforeEach(() => {
  roots.length = 0
  sessionIds.length = 0
  process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"] = '1'
})
afterEach(() => {
  delete process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"]
  for (const sessionId of sessionIds) clearObjectiveEvidenceGate(sessionId)
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('SessionManager objective outcome integration', () => {
  it('does not credit a late pre-steer tool result to the new objective or its recovery checkpoint', async () => {
    const harness = makeHarness('late-result-objective-scope')
    installAgent(harness, [])
    harness.managed.messages.push({
      id: 'user-old-root',
      role: 'user',
      content: 'Analyse le module précédent.',
      timestamp: 1,
    })
    harness.managed.activeObjective = activeObjective('user-old-root')
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('user-old-root', 1)
    harness.managed.isProcessing = true

    await processEvent(harness, {
      type: 'tool_start',
      toolName: 'WebFetch',
      toolUseId: 'old-fetch',
      input: { url: 'https://legifrance.gouv.fr/old-objective' },
    })
    await harness.manager.sendMessage(
      harness.managed.id,
      'Nouvel objectif : corrige ce contrat juridique puis vérifie-le.',
    )
    const newObjectiveUserId = harness.managed.messages.at(-1)!.id
    expect(harness.managed.activeObjective?.userMessageId).toBe(newObjectiveUserId)

    await processEvent(harness, {
      type: 'tool_result',
      toolName: 'WebFetch',
      toolUseId: 'old-fetch',
      result: 'Source officielle consultée sur https://legifrance.gouv.fr avec le texte en vigueur et son article applicable.',
      isError: false,
      executed: true,
      continuationRequired: true,
    })

    expect(getObjectiveEvidenceCompletionGap(harness.managed.id)).toBe('authoritative evidence has not been inspected')
    expect(harness.managed.pendingTurnRecovery).toMatchObject({ userMessageId: newObjectiveUserId })
    expect(harness.managed.pendingTurnRecovery?.continuationRequired).toBeUndefined()
    expect(harness.managed.autonomyEvents?.some(event => (
      event.phase === 'verified' && event.toolName === 'WebFetch'
    )) ?? false).toBe(false)
  })

  it.each([true, false])('requeues an undelivered steer and restores the prior objective (legacy=%s)', async legacy => {
    if (!legacy) delete process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"]
    const harness = makeHarness('undelivered-user-steer')
    const redirected = installAgent(harness, [])
    const originalObjective = activeObjective('user-objective-a')
    const originalRecovery = createPendingTurnRecovery('user-objective-a', 1)
    harness.managed.messages.push({
      id: 'user-objective-a',
      role: 'user',
      content: 'Analyse le module A.',
      timestamp: 1,
    })
    harness.managed.activeObjective = originalObjective
    harness.managed.pendingTurnRecovery = originalRecovery
    harness.managed.isProcessing = true
    const steerOptions = { optimisticMessageId: 'optimistic-objective-b' }
    const originalText = 'Nouvel objectif : crée et vérifie le rapport B.'

    await harness.manager.sendMessage(
      harness.managed.id,
      originalText,
      undefined,
      undefined,
      steerOptions,
    )
    const steeredMessage = harness.managed.messages.at(-1)!
    expect(redirected).toHaveLength(1)
    expect(redirected[0]).toContain('<host_objective_contract')
    expect(harness.managed.activeObjective?.userMessageId).toBe(steeredMessage.id)

    await processEvent(harness, { type: 'steer_undelivered', message: redirected[0]! })
    await processEvent(harness, { type: 'steer_undelivered', message: redirected[0]! })

    expect(harness.managed.messageQueue).toHaveLength(1)
    expect(harness.managed.messageQueue[0]).toMatchObject({
      message: originalText,
      messageId: steeredMessage.id,
      optimisticMessageId: steerOptions.optimisticMessageId,
    })
    expect(harness.managed.messageQueue[0]?.options).toBe(steerOptions)
    expect(harness.managed.activeObjective).toBe(originalObjective)
    expect(harness.managed.pendingTurnRecovery).toBe(originalRecovery)
    expect(steeredMessage.content).toBe(originalText)
    expect(steeredMessage.content).not.toContain('host_objective_contract')
    expect(harness.managed.messageQueue[0]?.message).not.toContain('host_objective_contract')
    expect(harness.sentEvents.filter(event => event["type"] === 'user_message')).toHaveLength(1)
  })

  it('requeues an undelivered structured fallback as a hidden automatic runtime recovery', async () => {
    const harness = makeHarness('undelivered-structured-fallback')
    enableAutomaticToolFallback(harness)
    harness.managed.messages.push({
      id: 'user-fallback-root',
      role: 'user',
      content: 'Inspecte le système distant.',
      timestamp: 1,
    })
    harness.managed.activeObjective = activeObjective('user-fallback-root')
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('user-fallback-root', 1)
    const fallbackPrompt = buildAutonomyStructuredFallbackPrompt('mcp__session__browser_tool')

    await processEvent(harness, { type: 'steer_undelivered', message: fallbackPrompt })
    const allocation = structuredClone(harness.managed.pendingTurnRecovery?.recoveryDispatch)
    await processEvent(harness, { type: 'steer_undelivered', message: fallbackPrompt })

    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 1,
      recoveryDispatch: {
        phase: 'allocated',
        attempt: 1,
        cause: 'runtime_error',
        origin: 'automatic',
        fallbackIntent: {
          kind: 'structured_fallback',
          failedToolName: 'mcp__session__browser_tool',
        },
      },
    })
    expect(harness.managed.pendingTurnRecovery?.recoveryDispatch).toEqual(allocation)
    expect(harness.managed.messageQueue).toHaveLength(1)
    expect(harness.managed.messageQueue[0]?.message).toContain('<automatic_turn_recovery')
    expect(harness.managed.messageQueue[0]?.message).toContain(fallbackPrompt)
    expect(harness.managed.messageQueue[0]?.options).toMatchObject({
      hidden: true,
      internalOrigin: { kind: 'browser-fallback' },
      automaticRecovery: {
        originalUserMessageId: 'user-fallback-root',
        cause: 'runtime_error',
        dispatchAttempt: 1,
      },
    })
    expect(harness.managed.messages).toHaveLength(1)
    expect(harness.managed.wasInterrupted).toBe(true)
  })

  it('keeps a native unfinished plan active after restart when structured evidence is still missing', async () => {
    delete process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"]
    const harness = makeHarness('native-restart-plan')
    const user: Message = { id: 'native-root', role: 'user', content: 'Crée premier.md et second.md puis vérifie les deux.', timestamp: 1 }
    harness.managed.messages.push(user, {
      id: 'native-plan', role: 'tool', content: 'Plan updated', timestamp: 2,
      toolName: 'mcp__session__update_plan', toolStatus: 'completed', toolExecuted: true,
      toolInput: { plan: [{ step: 'Créer premier.md', status: 'completed' }, { step: 'Créer second.md et vérifier les deux', status: 'pending' }] },
    }, { id: 'native-false-final', role: 'assistant', content: 'Premier fichier livré.', timestamp: 3 })
    harness.managed.activeObjective = transitionObjectiveContract({ messageId: user.id, text: user.content, nowMs: 1 })
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery(user.id)
    await (harness.manager as {
      resumePendingTurnAfterRestart: (sessionId: string) => Promise<void>
    }).resumePendingTurnAfterRestart(harness.managed.id)
    expect(harness.managed.activeObjective?.terminalState).toBe('active')
    expect(harness.managed.pendingTurnRecovery).toMatchObject({ attempts: 1, lastCause: 'objective_incomplete' })
    expect(harness.managed.pendingTurnRecovery?.validationGaps).toContain('missing structured objective outcome receipt')
    expect(harness.managed.pendingTurnRecovery?.validationGaps).toContain('required execution evidence is missing')
    expect(harness.managed.messageQueue).toHaveLength(1)
    expect(harness.managed.messages.find(message => message.id === 'native-false-final')?.isIntermediate).toBe(true)
    expect(harness.resumedSessionIds).toEqual([harness.managed.id])
  })

  it('finishes a two-deliverable mission after an omitted step, with real files, automatic dispatch and persisted completion', async () => {
    delete process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"]
    const harness = makeHarness('native-complete-mission')
    const dir = harness.managed.workspace.rootPath
    const first = join(dir, 'premier.md')
    const second = join(dir, 'second.md')
    const path = join(dir, 'session.jsonl')
    const prompts: string[] = []
    let firstModifiedAt: number | undefined
    const runtime = sessionManagerForTest(harness.manager)
    const persist = (session: Managed) => {
      writeSessionJsonl(path, { ...pickSessionFields(session), workspaceRootPath: dir,
        createdAt: 1, lastUsedAt: Date.now(), messages: session.messages.map(messageToStored),
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
      } as never)
      return true
    }
    runtime.enqueuePersist = persist
    runtime.flushSession = async () => { persist(harness.managed) }
    // Use the real queue dispatcher, including its automatic admission checks.
    Reflect.deleteProperty(runtime, 'processNextQueuedMessage')
    async function* publishPlan(id: string, finished: boolean): AsyncGenerator<AgentEvent> {
      yield { type: 'tool_start', toolName: 'mcp__session__update_plan', toolUseId: id, input: { plan: [
        { step: 'Créer premier.md', status: 'completed' },
        ...(finished ? [{ step: 'Créer second.md', status: 'completed' }, { step: 'Vérifier les deux fichiers', status: 'completed' }]
          : [{ step: 'Créer second.md', status: 'pending' }, { step: 'Vérifier les deux fichiers', status: 'pending' }]),
      ] } }
      yield { type: 'tool_result', toolName: 'mcp__session__update_plan', toolUseId: id, result: 'Plan updated', executed: true, isError: false }
    }
    const agent = completeSessionAgentFixture(harness.managed.workspace, {
      async *chat(prompt: string): AsyncGenerator<AgentEvent> {
        prompts.push(prompt)
        if (prompts.length === 1) {
          const objective = harness.managed.activeObjective
          if (!objective) throw new Error('The accepted objective was not initialized')
          const criteria: ObjectiveAcceptanceCriterion[] = [
            { id: 'first-file-content', description: 'The first requested file has the exact verified content', toolName: 'Read', input: { file_path: first }, checks: [{ path: '$text', equals: 'Livrable vérifié' }] },
            { id: 'second-file-content', description: 'The second requested file has the exact verified content', toolName: 'Read', input: { file_path: second }, checks: [{ path: '$text', equals: 'Livrable vérifié' }] },
          ]
          yield { type: 'tool_start', toolName: 'mcp__session__set_completion_criteria', toolUseId: 'register-checks', input: { criteria } }
          harness.managed.activeObjective = registerObjectiveAcceptanceCriteria(objective, criteria, Date.now())
          yield { type: 'tool_result', toolName: 'mcp__session__set_completion_criteria', toolUseId: 'register-checks',
            result: JSON.stringify({ objectiveId: objective.objectiveId, criteria }), executed: true, isError: false }
        }
        const current = prompts.length === 1 ? first : second
        yield { type: 'tool_start', toolName: 'Write', toolUseId: `write-${prompts.length}`, input: { file_path: current, content: 'Livrable vérifié' } }
        writeFileSync(current, 'Livrable vérifié')
        yield { type: 'tool_result', toolName: 'Write', toolUseId: `write-${prompts.length}`, result: `Wrote ${current}`, executed: true, isError: false }
        if (prompts.length === 1) {
          firstModifiedAt = statSync(first).mtimeMs
          yield* publishPlan('partial-plan', false)
          yield { type: 'text_complete', text: 'Les livrables sont prêts.' }
        } else {
          for (const file of [first, second]) {
            yield { type: 'tool_start', toolName: 'Read', toolUseId: `read-${file}`, input: { file_path: file } }
            yield { type: 'tool_result', toolName: 'Read', toolUseId: `read-${file}`, result: readFileSync(file, 'utf8'), executed: true, isError: false }
          }
          yield* publishPlan('complete-plan', true)
          const objective = harness.managed.activeObjective
          if (!objective?.acceptanceCriteria?.length) throw new Error('The registered checks were not available for the final receipt')
          const review = scopeReviewFixture(objective, harness.managed.messages)
          yield { type: 'tool_start', toolName: review.toolName!, toolUseId: review.toolUseId!, input: review.toolInput! }
          yield { type: 'tool_result', toolName: review.toolName!, toolUseId: review.toolUseId!, result: review.toolResult!, executed: true, isError: false }
          const readEvidence = ['read-' + first, 'read-' + second]
          const receipt: ObjectiveOutcomeDeclaration = {
            state: 'complete_verified', blocker: null, remainingWork: [],
            criteria: [
              ...objective.acceptanceCriteria.map(criterion => ({ id: criterion.id, satisfied: true,
                evidence: [criterion.id === 'first-file-content' ? readEvidence[0]! : readEvidence[1]!],
              })),
              ...objective.completionCriteria.map(id => ({ id, satisfied: true,
                evidence: id === 'relevant-checks-passed' ? readEvidence
                  : id === 'requested-outcome-delivered' ? [review.toolUseId!] : ['assistant-final'],
              })),
            ],
          }
          yield { type: 'text_complete', text: `Les deux fichiers sont écrits et relus : [premier.md](<${first}>) et [second.md](<${second}>). ${outcomeComment(receipt)}` }
        }
        yield { type: 'complete' }
      },
      getModel: () => 'test/objective-model', getSessionId: () => null,
      isProcessing: () => false, setAllSources: () => {}, redirect: () => true,
    })
    harness.managed.agent = agent
    runtime.getOrCreateAgent = async session => { session.agent = agent; return agent }
    const completed = new Promise<void>(resolve => {
      const off = harness.manager.onSessionComplete(event => {
        if (event.sessionId === harness.managed.id && event.reason === 'complete') { off(); resolve() }
      })
    })
    await harness.manager.sendMessage(harness.managed.id, 'Crée premier.md et second.md, vérifie les deux fichiers puis livre leurs liens.')
    await completed
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('premier.md et second.md')
    expect(prompts[1]).toContain('Créer second.md')
    expect(prompts[0]).toContain('<host_objective_contract')
    expect(prompts[0]).toContain('robb_objective_outcome')
    expect(readFileSync(first, 'utf8')).toBe('Livrable vérifié')
    expect(readFileSync(second, 'utf8')).toBe('Livrable vérifié')
    if (firstModifiedAt === undefined) throw new Error('The first delivery was not observed')
    expect(statSync(first).mtimeMs).toBe(firstModifiedAt)
    const persisted = readSessionJsonl(path)!
    expect(persisted.activeObjective?.terminalState).toBe('complete_verified')
    expect(persisted.pendingTurnRecovery).toBeUndefined()
    expect(incompletePlanSteps(persisted.messages.map(storedToMessage), persisted.activeObjective!.userMessageId)).toEqual([])
    expect(harness.completions).toHaveLength(1)
  }, 15_000)

  it.each(['ask', 'allow-all'] as const)('requires structured mission evidence without widening authority (%s)', async permissionMode => {
    delete process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"]
    const harness = makeHarness('default-provider-driven-mode')
    harness.managed.permissionMode = permissionMode
    writeFileSync(join(harness.managed.workspace.rootPath, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      id: harness.managed.workspace.id,
      name: harness.managed.workspace.name,
      slug: harness.managed.workspace.id, createdAt: 1, updatedAt: 1,
      defaults: { permissionMode, externalActionPolicy: 'allow-in-execute' },
    }))
    const capturedPrompts: string[] = []
    const redirected: string[] = []
    let activeAuthority: {
      authorized: boolean | undefined
      sensitiveActionAuthorized: boolean | undefined
      authorizationSegments: string[]
    } | undefined
    const agent = completeSessionAgentFixture(harness.managed.workspace, {
      async *chat(prompt: string): AsyncGenerator<AgentEvent> {
        capturedPrompts.push(prompt)
        activeAuthority = (sessionManagerForTest(harness.manager)).resolveRuntimeObjectiveMutationAuthority(harness.managed)
        yield { type: 'text_complete', text: 'Le changement est terminé.' }
        yield { type: 'complete' }
      },
      getModel: () => 'test/objective-model',
      getSessionId: () => null,
      isProcessing: () => false,
      setAllSources: () => {},
      redirect: (message: string) => {
        redirected.push(message)
        return true
      },
    })
    harness.managed.agent = agent
    ;(sessionManagerForTest(harness.manager)).getOrCreateAgent = async session => {
      session.agent = agent
      return agent
    }

    await harness.manager.sendMessage(harness.managed.id, 'Implémente la correction puis teste-la.')

    expect(capturedPrompts).toHaveLength(1)
    expect(capturedPrompts[0]).toContain('<host_objective_contract')
    expect(capturedPrompts[0]).toContain('robb_objective_outcome')
    expect(capturedPrompts[0]?.includes('YOLO is active: complete the accepted objective without any human input or approval handoff.')).toBe(permissionMode === 'allow-all')
    expect(harness.managed.activeObjective?.terminalState).toBe('active')
    expect(harness.managed.pendingTurnRecovery).toMatchObject({ lastCause: 'objective_incomplete' })
    expect(harness.managed.pendingTurnRecovery?.validationGaps).toContain('missing structured objective outcome receipt')
    expect(harness.managed.messageQueue.length).toBeGreaterThan(0)
    expect(activeAuthority).toBeDefined()
    expect(activeAuthority!.authorized).toBeUndefined()
    expect(activeAuthority!.sensitiveActionAuthorized).toBeUndefined()
    expect(activeAuthority!.authorizationSegments.length).toBeGreaterThan(0)
  })
});
