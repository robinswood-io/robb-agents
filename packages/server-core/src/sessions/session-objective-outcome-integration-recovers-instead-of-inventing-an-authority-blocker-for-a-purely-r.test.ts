import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentEvent, type ObjectiveOutcomeDeclaration } from "@craft-agent/core/types";
import { clearObjectiveEvidenceGate } from "@craft-agent/shared/agent";
import { createPendingTurnRecovery } from "./turn-recovery.ts";
import { type Managed, activeObjective, installAgent, makeHarness, outcomeComment, roots, sessionIds } from "./testing/session-objective-outcome-integration-fixture.ts";

beforeEach(() => {
  roots.length = 0
  sessionIds.length = 0
  process.env.ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT = '1'
})
afterEach(() => {
  delete process.env.ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT
  for (const sessionId of sessionIds) clearObjectiveEvidenceGate(sessionId)
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('SessionManager objective outcome integration', () => {
  it('recovers instead of inventing an authority blocker for a purely read-only root mission', async () => {
    const harness = makeHarness('read-only-root-is-not-authority-boundary')
    const events: AgentEvent[] = [
      { type: 'tool_start', toolName: 'mcp__rbw-servers__get_status', toolUseId: 'zero-preflight-call',
        input: { server: 'zero' } },
      { type: 'tool_result', toolName: 'mcp__rbw-servers__get_status', toolUseId: 'zero-preflight-call',
        result: '{"reachable":true}', isError: false, executed: true },
      { type: 'text_complete', text: '' },
      { type: 'complete' },
    ]
    installAgent(harness, events, () => {
      const current = harness.managed.activeObjective!
      current.requiresAcceptanceCriteria = true
      current.acceptanceCriteria = [{
        id: 'zero-preflight', description: 'Zero staging preflight is reachable',
        toolName: 'mcp__rbw-servers__get_status', input: { server: 'zero' },
        checks: [{ path: '$.reachable', equals: true }],
      }]
      const receipt: ObjectiveOutcomeDeclaration = {
        state: 'blocked_human', criteria: [],
        remainingWork: ['Déployer Zero sur staging uniquement après une autorisation explicite'],
        blocker: { kind: 'external_authorization', description: 'Le déploiement reste hors autorité',
          evidence: [current.userMessageId] },
      }
      ;(events[2] as Extract<AgentEvent, { type: 'text_complete' }>).text =
        `Préflight lecture seule terminé ; aucune mutation n’a été exécutée.\n${outcomeComment(receipt)}`
    })

    await harness.manager.sendMessage(harness.managed.id,
      'Effectue uniquement le préflight Zero en lecture seule. N’effectue aucune mutation distante et ne déploie rien.')

    expect(harness.managed.activeObjective?.terminalState).toBe('active')
    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 1,
      lastCause: 'objective_incomplete',
      validationGaps: ['blocker evidence does not reference a matching host-observed blocker'],
    })
    expect(harness.managed.messageQueue).toHaveLength(1)
    expect(harness.managed.messageQueue[0]?.message).toContain('<automatic_turn_recovery')
  })

  it('replays the PLC checkpoint without accepting an invented pending confirmation', async () => {
    const harness = makeHarness('plc-invented-confirmation')
    const receipt: ObjectiveOutcomeDeclaration = {
      state: 'continue',
      criteria: [
        { id: 'requested-outcome-delivered', satisfied: false, evidence: ['assistant-final'] },
        { id: 'relevant-checks-passed', satisfied: false, evidence: ['assistant-final'] },
        { id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] },
      ],
      remainingWork: [
        'Attendre l’ouverture de l’accès et le contrat technique ISAGRI.',
        'Recevoir la confirmation d’envoi déjà demandée.',
        'Exécuter l’extraction ISAGRI réelle, la rapprocher de SharePoint et obtenir une revue indépendante PASS.',
      ],
      blocker: null,
    }
    installAgent(harness, [
      { type: 'text_complete', text: `Les parties sûres sont terminées ; la confirmation déjà demandée reste attendue.\n${outcomeComment(receipt)}` },
      { type: 'complete' },
    ], () => {
      Object.assign(harness.managed.activeObjective!, {
        orchestrationMode: 'mission', risk: 'standard',
        completionCriteria: ['requested-outcome-delivered', 'relevant-checks-passed', 'no-safe-work-remaining'],
      })
      delete harness.managed.activeObjective!.requiresExecutionEvidence
      delete harness.managed.activeObjective!.requiresObservationEvidence
      delete harness.managed.activeObjective!.requiresAcceptanceCriteria
      delete harness.managed.activeObjective!.acceptanceCriteria
      delete harness.managed.activeObjective!.evidenceRequirement
      delete harness.managed.activeObjective!.evidenceDomain
    })

    await harness.manager.sendMessage(harness.managed.id, 'Poursuis la mission PLC depuis les résultats déjà vérifiés.')

    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 1,
      lastCause: 'objective_incomplete',
      validationGaps: expect.arrayContaining([
        'remainingWork claims a pending human confirmation, but no structured question, authentication flow, or permission request is pending',
      ]),
    })
    expect(harness.managed.activeObjective?.lastOutcome).toBeUndefined()
    expect(harness.managed.messageQueue[0]?.message).toContain('no structured question, authentication flow, or permission request is pending')
  })

  it('normalizes a copied terminal criterion instead of spending a continuation retry on it', async () => {
    const harness = makeHarness('continued-no-safe-normalization')
    const receipt: ObjectiveOutcomeDeclaration = {
      state: 'continue',
      criteria: [{ id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] }],
      remainingWork: ['Run the final target-bound verification'],
      blocker: null,
    }
    installAgent(harness, [
      { type: 'text_complete', text: `Verification remains.\n${outcomeComment(receipt)}` },
      { type: 'complete' },
    ])

    await harness.manager.sendMessage(harness.managed.id, 'Implémente la correction puis vérifie-la.')

    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 1, lastCause: 'objective_continue', validationGaps: [],
      continuationWork: receipt.remainingWork,
    })
    expect(harness.managed.activeObjective?.lastOutcome).toMatchObject({
      state: 'continue',
      criteria: [{ id: 'no-safe-work-remaining', satisfied: false, evidence: [] }],
    })
    expect(harness.managed.messageQueue[0]?.message).toContain('valid progress receipt')
    expect(harness.managed.messages.some(message => message.errorCode === 'objective_validation_failed')).toBe(false)
  })

  it('accepts a concrete continuation before the first requested mutation executes', async () => {
    const harness = makeHarness('valid-pre-execution-continuation')
    const receipt: ObjectiveOutcomeDeclaration = {
      state: 'continue', criteria: [],
      remainingWork: ['Inspect the current implementation, then apply the scoped parser fix'], blocker: null,
    }
    installAgent(harness, [
      { type: 'text_complete', text: `Current state inspected; implementation remains.
${outcomeComment(receipt)}` },
      { type: 'complete' },
    ])

    await harness.manager.sendMessage(harness.managed.id, 'Implémente la correction du parseur puis vérifie-la.')

    expect(harness.managed.activeObjective?.requiresExecutionEvidence).toBe(true)
    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 1, lastCause: 'objective_continue', validationGaps: [],
      continuationWork: receipt.remainingWork,
      continuationOrigin: 'objective_continue',
    })
    expect(harness.managed.messageQueue).toHaveLength(1)
    expect(harness.managed.messages.some(message => message.errorCode === 'objective_validation_failed')).toBe(false)
    expect(harness.sentEvents.some(event => event.type === 'typed_error')).toBe(false)
  })

  it('continues corrective work when high-stakes evidence or review is still pending', async () => {
    const harness = makeHarness('valid-high-stakes-continuation')
    const receipt: ObjectiveOutcomeDeclaration = {
      state: 'continue', criteria: [],
      remainingWork: ['Inspect the authoritative legal source, apply the scoped correction, then obtain a fresh independent review'],
      blocker: null,
    }
    installAgent(harness, [
      { type: 'text_complete', text: `The source inspection and correction remain actionable.
${outcomeComment(receipt)}` },
      { type: 'complete' },
    ])

    await harness.manager.sendMessage(harness.managed.id,
      'Corrige ce contrat juridique après vérification des sources officielles, puis fais une revue indépendante.')

    expect(harness.managed.activeObjective).toMatchObject({
      risk: 'high-stakes', evidenceRequirement: 'authoritative-sources-before-mutation', terminalState: 'active',
    })
    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 1, lastCause: 'objective_continue', validationGaps: [],
      continuationWork: receipt.remainingWork,
      continuationOrigin: 'objective_continue',
    })
    expect(harness.managed.messages.some(message => message.errorCode === 'objective_validation_failed')).toBe(false)
    expect(harness.sentEvents.some(event => event.type === 'typed_error')).toBe(false)
  })

  it.each(['app_restart', 'runtime_error', 'stream_ended', 'tool_checkpoint', 'premature_final',
    'objective_incomplete', 'evidence_gate'] as const)(
    'preserves validated continuation work and its logical origin across %s', async cause => {
      const harness = makeHarness(`continuation-${cause}`)
      harness.managed.messages.push({ id: 'continuation-root', role: 'user', content: 'Finish the target.', timestamp: 1 })
      harness.managed.activeObjective = activeObjective('continuation-root')
      harness.managed.pendingTurnRecovery = {
        ...createPendingTurnRecovery('continuation-root', 1),
        lastCause: 'objective_continue',
        continuationWork: ['Run the final verification'],
        continuationOrigin: 'objective_continue',
      }
      const enqueue = (harness.manager as unknown as {
        enqueueAutomaticTurnRecovery: (
          managed: Managed,
          cause: 'app_restart' | 'runtime_error' | 'stream_ended' | 'tool_checkpoint' | 'premature_final'
            | 'objective_incomplete' | 'evidence_gate',
        ) => Promise<boolean>
      }).enqueueAutomaticTurnRecovery.bind(harness.manager)

      expect(await enqueue(harness.managed, cause)).toBe(true)
      expect(harness.managed.pendingTurnRecovery).toMatchObject({
        attempts: 1, lastCause: cause,
        continuationWork: ['Run the final verification'],
        continuationOrigin: 'objective_continue',
      })
      if (cause === 'evidence_gate') {
        expect(harness.managed.messageQueue[0]?.message).toContain('strictly read-only')
        expect(harness.managed.messageQueue[0]?.message).toContain('evidence-only pass must not execute it')
        expect(harness.managed.messageQueue[0]?.message).toContain('deferred until a later authorized continuation')
        expect(harness.managed.messageQueue[0]?.message).not.toContain('then resume without repeating')
        expect(harness.managed.messageQueue[0]?.message).not.toContain('remainingWork to execute')
      } else {
        expect(harness.managed.messageQueue[0]?.message).toContain('recovery event did not replace')
      }
      expect(harness.managed.messageQueue[0]?.message).toContain('Run the final verification')
    },
  )

  it('carries authenticated continuation provenance through a real structural tool checkpoint', async () => {
    const harness = makeHarness('continuation-real-tool-checkpoint')
    installAgent(harness, [
      { type: 'tool_start', toolName: 'Edit', toolUseId: 'bounded-edit', input: { file_path: 'target.json' } },
      {
        type: 'tool_result', toolName: 'Edit', toolUseId: 'bounded-edit',
        result: 'Tool-call budget checkpoint', isError: false, executed: false,
        continuationRequired: true,
        checkpoint: { schemaVersion: 1, kind: 'tool-call-budget', reason: 'Continue in the next bounded pass.' },
      },
      { type: 'complete' },
    ], () => {
      Object.assign(harness.managed.pendingTurnRecovery!, {
        attempts: 1,
        lastCause: 'objective_continue',
        continuationWork: ['Finish the edit', 'Run the final verification'],
        continuationOrigin: 'objective_continue',
      })
    })

    await harness.manager.sendMessage(harness.managed.id, 'Implémente le changement puis vérifie-le.')

    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 2, lastCause: 'tool_checkpoint',
      continuationWork: ['Finish the edit', 'Run the final verification'],
      continuationOrigin: 'objective_continue',
    })
    expect(harness.managed.messageQueue).toHaveLength(1)
    expect(harness.managed.messageQueue[0]?.message).toContain('tool-call budget reached a structural checkpoint')
    expect(harness.managed.messageQueue[0]?.message).toContain('Reconcile its preserved remainingWork')
    expect(harness.managed.messageQueue[0]?.message).toContain('Run the final verification')
  })

  it('preserves an authenticated continuation snapshot when a tool checkpoint exhausts its limit', async () => {
    const harness = makeHarness('continuation-exhausted-tool-checkpoint')
    writeFileSync(join(harness.managed.workspace.rootPath, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      id: harness.managed.workspace.id,
      name: harness.managed.workspace.name,
      slug: 'continuation-exhausted-tool-checkpoint',
      createdAt: 1,
      updatedAt: 1,
      costControl: { recovery: { maxAutomaticAttempts: 1 } },
    }))
    installAgent(harness, [
      { type: 'tool_start', toolName: 'Edit', toolUseId: 'bounded-edit', input: { file_path: 'target.json' } },
      {
        type: 'tool_result', toolName: 'Edit', toolUseId: 'bounded-edit',
        result: 'Tool-call budget checkpoint', isError: false, executed: false,
        continuationRequired: true,
        checkpoint: { schemaVersion: 1, kind: 'tool-call-budget', reason: 'Continue in the next bounded pass.' },
      },
      { type: 'complete' },
    ], () => {
      Object.assign(harness.managed.pendingTurnRecovery!, {
        attempts: 1,
        lastCause: 'objective_continue',
        continuationWork: ['Finish the edit', 'Run the final verification'],
        continuationOrigin: 'objective_continue',
      })
    })

    await harness.manager.sendMessage(harness.managed.id, 'Implémente le changement puis vérifie-le.')

    expect(harness.managed.pendingTurnRecovery).toBeUndefined()
    expect(harness.managed.activeObjective).toMatchObject({
      terminalState: 'exhausted',
      interruptedTurnRecovery: { recovery: {
        attempts: 1, lastCause: 'tool_checkpoint',
        continuationWork: ['Finish the edit', 'Run the final verification'],
        continuationOrigin: 'objective_continue',
      } },
    })
    expect(harness.managed.activeObjective?.interruptedTurnRecovery?.recovery.exhaustedAt).toBeNumber()
    expect(harness.managed.messages.some(message => message.role === 'error')).toBe(false)
    expect(harness.sentEvents.some(event => event.type === 'typed_error')).toBe(false)
    expect(harness.sentEvents).toContainEqual(expect.objectContaining({
      type: 'info', message: expect.stringContaining('structural tool checkpoint'),
    }))
  })

  it('does not invent continuation provenance for an unrelated premature final', async () => {
    const harness = makeHarness('unrelated-premature-final')
    harness.managed.messages.push({ id: 'premature-root', role: 'user', content: 'Finish the target.', timestamp: 1 })
    harness.managed.activeObjective = activeObjective('premature-root')
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('premature-root', 1)
    const enqueue = (harness.manager as unknown as {
      enqueueAutomaticTurnRecovery: (managed: Managed, cause: 'premature_final') => Promise<boolean>
    }).enqueueAutomaticTurnRecovery.bind(harness.manager)

    expect(await enqueue(harness.managed, 'premature_final')).toBe(true)
    expect(harness.managed.pendingTurnRecovery?.continuationOrigin).toBeUndefined()
    expect(harness.managed.pendingTurnRecovery?.continuationWork).toBeUndefined()
    expect(harness.managed.messageQueue[0]?.message).not.toContain('Host-preserved remainingWork')
  })

  it.each([0, 1, 2])(
    'preserves legacy maxAutomaticAttempts=%i for validated continuations when no dedicated limit exists', async maxAutomaticAttempts => {
      const harness = makeHarness(`continuation-budget-${maxAutomaticAttempts}`)
      writeFileSync(join(harness.managed.workspace.rootPath, 'config.json'), JSON.stringify({
        schemaVersion: 1,
        id: harness.managed.workspace.id,
        name: harness.managed.workspace.name,
        slug: `continuation-budget-${maxAutomaticAttempts}`,
        createdAt: 1,
        updatedAt: 1,
        costControl: { recovery: { maxAutomaticAttempts } },
      }))
      harness.managed.messages.push({ id: 'budget-root', role: 'user', content: 'Finish the target.', timestamp: 1 })
      harness.managed.activeObjective = activeObjective('budget-root')
      harness.managed.pendingTurnRecovery = createPendingTurnRecovery('budget-root', 1)
      const enqueue = (harness.manager as unknown as {
        enqueueAutomaticTurnRecovery: (
          managed: Managed,
          cause: 'objective_continue',
          gaps: string[],
          continuationWork: string[],
        ) => Promise<boolean>
      }).enqueueAutomaticTurnRecovery.bind(harness.manager)

      for (let attempt = 0; attempt < maxAutomaticAttempts; attempt += 1) {
        expect(await enqueue(harness.managed, 'objective_continue', [], ['Finish verification'])).toBe(true)
        expect(harness.managed.pendingTurnRecovery?.attempts).toBe(attempt + 1)
        harness.managed.messageQueue.length = 0
        harness.managed.messages.push({
          id: `progress-${attempt}`, role: 'tool', content: `verified-${attempt}`, timestamp: attempt + 2,
          toolName: 'Read', toolUseId: `progress-call-${attempt}`, toolStatus: 'completed', toolExecuted: true,
          toolInput: { path: `target-${attempt}.json` }, toolResult: `verified-${attempt}`,
        })
      }
      expect(await enqueue(harness.managed, 'objective_continue', [], ['Finish verification'])).toBe(false)
      expect(harness.managed.pendingTurnRecovery).toMatchObject({
        attempts: maxAutomaticAttempts,
        exhaustedAt: expect.any(Number),
        continuationOrigin: 'objective_continue',
      })
    },
  )

  it('allows four semantically progressing validated continuations by default', async () => {
    const harness = makeHarness('default-validated-continuation-budget')
    harness.managed.messages.push({ id: 'budget-root', role: 'user', content: 'Finish the target.', timestamp: 1 })
    harness.managed.activeObjective = activeObjective('budget-root')
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('budget-root', 1)
    const enqueue = (harness.manager as unknown as {
      enqueueAutomaticTurnRecovery: (
        managed: Managed,
        cause: 'objective_continue',
        gaps: string[],
        continuationWork: string[],
      ) => Promise<boolean>
    }).enqueueAutomaticTurnRecovery.bind(harness.manager)

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await enqueue(harness.managed, 'objective_continue', [], ['Finish verification'])).toBe(true)
      expect(harness.managed.pendingTurnRecovery?.attempts).toBe(attempt + 1)
      harness.managed.messageQueue.length = 0
      harness.managed.messages.push({
        id: `default-progress-${attempt}`, role: 'tool', content: `verified-${attempt}`, timestamp: attempt + 2,
        toolName: 'Read', toolUseId: `default-progress-call-${attempt}`, toolStatus: 'completed', toolExecuted: true,
        toolInput: { path: `default-target-${attempt}.json` }, toolResult: `verified-${attempt}`,
      })
    }

    expect(await enqueue(harness.managed, 'objective_continue', [], ['Finish verification'])).toBe(false)
    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 4,
      exhaustedAt: expect.any(Number),
      continuationOrigin: 'objective_continue',
    })
  })
});
