import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import type { ObjectiveOutcomeDeclaration } from '@craft-agent/core/types'
import { clearObjectiveEvidenceGate } from '@craft-agent/shared/agent'
import { installAgent, makeHarness, outcomeComment, roots, sessionIds } from './testing/session-objective-outcome-integration-fixture.ts'

beforeEach(() => {
  roots.length = 0
  sessionIds.length = 0
  delete process.env['ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT']
})

afterEach(() => {
  for (const id of sessionIds) clearObjectiveEvidenceGate(id)
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const progress: ObjectiveOutcomeDeclaration = {
  state: 'continue',
  criteria: [],
  remainingWork: ['Finish the requested status check'],
  blocker: null,
}

describe('initial objective provider prompt', () => {
  it('sends the structured contract once for a direct objective and omits it on follow-up', async () => {
    const harness = makeHarness('direct-objective-prompt')
    installAgent(harness, [
      { type: 'text_complete', text: `Progress recorded. ${outcomeComment(progress)}` },
      { type: 'complete' },
    ])
    await harness.manager.sendMessage(harness.managed.id, 'Create a file named status.txt containing the word ready.')
    const initialPrompt = harness.providerMessages[0]!
    expect(harness.managed.activeObjective).toMatchObject({
      orchestrationMode: 'direct',
      requiresAcceptanceCriteria: true,
      requiresExecutionEvidence: true,
    })
    expect(initialPrompt).toContain('set_completion_criteria')
    expect(initialPrompt).toContain('robb_objective_outcome')
    expect(initialPrompt.match(/<host_objective_contract/g)).toHaveLength(1)
    expect(harness.managed.messages.find(message => message.role === 'user')?.content)
      .toBe('Create a file named status.txt containing the word ready.')
    expect(harness.managed.messageQueue[0]?.message).not.toContain('<host_objective_contract')

    harness.managed.messageQueue.length = 0
    harness.managed.pendingTurnRecovery = undefined
    await harness.manager.sendMessage(harness.managed.id, 'Continue that same status check.')
    const followUpPrompt = harness.providerMessages[1]!
    expect(followUpPrompt).not.toContain('<host_objective_contract')
    expect(followUpPrompt).not.toContain('set_completion_criteria')
    expect(followUpPrompt).not.toContain('robb_objective_outcome')
  })

  it('does not inject the structured contract into a simple conversation', async () => {
    const harness = makeHarness('simple-chat-prompt')
    installAgent(harness, [
      { type: 'text_complete', text: 'Paris is the capital of France.' },
      { type: 'complete' },
    ])
    await harness.manager.sendMessage(harness.managed.id, 'What is the capital of France?')
    const prompt = harness.providerMessages[0]!
    expect(prompt).not.toContain('<host_objective_contract')
    expect(prompt).not.toContain('set_completion_criteria')
    expect(prompt).not.toContain('robb_objective_outcome')
  })
})
