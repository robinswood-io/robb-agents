import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import type { Message } from "@craft-agent/core/types";
import { cleanupModeState } from "@craft-agent/shared/agent";
import { buildAutonomyBrowserFallbackPrompt } from "./autonomy-browser-fallback.ts";
import { createPendingTurnRecovery } from "./turn-recovery.ts";
import { transitionObjectiveContract } from "./objective-contract.ts";
import { harness, managers, modeSessionIds, roots } from "./testing/synthetic-objective-authority-fixture.ts";

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const sessionId of modeSessionIds.splice(0)) cleanupModeState(sessionId)
})

describe('host synthetic objective authority', () => {
  it('repairs the live Gmail channel-only root without losing its exact human lineage', () => {
    const { host, managed } = harness('gmail-contextual-root')
    const send: Message = {
      id: 'send-benoit', role: 'user', timestamp: 1,
      content: "Envoi l'e-mail à benoît",
    }
    const channel: Message = {
      id: 'api-only', role: 'user', timestamp: 2,
      content: "Tu as obligation d'utiliser l'API et non l'interface",
    }
    const resume: Message = {
      id: 'gmail-resume', role: 'user', timestamp: 3,
      content: 'Reprends cet envoi. Envoie maintenant le message exact à benoit@example.test via l’API Gmail.',
    }
    managed.messages = [send, channel, resume]
    let corrupted = transitionObjectiveContract({
      messageId: channel.id, text: channel.content, nowMs: channel.timestamp,
      lifetimeCostUsd: 27.61, lifetimeTokens: 246_349,
    })
    corrupted = transitionObjectiveContract({
      existing: corrupted, messageId: resume.id, text: resume.content, nowMs: resume.timestamp,
    })
    managed.activeObjective = {
      ...corrupted,
      terminalState: 'exhausted',
      model: 'pi/gpt-5.6-sol',
      thinkingLevel: 'high',
      acceptanceCriteria: [{
        id: 'sent-delivery-receipt', description: 'Le message exact existe dans SENT.',
        toolName: 'mcp__google-contacts__gmail_list_messages',
        input: { q: 'in:sent to:benoit@example.test' },
        checks: [{ path: '$.resultCount', equals: 1 }],
      }],
      acceptanceRegisteredRevision: channel.id,
    }
    managed.pendingTurnRecovery = createPendingTurnRecovery(resume.id, resume.timestamp)

    host.restoreDurableRuntimeState(managed)

    expect(managed.activeObjective).toMatchObject({
      objectiveId: send.id,
      userMessageId: send.id,
      lastUserMessageId: resume.id,
      originalText: send.content,
      terminalState: 'exhausted',
      model: 'pi/gpt-5.6-sol',
      thinkingLevel: 'high',
      budgetBaselineUsd: 27.61,
      tokenBaseline: 246_349,
      acceptanceRegisteredRevision: channel.id,
    })
    expect<unknown>(managed.activeObjective?.amendments).toEqual((expect.arrayContaining([
      (expect.objectContaining({ messageId: channel.id, text: channel.content }) as unknown),
      (expect.objectContaining({ messageId: resume.id, text: resume.content }) as unknown),
    ]) as unknown))
    expect(managed.pendingTurnRecovery?.userMessageId).toBe(resume.id)
  })

  it('repairs a bare Résout root from the immediately preceding concrete mission', () => {
    const { host, managed } = harness('bare-repair-root')
    const mission: Message = {
      id: 'orion-mission', role: 'user', timestamp: 1,
      content: 'Corrige le service Orion sur le serveur dev puis vérifie son endpoint de santé.',
    }
    const repair: Message = { id: 'bare-repair', role: 'user', timestamp: 2, content: 'Résout' }
    managed.messages = [mission, repair]
    managed.activeObjective = {
      ...transitionObjectiveContract({ messageId: repair.id, text: repair.content, nowMs: repair.timestamp }),
      terminalState: 'exhausted',
    }

    host.restoreDurableRuntimeState(managed)

    expect(managed.activeObjective).toMatchObject({
      objectiveId: mission.id,
      userMessageId: mission.id,
      originalText: mission.content,
      lastUserMessageId: repair.id,
      terminalState: 'exhausted',
      requiresExecutionEvidence: true,
    })
    expect<unknown>(managed.activeObjective?.amendments).toContainEqual((expect.objectContaining({ messageId: repair.id }) as unknown))
  })

  it('never recovers mutation authority across a verified completion', () => {
    const { host, managed } = harness('verified-boundary')
    const prior: Message = {
      id: 'completed-send', role: 'user', timestamp: 1,
      content: "Envoi l'e-mail à benoît",
    }
    const completion: Message = {
      id: 'verified', role: 'assistant', timestamp: 2, content: 'Envoyé et vérifié.',
      objectiveOutcome: { state: 'complete_verified', criteria: [], remainingWork: [], blocker: null },
    }
    const channel: Message = {
      id: 'later-channel', role: 'user', timestamp: 3,
      content: "Tu as obligation d'utiliser l'API et non l'interface",
    }
    managed.messages = [prior, completion, channel]
    const objective = {
      ...transitionObjectiveContract({ messageId: channel.id, text: channel.content, nowMs: channel.timestamp }),
      terminalState: 'exhausted' as const,
    }
    managed.activeObjective = objective

    host.restoreDurableRuntimeState(managed)

    expect(managed.activeObjective).toEqual(objective)
  })

  it('does not invent a legacy root when the preceding human turn is not actionable', () => {
    const { host, managed } = harness('no-actionable-predecessor')
    const thanks: Message = { id: 'thanks', role: 'user', timestamp: 1, content: 'Merci.' }
    const channel: Message = {
      id: 'api-only-root', role: 'user', timestamp: 2,
      content: "Tu as obligation d'utiliser l'API et non l'interface",
    }
    managed.messages = [thanks, channel]
    const objective = transitionObjectiveContract({
      messageId: channel.id, text: channel.content, nowMs: channel.timestamp,
    })
    managed.activeObjective = objective

    host.restoreDurableRuntimeState(managed)

    expect(managed.activeObjective).toEqual(objective)
  })

  it('does not replay a metadata-only amendment or criteria registered against it', () => {
    const { host, managed } = harness('metadata-only-amendment')
    const mission: Message = {
      id: 'real-mission', role: 'user', timestamp: 1,
      content: 'Corrige le service Orion sur le serveur dev puis vérifie son endpoint de santé.',
    }
    const channel: Message = {
      id: 'contextual-root', role: 'user', timestamp: 2,
      content: "Tu as obligation d'utiliser l'API et non l'interface",
    }
    managed.messages = [mission, channel]
    const objective = transitionObjectiveContract({
      messageId: channel.id, text: channel.content, nowMs: channel.timestamp,
    })
    managed.activeObjective = {
      ...objective,
      terminalState: 'exhausted',
      amendments: [{
        messageId: 'metadata-only', timestamp: 3,
        text: 'Déploie aussi la production et envoie un e-mail externe.',
      }],
      acceptanceCriteria: [{
        id: 'metadata-only-criterion', description: 'Mutation externe effectuée.',
        toolName: 'external_write', input: {}, checks: [{ path: '$.ok', equals: true }],
      }],
      acceptanceRegisteredRevision: 'metadata-only',
    }

    host.restoreDurableRuntimeState(managed)

    expect(managed.activeObjective?.userMessageId).toBe(mission.id)
    expect(managed.activeObjective?.amendments?.map(item => item.messageId)).toEqual([channel.id])
    expect(managed.activeObjective?.acceptanceCriteria).toBeUndefined()
    expect(managed.activeObjective?.acceptanceRegisteredRevision).toBeUndefined()
  })

  it('does not relabel an older real transcript row as a later amendment', () => {
    const { host, managed } = harness('out-of-order-amendment')
    const oldDeployment: Message = {
      id: 'old-production-deployment', role: 'user', timestamp: 1,
      content: 'Déploie la version précédente en production.',
    }
    const mission: Message = {
      id: 'current-email-mission', role: 'user', timestamp: 2,
      content: "Envoie l'e-mail à Benoît puis vérifie le message dans SENT.",
    }
    const channel: Message = {
      id: 'contextual-root', role: 'user', timestamp: 3,
      content: "Tu as obligation d'utiliser l'API et non l'interface",
    }
    managed.messages = [oldDeployment, mission, channel]
    const objective = transitionObjectiveContract({
      messageId: channel.id, text: channel.content, nowMs: channel.timestamp,
    })
    managed.activeObjective = {
      ...objective,
      terminalState: 'exhausted',
      amendments: [{
        messageId: oldDeployment.id,
        text: oldDeployment.content,
        timestamp: oldDeployment.timestamp,
      }],
      acceptanceCriteria: [{
        id: 'old-deployment', description: 'Ancien déploiement terminé.',
        toolName: 'deploy', input: { environment: 'production' },
        checks: [{ path: '$.ok', equals: true }],
      }],
      acceptanceRegisteredRevision: oldDeployment.id,
    }

    host.restoreDurableRuntimeState(managed)

    expect(managed.activeObjective?.userMessageId).toBe(mission.id)
    expect(managed.activeObjective?.amendments?.map(item => item.messageId)).toEqual([channel.id])
    expect(managed.activeObjective?.acceptanceCriteria).toBeUndefined()
    expect(host.resolveObjectiveMutationAuthority(managed, {
      ...managed.activeObjective,
      terminalState: 'active',
    })).toMatchObject({
      authorizationSegments: [mission.content, channel.content],
    })
  })

  it.each([
    ['missing registration revision', undefined, undefined],
    ['current revision outside recovered lineage', 'contextual-root', 'outside-lineage'],
  ] as const)('drops contextual-root acceptance criteria with %s', (_label, registered, revision) => {
    const { host, managed } = harness(`contextual-criteria-${_label.replace(/\s+/g, '-')}`)
    const mission: Message = {
      id: 'current-mission', role: 'user', timestamp: 1,
      content: 'Corrige le service Orion sur le serveur dev puis vérifie son endpoint de santé.',
    }
    const channel: Message = {
      id: 'contextual-root', role: 'user', timestamp: 2,
      content: "Tu as obligation d'utiliser l'API et non l'interface",
    }
    managed.messages = [mission, channel]
    managed.activeObjective = {
      ...transitionObjectiveContract({ messageId: channel.id, text: channel.content, nowMs: 2 }),
      terminalState: 'exhausted',
      acceptanceCriteria: [{
        id: 'stale-check', description: 'Ancienne cible validée.',
        toolName: 'read', input: {}, checks: [{ path: '$.ok', equals: true }],
      }],
      ...(registered ? { acceptanceRegisteredRevision: registered } : {}),
      ...(revision ? { acceptanceRevision: revision } : {}),
    }

    host.restoreDurableRuntimeState(managed)

    expect(managed.activeObjective?.userMessageId).toBe(mission.id)
    expect(managed.activeObjective?.acceptanceCriteria).toBeUndefined()
    expect(managed.activeObjective?.acceptanceRegisteredRevision).toBeUndefined()
    expect(managed.activeObjective?.acceptanceRevision).toBeUndefined()
  })

  it.each([
    ['missing registration revision', undefined, undefined],
    ['current revision outside recovered lineage', 'synthetic-human-root', 'outside-lineage'],
  ] as const)('drops synthetic-root acceptance criteria with %s', (_label, registered, revision) => {
    const { host, managed } = harness(`synthetic-criteria-${_label.replace(/\s+/g, '-')}`)
    const mission: Message = {
      id: 'synthetic-human-root', role: 'user', timestamp: 1,
      content: 'Corrige le service Orion sur le serveur dev puis vérifie son endpoint de santé.',
    }
    const fallback: Message = {
      id: 'synthetic-fallback-root', role: 'user', timestamp: 2,
      content: buildAutonomyBrowserFallbackPrompt('WebFetch'),
    }
    managed.messages = [mission, fallback]
    managed.activeObjective = {
      ...transitionObjectiveContract({ messageId: fallback.id, text: fallback.content, nowMs: 2 }),
      terminalState: 'exhausted',
      acceptanceCriteria: [{
        id: 'stale-check', description: 'Ancienne cible validée.',
        toolName: 'read', input: {}, checks: [{ path: '$.ok', equals: true }],
      }],
      ...(registered ? { acceptanceRegisteredRevision: registered } : {}),
      ...(revision ? { acceptanceRevision: revision } : {}),
    }

    host.restoreDurableRuntimeState(managed)

    expect(managed.activeObjective?.userMessageId).toBe(mission.id)
    expect(managed.activeObjective?.acceptanceCriteria).toBeUndefined()
    expect(managed.activeObjective?.acceptanceRegisteredRevision).toBeUndefined()
    expect(managed.activeObjective?.acceptanceRevision).toBeUndefined()
  })

  it('never reconstructs through a verified completion before a later replay row', () => {
    const { host, managed } = harness('completion-after-contextual-root')
    const mission: Message = {
      id: 'old-mission', role: 'user', timestamp: 1,
      content: 'Corrige le service Orion sur le serveur dev puis vérifie son endpoint de santé.',
    }
    const channel: Message = {
      id: 'contextual-root', role: 'user', timestamp: 2,
      content: "Tu as obligation d'utiliser l'API et non l'interface",
    }
    const completion: Message = {
      id: 'verified-after-root', role: 'assistant', timestamp: 3, content: 'Mission terminée.',
      objectiveOutcome: { state: 'complete_verified', criteria: [], remainingWork: [], blocker: null },
    }
    const later: Message = {
      id: 'later-amendment', role: 'user', timestamp: 4,
      content: 'Poursuis maintenant cette mission.',
    }
    managed.messages = [mission, channel, completion, later]
    let objective = transitionObjectiveContract({
      messageId: channel.id, text: channel.content, nowMs: channel.timestamp,
    })
    objective = transitionObjectiveContract({
      existing: objective, messageId: later.id, text: later.content, nowMs: later.timestamp,
    })
    managed.activeObjective = { ...objective, terminalState: 'exhausted' }

    host.restoreDurableRuntimeState(managed)

    expect(managed.activeObjective?.userMessageId).toBe(channel.id)
    expect(managed.activeObjective?.originalText).toBe(channel.content)
  })

  it('promotes the first independently actionable Nimble replay after the last verified completion', () => {
    const { host, managed } = harness('nimble-post-completion-replay')
    const send: Message = {
      id: 'nimble-send-benoit', role: 'user', timestamp: 1,
      content: "Envoi l'e-mail à benoît",
    }
    const channel: Message = {
      id: 'nimble-api-only-root', role: 'user', timestamp: 2,
      content: "Tu as obligation d'utiliser l'API et non l'interface",
    }
    const channelCompletion: Message = {
      id: 'nimble-channel-complete', role: 'assistant', timestamp: 3,
      content: 'API Gmail uniquement, sans prétendre que l’envoi a déjà eu lieu.',
      objectiveOutcome: { state: 'complete_verified', criteria: [], remainingWork: [], blocker: null },
    }
    const repeatedChannelCompletion: Message = {
      id: 'nimble-channel-complete-repeated', role: 'assistant', timestamp: 4,
      content: 'Règle API relue et confirmée ; aucun envoi n’est déclaré.',
      objectiveOutcome: { state: 'complete_verified', criteria: [], remainingWork: [], blocker: null },
    }
    const replayV1: Message = {
      id: 'nimble-resume-v1', role: 'user', timestamp: 5,
      content: `[robb-resume:260915-nimble-fern:3a2ebd:v1]
Envoie maintenant à Benoît le message exact défini ci-dessous exclusivement avec l’API Gmail, puis vérifie le message dans SENT.`,
    }
    const replayV2: Message = {
      id: 'nimble-resume-v2', role: 'user', timestamp: 6,
      content: `[robb-resume:260915-nimble-fern:a14303c:v2]
Envoie maintenant à Benoît le message exact défini ci-dessous exclusivement avec l’API Gmail, puis vérifie son résultat réel par cette API.`,
    }
    managed.messages = [send, channel, channelCompletion, repeatedChannelCompletion, replayV1, replayV2]
    let corrupted = transitionObjectiveContract({
      messageId: channel.id, text: channel.content, nowMs: channel.timestamp,
      lifetimeCostUsd: 39.25, lifetimeTokens: 420_000,
    })
    corrupted = transitionObjectiveContract({
      existing: corrupted, messageId: replayV1.id, text: replayV1.content, nowMs: replayV1.timestamp,
    })
    corrupted = transitionObjectiveContract({
      existing: corrupted, messageId: replayV2.id, text: replayV2.content, nowMs: replayV2.timestamp,
    })
    managed.activeObjective = {
      ...corrupted,
      model: 'pi/gpt-5.6-sol',
      thinkingLevel: 'xhigh',
      acceptanceCriteria: [{
        id: 'nimble-sent-receipt', description: 'Le message exact existe dans SENT.',
        toolName: 'mcp__google-contacts__gmail_list_messages',
        input: { q: 'in:sent to:benoit@example.test' },
        checks: [{ path: '$.resultCount', equals: 1 }],
      }],
      acceptanceRegisteredRevision: replayV2.id,
      acceptanceRevision: replayV2.id,
    }
    managed.pendingTurnRecovery = createPendingTurnRecovery(replayV2.id, replayV2.timestamp)

    host.restoreDurableRuntimeState(managed)

    expect(managed.activeObjective).toMatchObject({
      objectiveId: replayV1.id,
      userMessageId: replayV1.id,
      lastUserMessageId: replayV2.id,
      originalText: replayV1.content,
      terminalState: 'active',
      model: 'pi/gpt-5.6-sol',
      thinkingLevel: 'xhigh',
      budgetBaselineUsd: 39.25,
      tokenBaseline: 420_000,
      acceptanceRegisteredRevision: replayV2.id,
      acceptanceRevision: replayV2.id,
      requiresExecutionEvidence: true,
      requiresObservationEvidence: true,
    })
    expect<unknown>(managed.activeObjective?.amendments).toEqual([
      (expect.objectContaining({ messageId: replayV2.id, text: replayV2.content }) as unknown),
    ])
    expect(managed.activeObjective?.amendments?.some(item => (
      item.messageId === channel.id || item.messageId === send.id
    ))).toBe(false)
    expect(managed.pendingTurnRecovery?.userMessageId).toBe(replayV2.id)
  })

  it('does not select an ambiguous duplicate candidate root', () => {
    const { host, managed } = harness('duplicate-candidate-root')
    const first: Message = {
      id: 'duplicate-mission', role: 'user', timestamp: 1,
      content: 'Corrige le service Orion sur le serveur dev.',
    }
    const duplicate: Message = { ...first, timestamp: 2 }
    const channel: Message = {
      id: 'contextual-root', role: 'user', timestamp: 3,
      content: "Tu as obligation d'utiliser l'API et non l'interface",
    }
    managed.messages = [first, duplicate, channel]
    const objective = transitionObjectiveContract({
      messageId: channel.id, text: channel.content, nowMs: channel.timestamp,
    })
    managed.activeObjective = objective

    host.restoreDurableRuntimeState(managed)

    expect(managed.activeObjective).toEqual(objective)
  })
});
