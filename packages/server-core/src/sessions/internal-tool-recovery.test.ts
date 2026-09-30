import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@craft-agent/core/types'
import { SESSION_TOOL_NAMES } from '@craft-agent/session-tools-core'
import { decideAutonomyRecovery, isBrowserToolNameOrAlias } from '@craft-agent/shared/agent'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import { createPendingTurnRecovery } from './turn-recovery.ts'

const roots: string[] = []
const managers: SessionManager[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// Exact error prefixes observed in the campaign; no user data or tool arguments.
const registrationErrors = [
  'Validation failed for tool "mcp__session__set_completion_criteria": criteria.2.checks.2.equals: must be either string or number or boolean or null',
  '[ERROR] The host rejected these criteria: Unknown requirementId for the selected business procedure.',
  '[ERROR] The host rejected these criteria: Invalid or duplicate criterion id.',
]

describe('internal tool failure recovery boundaries', () => {
  it('covers every canonical local session tool without matching an external namespace by action suffix', () => {
    for (const toolName of SESSION_TOOL_NAMES) {
      if (isBrowserToolNameOrAlias(toolName)) continue
      expect(decideAutonomyRecovery({ toolName, result: 'Unknown tool failure', browserEnabled: true,
        fallbackAlreadyAttempted: false, browserFallbackEligible: true })).toEqual({ kind: 'none' })
    }
  })
  it.each(['set_completion_criteria', 'session__set_completion_criteria', 'mcp__session__set_completion_criteria',
    'mcp__session__wait_sessions', 'mcp__session__request_user_input', 'mcp__session__source_credential_prompt'])
  ('keeps %s errors at the original tool boundary', toolName => {
    for (const result of [...registrationErrors, 'Execution bridge unavailable', 'OAuth token expired; MFA required']) {
      for (const browserEnabled of [true, false]) {
        expect(decideAutonomyRecovery({ toolName, result, browserEnabled,
          fallbackAlreadyAttempted: false, browserFallbackEligible: true })).toEqual({ kind: 'none' })
      }
    }
  })

  it('retains external connector authentication, equivalent browser fallback and ambiguous-effect safeguards', () => {
    const request = { toolName: 'mcp__crm__set_completion_criteria', result: 'HTTP 503 service unavailable',
      browserEnabled: true, fallbackAlreadyAttempted: false, browserFallbackEligible: true }
    expect(decideAutonomyRecovery(request)).toEqual({ kind: 'fallback_browser' })
    expect(decideAutonomyRecovery({ ...request, result: 'OAuth token expired; MFA required' }))
      .toEqual({ kind: 'escalate', reason: 'oauth_or_mfa' })
    expect(decideAutonomyRecovery({ ...request, fallbackAlreadyAttempted: true })).toEqual({ kind: 'none' })
    expect(decideAutonomyRecovery({ ...request, toolName: 'mcp__session__browser_tool' }))
      .toEqual({ kind: 'fallback_structured' })
  })

  it('does not let automatic model selection authorize a browser or structured channel fallback', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'model-auto-channel-boundary-'))
    roots.push(rootPath)
    writeFileSync(join(rootPath, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'workspace-fixture',
      name: 'Fixture',
      slug: 'workspace-fixture',
      createdAt: 1,
      updatedAt: 1,
      automaticRoutingEnabled: true,
    }))
    const manager = new SessionManager()
    managers.push(manager)
    const managed = createManagedSession({ id: 'model-auto-only' }, {
      id: 'workspace-fixture', slug: 'workspace-fixture', name: 'Fixture', rootPath, createdAt: 1,
    }, { messagesLoaded: true })
    const redirected: string[] = []
    managed.agent = {
      redirect: (prompt: string) => { redirected.push(prompt); return true },
      dispose: () => {},
    } as never
    managed.messages = [{ id: 'root-user', role: 'user', content: 'Inspect the CRM record.', timestamp: 1 }]
    managed.activeObjective = {
      schemaVersion: 1, objectiveId: 'root-user', userMessageId: 'root-user',
      lastUserMessageId: 'root-user', startedAt: 1, budgetBaselineUsd: 0, tokenBaseline: 0,
      continuationCount: 0, orchestrationMode: 'direct', risk: 'standard', terminalState: 'active',
      completionCriteria: ['requested-outcome-delivered'],
    }
    managed.pendingTurnRecovery = createPendingTurnRecovery('root-user', 1)
    const runtime = manager as unknown as {
      sessions: Map<string, typeof managed>
      enqueuePersist: () => void
      sendEvent: () => void
      emitExecutionTelemetry: () => void
      processEvent: (session: typeof managed, event: AgentEvent, generation: number) => Promise<void>
    }
    runtime.sessions.set(managed.id, managed)
    runtime.enqueuePersist = () => {}
    runtime.sendEvent = () => {}
    runtime.emitExecutionTelemetry = () => {}

    await runtime.processEvent(managed, {
      type: 'tool_start', toolName: 'mcp__crm__lookup', toolUseId: 'crm-read', input: {},
    }, managed.processingGeneration)
    await runtime.processEvent(managed, {
      type: 'tool_result', toolName: 'mcp__crm__lookup', toolUseId: 'crm-read',
      result: 'HTTP 503 service unavailable', isError: true, executed: true,
    }, managed.processingGeneration)

    expect(redirected).toEqual([])
    expect(managed.messageQueue).toEqual([])
    expect(managed.autonomyFallbackAttemptedTools).toBeUndefined()
  })

  it.each([true, false])('preserves three actual tool-result errors when redirect is %s, without machine recovery or budget changes', async redirectAvailable => {
    const rootPath = mkdtempSync(join(tmpdir(), 'internal-tool-recovery-'))
    roots.push(rootPath)
    writeFileSync(join(rootPath, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'workspace-fixture',
      name: 'Fixture',
      slug: 'workspace-fixture',
      createdAt: 1,
      updatedAt: 1,
      automaticToolFallbackEnabled: true,
    }))
    const manager = new SessionManager()
    managers.push(manager)
    const managed = createManagedSession({ id: 'campaign-fixture', name: 'Internal tool recovery fixture' },
      { id: 'workspace-fixture', slug: 'workspace-fixture', name: 'Fixture', rootPath, createdAt: 1 },
      { messagesLoaded: true })
    const redirected: string[] = []
    managed.agent = { redirect: (prompt: string) => { redirected.push(prompt); return redirectAvailable }, dispose: () => {} } as never
    managed.messages = [{ id: 'root-user', role: 'user', content: 'Prepare the fixture package.', timestamp: 1 }]
    managed.activeObjective = { schemaVersion: 1, objectiveId: 'root-user', userMessageId: 'root-user',
      lastUserMessageId: 'root-user', startedAt: 1, budgetBaselineUsd: 7, tokenBaseline: 100,
      continuationCount: 2, orchestrationMode: 'mission', risk: 'standard', terminalState: 'active',
      requiresAcceptanceCriteria: true, completionCriteria: ['requested-outcome-delivered'] }
    managed.pendingTurnRecovery = { ...createPendingTurnRecovery('root-user', 1), attempts: 3,
      stagnantAttempts: 1, lastAttemptAt: 2, leaseExpiresAt: 12345 }
    const before = JSON.stringify({ objective: managed.activeObjective, recovery: managed.pendingTurnRecovery })
    const runtime = manager as unknown as { sessions: Map<string, typeof managed>;
      enqueuePersist: () => void; sendEvent: () => void; emitExecutionTelemetry: () => void;
      processEvent: (session: typeof managed, event: AgentEvent, generation: number) => Promise<void> }
    runtime.sessions.set(managed.id, managed)
    runtime.enqueuePersist = () => {}
    runtime.sendEvent = () => {}
    runtime.emitExecutionTelemetry = () => {}
    for (const [index, result] of registrationErrors.entries()) {
      const toolUseId = `registration-${index}`
      await runtime.processEvent(managed, { type: 'tool_start', toolName: 'mcp__session__set_completion_criteria',
        toolUseId, input: { criteria: [] } }, managed.processingGeneration)
      await runtime.processEvent(managed, { type: 'tool_result', toolName: 'mcp__session__set_completion_criteria',
        toolUseId, result, isError: true, executed: true }, managed.processingGeneration)
    }
    expect(managed.messages.filter(message => message.role === 'tool').map(message => ({
      result: message.toolResult, status: message.toolStatus, executed: message.toolExecuted,
    }))).toEqual(registrationErrors.map(result => ({ result, status: 'error', executed: true })))
    expect(redirected).toEqual([])
    expect(managed.messageQueue).toEqual([])
    expect(managed.autonomyEvents?.some(event => event.phase === 'fallback' || event.phase === 'escalated')).toBe(false)
    expect(JSON.stringify({ objective: managed.activeObjective, recovery: managed.pendingTurnRecovery })).toBe(before)
  })
})
