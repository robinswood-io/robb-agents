import { rehydrateObjectiveEvidence as policyRehydrateObjectiveEvidence } from "./SessionManager/policy.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { type Message } from "@craft-agent/core/types";
import { checkObjectiveEvidenceBeforeMutation, clearObjectiveEvidenceGate, getObjectiveEvidenceCompletionGap } from "@craft-agent/shared/agent";
import { createPendingTurnRecovery } from "./turn-recovery.ts";
import { transitionObjectiveContract } from "./objective-contract.ts";
import { type Harness, type Managed, activeObjective, installAgent, makeHarness, roots, sessionIds } from "./testing/session-objective-outcome-integration-fixture.ts";

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
  it('rehydrates only non-empty, actually executed evidence after a restart', () => {
    const harness = makeHarness('restart-evidence')
    const userMessage: Message = {
      id: 'user-legal',
      role: 'user',
      content: 'Corrige ce contrat juridique après vérification des sources.',
      timestamp: 1,
    }
    harness.managed.messages.push(userMessage, {
      id: 'checkpoint-read',
      role: 'tool',
      content: '',
      timestamp: 2,
      toolName: 'WebFetch',
      toolUseId: 'checkpoint-fetch',
      toolStatus: 'completed',
      toolExecuted: false,
      toolResult: 'https://legifrance.gouv.fr source officielle qui ne doit pas compter car l’appel n’a pas été exécuté.',
    }, {
      id: 'empty-read',
      role: 'tool',
      content: '',
      timestamp: 3,
      toolName: 'WebFetch',
      toolUseId: 'empty-fetch',
      toolStatus: 'completed',
      toolExecuted: true,
      toolResult: '',
    })
    harness.managed.activeObjective = {
      ...activeObjective(userMessage.id),
      risk: 'high-stakes',
      evidenceRequirement: 'authoritative-sources-before-mutation',
      completionCriteria: [
        'requested-outcome-delivered',
        'relevant-checks-passed',
        'no-safe-work-remaining',
        'independent-review-passed',
      ],
    }

    ;policyRehydrateObjectiveEvidence(harness.managed)
    expect(getObjectiveEvidenceCompletionGap(harness.managed.id)).toBe('authoritative evidence has not been inspected')

    harness.managed.messages.push({
      id: 'executed-read',
      role: 'tool',
      content: '',
      timestamp: 4,
      toolName: 'WebFetch',
      toolUseId: 'executed-fetch',
      toolStatus: 'completed',
      toolExecuted: true,
      toolResult: 'Source officielle consultée sur https://legifrance.gouv.fr avec le texte en vigueur et son article applicable.',
    })
    ;policyRehydrateObjectiveEvidence(harness.managed)
    expect(getObjectiveEvidenceCompletionGap(harness.managed.id)).toBe('independent review has not been completed')
  })

  it('rehydrates the high-stakes gate only from persisted objective authority', () => {
    const rehydrate = (harness: Harness) => policyRehydrateObjectiveEvidence(harness.managed)

    const readOnly = makeHarness('read-only-negated-high-stakes-words')
    readOnly.managed.messages.push({
      id: 'user-read-only-security',
      role: 'user',
      content: 'Analyse la sécurité du déploiement en lecture seule. Ne pas modifier les fichiers ni déployer.',
      timestamp: 1,
    })
    readOnly.managed.activeObjective = activeObjective('user-read-only-security')
    rehydrate(readOnly)
    expect(getObjectiveEvidenceCompletionGap(readOnly.managed.id)).toBeUndefined()

    const mutating = makeHarness('authorized-high-stakes-mutation')
    mutating.managed.messages.push({
      id: 'user-legal-mutation',
      role: 'user',
      content: 'Corrige ce contrat juridique après vérification des sources.',
      timestamp: 1,
    })
    mutating.managed.activeObjective = {
      ...activeObjective('user-legal-mutation'),
      risk: 'high-stakes',
      evidenceRequirement: 'authoritative-sources-before-mutation',
    }
    rehydrate(mutating)
    expect(getObjectiveEvidenceCompletionGap(mutating.managed.id)).toBe('authoritative evidence has not been inspected')
  })

  it('rehydrates an amendment-promoted security gate and resets an older legal domain', () => {
    const rehydrate = (harness: Harness) => policyRehydrateObjectiveEvidence(harness.managed)

    const promoted = makeHarness('amendment-promoted-security')
    const promotedRoot: Message = {
      id: 'promoted-root', role: 'user', content: 'Prépare puis vérifie la page.', timestamp: 1,
    }
    const securityAmendment: Message = {
      id: 'security-amendment', role: 'user',
      content: 'Corrige maintenant les permissions de sécurité.', timestamp: 2,
    }
    promoted.managed.messages.push(promotedRoot, securityAmendment)
    promoted.managed.activeObjective = transitionObjectiveContract({
      existing: transitionObjectiveContract({
        messageId: promotedRoot.id, text: promotedRoot.content, nowMs: promotedRoot.timestamp,
      }),
      messageId: securityAmendment.id,
      text: securityAmendment.content,
      nowMs: securityAmendment.timestamp,
    })
    expect(promoted.managed.activeObjective.risk).toBe('high-stakes')
    rehydrate(promoted)
    expect(checkObjectiveEvidenceBeforeMutation(promoted.managed.id, 'Write', 'local-write'))
      .toMatchObject({ allowed: false, reason: expect.stringContaining('security source') })

    const changed = makeHarness('legal-to-security-amendment')
    const legalRoot: Message = {
      id: 'legal-root', role: 'user', content: 'Corrige ce contrat juridique.', timestamp: 1,
    }
    changed.managed.messages.push(legalRoot, {
      id: 'legal-source', role: 'tool', content: '', timestamp: 2,
      toolName: 'WebFetch', toolUseId: 'legal-source-call', toolStatus: 'completed',
      toolExecuted: true, isError: false,
      toolResult: 'Source juridique officielle consultée sur https://legifrance.gouv.fr avec le texte applicable.',
    })
    const legalObjective = transitionObjectiveContract({
      messageId: legalRoot.id, text: legalRoot.content, nowMs: legalRoot.timestamp,
    })
    changed.managed.activeObjective = legalObjective
    rehydrate(changed)
    expect(getObjectiveEvidenceCompletionGap(changed.managed.id)).toBe('independent review has not been completed')

    const changedAmendment: Message = {
      ...securityAmendment, id: 'changed-security-amendment', timestamp: 3,
    }
    changed.managed.messages.push(changedAmendment)
    changed.managed.activeObjective = transitionObjectiveContract({
      existing: legalObjective,
      messageId: changedAmendment.id,
      text: changedAmendment.content,
      nowMs: changedAmendment.timestamp,
    })
    rehydrate(changed)
    expect(getObjectiveEvidenceCompletionGap(changed.managed.id)).toBe('authoritative evidence has not been inspected')
    expect(checkObjectiveEvidenceBeforeMutation(changed.managed.id, 'Write', 'local-write'))
      .toMatchObject({ allowed: false, reason: expect.stringContaining('security source') })
  })

  it.each([
    'Fix the security vulnerability.',
    'Rotate the security credentials.',
    'Configure the RBAC permissions.',
  ])('rehydrates the host-authorized security domain for %s', text => {
    const harness = makeHarness(`security-authority-${text.split(' ')[0]!.toLowerCase()}`)
    const root: Message = { id: 'security-root', role: 'user', content: text, timestamp: 1 }
    harness.managed.messages.push(root)
    harness.managed.activeObjective = transitionObjectiveContract({
      messageId: root.id, text: root.content, nowMs: root.timestamp,
    })
    expect(harness.managed.activeObjective).toMatchObject({
      risk: 'high-stakes',
      evidenceRequirement: 'authoritative-sources-before-mutation',
    })

    ;policyRehydrateObjectiveEvidence(harness.managed)
    expect(checkObjectiveEvidenceBeforeMutation(harness.managed.id, 'Write', 'local-write'))
      .toMatchObject({ allowed: false, reason: expect.stringContaining('security source') })
  })

  it('uses a read-only audit subject only after a later deictic correction authorizes it', () => {
    const harness = makeHarness('read-only-security-amendment')
    const root: Message = {
      id: 'read-only-domain-root', role: 'user', content: 'Corrige ce contrat juridique.', timestamp: 1,
    }
    const amendment: Message = {
      id: 'read-only-security', role: 'user',
      content: 'Analyse les permissions de sécurité en lecture seule. Ne modifie rien.', timestamp: 2,
    }
    const correction: Message = {
      id: 'correct-security-findings', role: 'user', content: 'Fais les corrections nécessaires.', timestamp: 3,
    }
    harness.managed.messages.push(root, amendment, correction)
    const audited = transitionObjectiveContract({
      existing: transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: root.timestamp }),
      messageId: amendment.id, text: amendment.content, nowMs: amendment.timestamp,
    })
    expect(audited.evidenceDomain).toBe('legal')
    harness.managed.activeObjective = transitionObjectiveContract({
      existing: audited, messageId: correction.id, text: correction.content, nowMs: correction.timestamp,
    })
    expect(harness.managed.activeObjective).toMatchObject({
      risk: 'high-stakes', evidenceDomain: 'security',
      evidenceRequirement: 'authoritative-sources-before-mutation',
    })

    ;policyRehydrateObjectiveEvidence(harness.managed)
    expect(checkObjectiveEvidenceBeforeMutation(harness.managed.id, 'Write', 'local-write'))
      .toMatchObject({ allowed: false, reason: expect.stringContaining('security source') })
  })

  it('retains an older security gate anchor beyond the bounded amendment window', () => {
    const harness = makeHarness('long-amendment-security-anchor')
    const root: Message = {
      id: 'long-root', role: 'user', content: 'Prépare puis vérifie la page.', timestamp: 1,
    }
    const security: Message = {
      id: 'long-security', role: 'user',
      content: 'Corrige maintenant les permissions de sécurité.', timestamp: 2,
    }
    harness.managed.messages.push(root, security)
    let objective = transitionObjectiveContract({
      existing: transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: root.timestamp }),
      messageId: security.id, text: security.content, nowMs: security.timestamp,
    })
    for (let index = 0; index < 20; index += 1) {
      const presentation: Message = {
        id: `presentation-${index}`, role: 'user', content: `Utilise un ton simple ${index}.`, timestamp: 3 + index,
      }
      harness.managed.messages.push(presentation)
      objective = transitionObjectiveContract({
        existing: objective,
        messageId: presentation.id,
        text: presentation.content,
        nowMs: presentation.timestamp,
      })
    }
    const production: Message = {
      id: 'production-amendment', role: 'user',
      content: 'Déploie maintenant la page en production.', timestamp: 23,
    }
    harness.managed.messages.push(production)
    harness.managed.activeObjective = transitionObjectiveContract({
      existing: objective,
      messageId: production.id,
      text: production.content,
      nowMs: production.timestamp,
    })
    expect(harness.managed.activeObjective).toMatchObject({
      risk: 'high-stakes',
      evidenceRequirement: 'authoritative-sources-before-mutation',
    })

    ;policyRehydrateObjectiveEvidence(harness.managed)
    expect(checkObjectiveEvidenceBeforeMutation(harness.managed.id, 'Write', 'local-write'))
      .toMatchObject({ allowed: false, reason: expect.stringContaining('security source') })
  })

  it('atomically replaces the objective and recovery anchor when a distinct user steer is accepted', async () => {
    const harness = makeHarness('distinct-steer')
    const redirected = installAgent(harness, [])
    harness.managed.messages.push({
      id: 'user-objective-a',
      role: 'user',
      content: 'Analyse le module A.',
      timestamp: 1,
    })
    harness.managed.activeObjective = activeObjective('user-objective-a')
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('user-objective-a', 1)
    harness.managed.isProcessing = true

    await harness.manager.sendMessage(harness.managed.id, 'Nouvel objectif : crée et vérifie le rapport B.')

    const steeredUser = harness.managed.messages.at(-1)!
    expect(steeredUser.role).toBe('user')
    expect(harness.managed.activeObjective).toMatchObject({
      objectiveId: steeredUser.id,
      userMessageId: steeredUser.id,
      lastUserMessageId: steeredUser.id,
      continuationCount: 0,
      terminalState: 'active',
    })
    expect(harness.managed.pendingTurnRecovery?.userMessageId).toBe(steeredUser.id)
    expect(redirected).toHaveLength(1)
    expect(redirected[0]).toContain('Nouvel objectif : crée et vérifie le rapport B.')
    expect(redirected[0]).toContain(`objective_user_message_id="${steeredUser.id}"`)
    expect(harness.managed.messageQueue).toEqual([])
    expect(harness.sentEvents).toContainEqual(expect.objectContaining({
      type: 'user_message',
      status: 'accepted',
    }))
  })

  it('keeps the objective and recovery budgets when an accepted user steer clarifies the task', async () => {
    const harness = makeHarness('continuation-steer')
    const redirected = installAgent(harness, [])
    harness.managed.messages.push({
      id: 'user-root',
      role: 'user',
      content: 'Implémente et vérifie le changement.',
      timestamp: 1,
    })
    harness.managed.activeObjective = activeObjective('user-root')
    harness.managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery('user-root', 1),
      attempts: 3, stagnantAttempts: 1, leaseExpiresAt: 12345,
      validationGaps: ['Business criterion lacks matching post-action evidence: document'],
    }
    harness.managed.isProcessing = true

    await harness.manager.sendMessage(harness.managed.id, 'Le document reste illisible, utilise plutôt le navigateur.')

    const continuation = harness.managed.messages.at(-1)!
    expect(harness.managed.activeObjective).toMatchObject({
      objectiveId: 'user-root',
      userMessageId: 'user-root',
      lastUserMessageId: continuation.id,
      continuationCount: 1,
      terminalState: 'active',
    })
    expect(harness.managed.pendingTurnRecovery?.userMessageId).toBe(continuation.id)
    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 3, stagnantAttempts: 1, startedAt: 1, leaseExpiresAt: 12345,
      validationGaps: ['Business criterion lacks matching post-action evidence: document'],
    })
    expect(redirected).toHaveLength(1)
    expect(redirected[0]).toContain('objective_user_message_id="user-root"')
    expect(harness.managed.messageQueue).toEqual([])
  })

  it('does not replace the running objective when an internal follow-up is queued', async () => {
    const harness = makeHarness('queued-follow-up')
    const redirected = installAgent(harness, [])
    harness.managed.messages.push({
      id: 'user-running-objective',
      role: 'user',
      content: 'Implémente et vérifie le changement A.',
      timestamp: 1,
    })
    harness.managed.activeObjective = activeObjective('user-running-objective')
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('user-running-objective', 1)
    harness.managed.isProcessing = true

    await harness.manager.sendMessage(
      harness.managed.id,
      'Le spécialiste a terminé le rapport B.',
      undefined,
      undefined,
      { internalOrigin: { kind: 'agent-message', senderSessionId: 'specialist-b' } },
    )

    expect(redirected).toEqual([])
    expect(harness.managed.activeObjective).toMatchObject({
      objectiveId: 'user-running-objective',
      userMessageId: 'user-running-objective',
      lastUserMessageId: 'user-running-objective',
    })
    expect(harness.managed.pendingTurnRecovery?.userMessageId).toBe('user-running-objective')
    expect(harness.managed.messageQueue).toHaveLength(1)
    expect(harness.managed.messageQueue[0]).toMatchObject({
      message: 'Le spécialiste a terminé le rapport B.',
      options: { internalOrigin: { kind: 'agent-message', senderSessionId: 'specialist-b' } },
    })
    expect(harness.sentEvents).toContainEqual(expect.objectContaining({
      type: 'user_message',
      status: 'queued',
    }))
  })

  it('does not reset the parent objective or retry budget when a queued agent report is consumed', async () => {
    const harness = makeHarness('consumed-agent-report')
    harness.managed.messages.push({ id: 'parent-root', role: 'user', content: 'Vérifie le document.', timestamp: 1 })
    const objective = activeObjective('parent-root')
    harness.managed.activeObjective = objective
    harness.managed.pendingTurnRecovery = { ...createPendingTurnRecovery('parent-root', 1), attempts: 4 }
    let consumed = false
    installAgent(harness, [{ type: 'complete' }], () => {
      consumed = true
      expect(harness.managed.activeObjective).toEqual(objective)
      expect(harness.managed.pendingTurnRecovery).toMatchObject({ userMessageId: 'parent-root', attempts: 4, startedAt: 1 })
    })
    await harness.manager.sendMessage(harness.managed.id, 'Le spécialiste a terminé son rapport.', undefined, undefined, {
      internalOrigin: { kind: 'agent-message', senderSessionId: 'specialist' },
    })
    expect(consumed).toBe(true)
  })

  it('stops repeated contract rejection despite volatile successful tool output and persisted recovery', async () => {
    const harness = makeHarness('unchanged-contract')
    const rootText = 'Déploie le résultat demandé puis vérifie-le.'
    harness.managed.messages.push({ id: 'root', role: 'user', content: rootText, timestamp: 1 })
    harness.managed.activeObjective = { ...activeObjective('root'), originalText: rootText }
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('root')
    const enqueue = (harness.manager as unknown as {
      enqueueAutomaticTurnRecovery: (managed: Managed, cause: 'objective_incomplete' | 'app_restart', gaps?: string[]) => Promise<boolean>
    }).enqueueAutomaticTurnRecovery.bind(harness.manager)
    const gaps = ['Business criterion lacks matching post-action evidence: delivered']
    expect(await enqueue(harness.managed, 'objective_incomplete', gaps)).toBe(true)
    harness.managed.messageQueue.length = 0
    harness.managed.messages.push({ id: 'date1', role: 'tool', content: '', timestamp: 2, toolName: 'Bash', toolInput: { command: 'date' }, toolResult: '12:00:01', toolStatus: 'completed', toolExecuted: true })
    expect(await enqueue(harness.managed, 'objective_incomplete', gaps)).toBe(false)
    harness.managed.messageQueue.length = 0
    harness.managed.messages.push({ id: 'date2', role: 'tool', content: '', timestamp: 3, toolName: 'Bash', toolInput: { command: 'date' }, toolResult: '12:00:02', toolStatus: 'completed', toolExecuted: true })
    expect(await enqueue(harness.managed, 'objective_incomplete', gaps)).toBe(false)
    expect(harness.managed.pendingTurnRecovery?.exhaustedAt).toBeNumber()
    expect(harness.managed.messageQueue).toEqual([])
    harness.managed.pendingTurnRecovery = JSON.parse(JSON.stringify(harness.managed.pendingTurnRecovery))
    harness.managed.messages.push({ id: 'date3', role: 'tool', content: '', timestamp: 4, toolName: 'Bash', toolInput: { command: 'date' }, toolResult: '12:00:03', toolStatus: 'completed', toolExecuted: true })
    expect(await enqueue(harness.managed, 'app_restart')).toBe(false)
    expect(harness.managed.pendingTurnRecovery?.exhaustedAt).toBeNumber()
    expect(harness.managed.messageQueue).toEqual([])
  })
});
