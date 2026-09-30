import { describe, expect, it } from 'bun:test'
import { SessionManager } from './SessionManager'

type RoutingTask = {
  authenticatedTaskText?: string
}

type RoutingTaskResolver = {
  authenticatedTaskFor(
    managed: Record<string, unknown>,
    message: Record<string, unknown>,
  ): RoutingTask
}

const resolvePlannerRoutingTask = (
  managed: Record<string, unknown>,
  internalOrigin: Record<string, unknown>,
): RoutingTask => {
  const resolver = SessionManager.prototype as unknown as RoutingTaskResolver
  return resolver.authenticatedTaskFor.call({}, managed, {
    content: '<mission-plan-request>host contract mentioning permissions and workspace writes</mission-plan-request>',
    internalOrigin,
  })
}

describe('Mission planner routing provenance', () => {
  const managed = {
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
  ])('rejects planner task text with %s', (_label, origin) => {
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
