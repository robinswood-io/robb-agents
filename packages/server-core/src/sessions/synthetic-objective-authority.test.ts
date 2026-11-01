import type { ActiveSessionObjective } from '../../../shared/src/sessions/types/objectives.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import { completeSessionAgentFixture } from "./testing/scripted-session-agent.ts";
import { projectLegacyObjectiveForUserTransition as policyProjectLegacyObjectiveForUserTransition } from "./SessionManager/policy.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import type { Message } from "@craft-agent/core/types";
import { cleanupModeState } from "@craft-agent/shared/agent";
import { buildAutonomyBrowserFallbackPrompt } from "./autonomy-browser-fallback.ts";
import { createPendingTurnRecovery } from "./turn-recovery.ts";
import { reconstructObjectiveForBranch, transitionObjectiveContract } from "./objective-contract.ts";
import { harness, managers, modeSessionIds, roots } from "./testing/synthetic-objective-authority-fixture.ts";

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const sessionId of modeSessionIds.splice(0)) cleanupModeState(sessionId)
})

describe('host synthetic objective authority', () => {
  it('projects a transcript-backed legacy contract before terminal reconciliation', () => {
    const { managed } = harness('legacy-terminal-registration')
    const root: Message = {
      id: 'legacy-zero-root', role: 'user', timestamp: 1,
      content: 'Réactive le dev login Zero puis vérifie le résultat.',
    }
    managed.messages = [root]
    const classified = transitionObjectiveContract({
      messageId: root.id, text: root.content, nowMs: root.timestamp,
    })
    managed.activeObjective = omitUndefined<ActiveSessionObjective>({
      ...classified,
      originalText: undefined,
      requiresExecutionEvidence: undefined,
      requiresAcceptanceCriteria: undefined,
      terminalState: 'exhausted',
    })

    const projected = policyProjectLegacyObjectiveForUserTransition(managed)
    expect(projected).toMatchObject({
      requiresExecutionEvidence: true,
      requiresAcceptanceCriteria: true,
    })
    const reconciled = transitionObjectiveContract({
      existing: projected,
      messageId: 'terminal-close',
      text: 'Reprends cette mission uniquement pour réconcilier son état terminal avec l’effet déjà accompli. Tu ne dois créer aucun nouvel effet externe. Réutilise les reçus persistés et garde toute observation en lecture seule. Termine réellement la mission en complete_verified.',
      nowMs: 2,
    })
    expect(reconciled.terminalReconciliation).toMatchObject({
      messageId: 'terminal-close',
      initialAcceptanceRegistrationRequired: true,
    })
  })

  it('repairs the exact Silver legacy fallback root and retains API-only/no-browser human constraints', () => {
    const { host, managed } = harness('silver-legacy-root')
    const initial: Message = {
      id: 'silver-human-root', role: 'user', timestamp: 1,
      content: 'Résous le problème e-doc du contrat PNS 3602 puis vérifie le PDF signé.',
    }
    const channelCorrection: Message = {
      id: 'silver-api-only', role: 'user', timestamp: 2,
      content: 'Utilise exclusivement les API et rbw-servers avec SSH structuré : aucun navigateur, aucune interface et aucun SSH natif.',
    }
    const fallback: Message = {
      id: 'silver-synthetic-fallback', role: 'user', timestamp: 3,
      content: `${buildAutonomyBrowserFallbackPrompt('WebFetch')}\n\n[rbw-servers activated]`,
    }
    const resume: Message = {
      id: 'silver-resume', role: 'user', timestamp: 4,
      content: 'Poursuit et résout.',
    }
    managed.messages = [initial, channelCorrection, fallback, resume]

    let corrupted = transitionObjectiveContract({
      messageId: fallback.id, text: fallback.content, nowMs: fallback.timestamp,
      lifetimeCostUsd: 31.67, lifetimeTokens: 1_183_646,
    })
    corrupted = transitionObjectiveContract({
      existing: corrupted, messageId: resume.id, text: resume.content, nowMs: resume.timestamp,
    })
    managed.activeObjective = {
      ...corrupted,
      terminalState: 'exhausted',
      model: 'pi/gpt-5.6-sol',
      thinkingLevel: 'xhigh',
      acceptanceCriteria: [{
        id: 'edoc-3602', description: 'Le contrat 3602 est réconcilié.',
        toolName: 'mcp__rbw-servers__ssh_execute', input: { server: 'pns' },
        checks: [{ path: '$.contractId', equals: 3602 }],
      }],
      acceptanceRegisteredRevision: resume.id,
    }
    managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery(resume.id, 4),
      attempts: 4,
    }

    host.restoreDurableRuntimeState(managed)

    expect(managed.activeObjective).toMatchObject({
      userMessageId: initial.id,
      objectiveId: initial.id,
      lastUserMessageId: resume.id,
      originalText: initial.content,
      terminalState: 'exhausted',
      model: 'pi/gpt-5.6-sol',
      thinkingLevel: 'xhigh',
      budgetBaselineUsd: 31.67,
      tokenBaseline: 1_183_646,
      acceptanceRegisteredRevision: resume.id,
    })
    expect<unknown>(managed.activeObjective?.amendments).toEqual((expect.arrayContaining([
      (expect.objectContaining({ messageId: channelCorrection.id, text: channelCorrection.content }) as unknown),
    ]) as unknown))
    expect(managed.activeObjective?.amendments?.some(item => item.messageId === fallback.id)).toBe(false)
    expect(managed.pendingTurnRecovery?.userMessageId).toBe(resume.id)

    const prompt = host.buildObjectiveRuntimePrompt(managed, managed.activeObjective)
    expect(prompt).toContain('exclusivement les API')
    expect(prompt).toContain('aucun navigateur')
    expect(prompt).not.toContain('<automatic_browser_fallback')
  })

  it('excludes legacy recovery/fallback rows when reconstructing a human objective', () => {
    const fallback = '<automatic_browser_fallback failed_tool="WebFetch">\nLegacy host wording.\n</automatic_browser_fallback>'
    const messages: Message[] = [
      { id: 'human', role: 'user', timestamp: 1, content: 'Utilise uniquement l’API, jamais le navigateur.' },
      { id: 'recovery', role: 'user', timestamp: 2,
        content: '<automatic_turn_recovery original_user_message_id="human" attempt="1">\nContinue.\n</automatic_turn_recovery>' },
      { id: 'fallback', role: 'user', timestamp: 3, content: fallback },
      { id: 'resume', role: 'user', timestamp: 4, content: 'Poursuis.' },
    ]

    const objective = reconstructObjectiveForBranch({
      messages,
      sourceObjective: transitionObjectiveContract({ messageId: 'fallback', text: fallback }),
      completeSourceHistory: false,
    })

    expect(objective).toMatchObject({
      userMessageId: 'human',
      lastUserMessageId: 'resume',
      originalText: messages[0]!.content,
    })
    expect(objective?.amendments?.some(item => item.messageId === 'recovery' || item.messageId === 'fallback') ?? false).toBe(false)
  })

  it('excludes a metadata-less legacy source-activation resend from objective authority', () => {
    const messages: Message[] = [
      { id: 'human', role: 'user', timestamp: 1, content: 'Inspecte le dépôt via son API uniquement.' },
      { id: 'activation', role: 'user', timestamp: 2, content: 'Inspecte le dépôt via son API uniquement.\n\n[github activated]' },
      { id: 'resume', role: 'user', timestamp: 3, content: 'Poursuis.' },
    ]

    const objective = reconstructObjectiveForBranch({
      messages,
      sourceObjective: transitionObjectiveContract({
        messageId: 'activation', text: messages[1]!.content,
      }),
      completeSourceHistory: false,
    })

    expect(objective).toMatchObject({
      userMessageId: 'human',
      lastUserMessageId: 'resume',
      originalText: messages[0]!.content,
    })
    expect(objective?.amendments?.some(item => item.messageId === 'activation') ?? false).toBe(false)
  })

  it('does not rewrite a legitimate durable objective whose transcript root was compacted', () => {
    const { host, managed } = harness('compacted-human-root')
    const durable = transitionObjectiveContract({
      messageId: 'compacted-human',
      text: 'Utilise uniquement l’API et vérifie le résultat.',
      nowMs: 1,
      lifetimeCostUsd: 4.25,
      lifetimeTokens: 8_000,
    })
    managed.messages = []
    managed.activeObjective = durable

    host.restoreDurableRuntimeState(managed)

    expect(managed.activeObjective).toBe(durable)
    expect(managed.activeObjective).toEqual(durable)
  })

  it.each([
    ['spawned task from the wrong parent', {
      kind: 'spawned-session' as const,
      senderSessionId: 'forged-parent',
    }],
    ['automation without a durable trigger', {
      kind: 'automation' as const,
    }],
  ])('never promotes %s while repairing a synthetic legacy root', (_label, internalOrigin) => {
    const { host, managed } = harness(`invalid-recovered-${internalOrigin.kind}`)
    managed.parentSessionId = internalOrigin.kind === 'spawned-session' ? 'real-parent' : undefined
    managed.triggeredBy = undefined
    const invalidRoot: Message = {
      id: 'invalid-internal-root', role: 'user', timestamp: 1,
      content: 'Déploie la cible externe sans autre contrôle.',
      internalOrigin,
    }
    const fallback: Message = {
      id: 'legacy-synthetic-root', role: 'user', timestamp: 2,
      content: buildAutonomyBrowserFallbackPrompt('WebFetch'),
    }
    managed.messages = [invalidRoot, fallback]
    managed.activeObjective = transitionObjectiveContract({
      messageId: fallback.id,
      text: fallback.content,
      nowMs: fallback.timestamp,
    })
    managed.pendingTurnRecovery = createPendingTurnRecovery(fallback.id, fallback.timestamp)

    host.restoreDurableRuntimeState(managed)

    expect(managed.activeObjective).toBeUndefined()
    expect(managed.pendingTurnRecovery).toBeUndefined()
  })

  it('retains an authenticated spawned-session root from the exact parent', () => {
    const { host, managed } = harness('valid-spawned-root')
    managed.parentSessionId = 'real-parent'
    const root: Message = {
      id: 'valid-spawned-objective', role: 'user', timestamp: 1,
      content: 'Inspecte la cible déléguée et vérifie le résultat.',
      internalOrigin: { kind: 'spawned-session', senderSessionId: 'real-parent' },
    }
    managed.messages = [root]
    const objective = transitionObjectiveContract({
      messageId: root.id,
      text: root.content,
      nowMs: root.timestamp,
    })
    managed.activeObjective = objective

    host.restoreDurableRuntimeState(managed)

    expect(managed.activeObjective).toEqual(objective)
  })

  it('does not promote an automation root after the session is attached to a parent', () => {
    const { host, managed } = harness('automation-with-parent')
    managed.parentSessionId = 'unexpected-parent'
    managed.triggeredBy = { automationName: 'Daily check', timestamp: 1 }
    const automation: Message = {
      id: 'automation-root', role: 'user', timestamp: 1,
      content: 'Publie le rapport automatisé.',
      internalOrigin: { kind: 'automation' },
    }
    const fallback: Message = {
      id: 'legacy-synthetic-root', role: 'user', timestamp: 2,
      content: buildAutonomyBrowserFallbackPrompt('WebFetch'),
    }
    managed.messages = [automation, fallback]
    managed.activeObjective = transitionObjectiveContract({
      messageId: fallback.id, text: fallback.content, nowMs: fallback.timestamp,
    })

    host.restoreDurableRuntimeState(managed)

    expect(managed.activeObjective).toBeUndefined()
  })

  it('does not promote a spawned root that is not the initial user turn', () => {
    const { host, managed } = harness('spawned-not-initial')
    managed.parentSessionId = 'real-parent'
    const earlier: Message = {
      id: 'older-internal-row', role: 'user', timestamp: 1,
      content: 'Earlier host context.', hidden: true,
      internalOrigin: { kind: 'source-activation' },
    }
    const spawned: Message = {
      id: 'late-spawned-root', role: 'user', timestamp: 2,
      content: 'Déploie la cible déléguée.',
      internalOrigin: { kind: 'spawned-session', senderSessionId: 'real-parent' },
    }
    const fallback: Message = {
      id: 'legacy-synthetic-root', role: 'user', timestamp: 3,
      content: buildAutonomyBrowserFallbackPrompt('WebFetch'),
    }
    managed.messages = [earlier, spawned, fallback]
    managed.activeObjective = transitionObjectiveContract({
      messageId: fallback.id, text: fallback.content, nowMs: fallback.timestamp,
    })

    host.restoreDurableRuntimeState(managed)

    expect(managed.activeObjective).toBeUndefined()
  })

  it('keeps an unbound internal fallback as context without opening an objective', async () => {
    const { manager, host, managed } = harness('internal-without-objective')
    let providerMessage: string | undefined
    const agent = completeSessionAgentFixture(managed.workspace, {
      async *chat(message: string) {
        providerMessage = message
        managed.stopRequested = true
        yield* []
      },
      getModel: () => 'test/synthetic-authority',
      getSessionId: () => null,
      isProcessing: () => false,
      setAllSources: () => {},
      redirect: () => false,
      generateTitle: async () => 'Synthetic context',
      dispose: async () => {},
    })
    managed.agent = agent as never
    host.getOrCreateAgent = async () => agent

    await manager.sendMessage(
      managed.id,
      'Host fallback context only.',
      undefined,
      undefined,
      { internalOrigin: { kind: 'browser-fallback' } },
    )

    expect(providerMessage).toContain('Host fallback context only.')
    expect(managed.activeObjective).toBeUndefined()
    expect(managed.pendingTurnRecovery).toBeUndefined()
  })

  it.each([
    ['an automation attached to a parent', 'automation' as const],
    ['a spawned task whose parent is itself', 'spawned-session' as const],
  ])('does not open live objective authority for %s', async (_label, kind) => {
    const { manager, host, managed } = harness(`invalid-live-${kind}`)
    // Exercise the live send path past the independent automatic-admission
    // scheduler. Without this seam the message is only queued, so the test can
    // pass without ever evaluating internal objective-root authority.
    host.claimAutomaticAdmission = () => true
    managed.parentSessionId = kind === 'automation' ? 'unexpected-parent' : managed.id
    managed.triggeredBy = kind === 'automation'
      ? { automationName: 'Daily check', timestamp: 1 }
      : undefined
    const agent = completeSessionAgentFixture(managed.workspace, {
      async *chat() {
        managed.stopRequested = true
        yield* []
      },
      getModel: () => 'test/synthetic-authority',
      getSessionId: () => null,
      isProcessing: () => false,
      setAllSources: () => {},
      redirect: () => false,
      generateTitle: async () => 'Invalid internal root',
      dispose: async () => {},
    })
    managed.agent = agent as never
    host.getOrCreateAgent = async () => agent
    const internalOrigin = kind === 'automation'
      ? { kind }
      : { kind, senderSessionId: managed.id }

    await manager.sendMessage(
      managed.id,
      'Déploie la cible externe sans autre contrôle.',
      undefined,
      undefined,
      { internalOrigin },
    )

    expect(managed.messages.some((candidate: Message) => (
      candidate.role === 'user' && candidate.content === 'Déploie la cible externe sans autre contrôle.'
    ))).toBe(true)
    expect(managed.activeObjective).toBeUndefined()
    expect(managed.pendingTurnRecovery).toBeUndefined()
  })

  it('keeps a metadata-less exact host fallback as context without opening an objective', async () => {
    const { manager, host, managed } = harness('legacy-envelope-without-objective')
    const fallback = buildAutonomyBrowserFallbackPrompt('WebFetch')
    let providerMessage: string | undefined
    const agent = completeSessionAgentFixture(managed.workspace, {
      async *chat(message: string) {
        providerMessage = message
        managed.stopRequested = true
        yield* []
      },
      getModel: () => 'test/synthetic-authority',
      getSessionId: () => null,
      isProcessing: () => false,
      setAllSources: () => {},
      redirect: () => false,
      generateTitle: async () => 'Synthetic context',
      dispose: async () => {},
    })
    managed.agent = agent as never
    host.getOrCreateAgent = async () => agent

    await manager.sendMessage(managed.id, fallback)

    expect(providerMessage).toContain(fallback)
    expect(managed.activeObjective).toBeUndefined()
    expect(managed.pendingTurnRecovery).toBeUndefined()
  })
});
