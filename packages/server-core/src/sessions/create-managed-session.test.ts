import { describe, expect, it } from 'bun:test'
import { createManagedSession, resolveSpawnedSessionRoute } from './SessionManager.ts'

describe('createManagedSession', () => {
  const workspace = {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: '/tmp/test-workspace',
    createdAt: Date.now(),
  }

  it('normalizes legacy thinkingLevel=think on restore', () => {
    const managed = createManagedSession({
      id: 'session_legacy',
      thinkingLevel: 'think' as any,
    }, workspace as any)

    expect(managed.thinkingLevel).toBe('medium')
  })

  it('drops invalid thinking levels instead of leaking them into runtime state', () => {
    const managed = createManagedSession({
      id: 'session_invalid',
      thinkingLevel: 'ultra' as any,
    }, workspace as any)

    expect(managed.thinkingLevel).toBeUndefined()
  })
})

describe('resolveSpawnedSessionRoute', () => {
  const parent = {
    llmConnection: 'parent-connection',
    model: 'pi/gpt-5.6-sol',
    thinkingLevel: 'xhigh' as const,
  }

  it('inherits the exact effective parent route when no override is requested', () => {
    expect(resolveSpawnedSessionRoute({}, parent)).toEqual(parent)
  })

  it('honors every explicit specialist override', () => {
    expect(resolveSpawnedSessionRoute({
      llmConnection: 'specialist-connection',
      model: 'pi/gpt-5.6-terra',
      thinkingLevel: 'off',
    }, parent)).toEqual({
      llmConnection: 'specialist-connection',
      model: 'pi/gpt-5.6-terra',
      thinkingLevel: 'off',
    })
  })

  it('inherits only fields omitted by a partial override', () => {
    expect(resolveSpawnedSessionRoute({ model: 'pi/gpt-5.6-luna' }, parent)).toEqual({
      llmConnection: 'parent-connection',
      model: 'pi/gpt-5.6-luna',
      thinkingLevel: 'xhigh',
    })
  })

  it('does not carry a parent model into an explicitly different connection', () => {
    expect(resolveSpawnedSessionRoute({
      llmConnection: 'anthropic-specialist',
    }, parent)).toEqual({
      llmConnection: 'anthropic-specialist',
      model: undefined,
      thinkingLevel: 'xhigh',
    })
  })
})
