import { authenticatedTaskFor as policyAuthenticatedTaskFor } from "./SessionManager/policy.ts";
import { describe, expect, it } from 'bun:test'
import { createManagedSession } from './SessionManager'
import type { Message } from '@craft-agent/core/types'
type InternalMessageOrigin = NonNullable<Message['internalOrigin']>

type RoutingTask = {
  authenticatedTaskText?: string
}

type RoutingPlannerState = Pick<ReturnType<typeof createManagedSession>, 'missionRole' | 'parentSessionId'> & {
  workspace: { rootPath: string }
}
const resolvePlannerRoutingTask = (
  managed: RoutingPlannerState,
  internalOrigin: InternalMessageOrigin,
): RoutingTask => {
  const session = createManagedSession({ id: 'planner-routing-fixture' }, {
    id: 'routing-workspace', name: 'Routing fixture', slug: 'routing-fixture',
    rootPath: managed.workspace.rootPath, createdAt: 1,
  }, { messagesLoaded: true })
  session.parentSessionId = managed.parentSessionId
  session.missionRole = managed.missionRole
  return policyAuthenticatedTaskFor(session, {
    content: '<mission-plan-request>host contract mentioning permissions and workspace writes</mission-plan-request>',
    internalOrigin,
  })
}

describe('Mission planner routing provenance', () => {
  const managed: RoutingPlannerState = {
    missionRole: 'planner',
    parentSessionId: 'origin-session',
    workspace: { rootPath: '/tmp/unused-planner-routing-test' },
  }

  it('uses the host-bound mission goal without opening an objective contract', () => {
    expect(resolvePlannerRoutingTask(managed, {
      kind: 'spawned-session',
      senderSessionId: 'origin-session',
      authenticatedTaskText: 'Corrige une coquille dans le README.',
    })).toEqual({ authenticatedTaskText: 'Corrige une coquille dans le README.' })
    expect(managed).not.toHaveProperty('activeObjective')
  })

  it.each([
    ['wrong sender', { kind: 'spawned-session', senderSessionId: 'other-session' }],
    ['wrong origin kind', { kind: 'agent-message', senderSessionId: 'origin-session' }],
  ] as const)('rejects planner task text with %s', (_label, origin) => {
    expect(resolvePlannerRoutingTask(managed, {
      ...origin,
      authenticatedTaskText: 'Merci.',
    }).authenticatedTaskText).toBeUndefined()
  })

  it('does not grant the planner routing seam to an ordinary child role', () => {
    expect(resolvePlannerRoutingTask({ ...managed, missionRole: 'worker' }, {
      kind: 'spawned-session',
      senderSessionId: 'origin-session',
      authenticatedTaskText: 'Merci.',
    }).authenticatedTaskText).toBeUndefined()
  })
})
