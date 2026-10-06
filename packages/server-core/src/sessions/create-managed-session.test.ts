import { describe, expect, it } from 'bun:test'
import {
  createManagedSession,
  refreshInheritedSessionSourceSelection,
  resolveExplicitSpawnedSessionRoute,
  resolveBranchedSessionSourceSelection,
  resolveCreateSessionRouteProvenance,
  resolveEffectiveSessionSourceSelection,
  sanitizeParentSessionLabels,
  resolveSpawnedSessionRoute,
  sessionSourceSlugsForPersistence,
} from './SessionManager.ts'

describe('workspace source selection provenance', () => {
  it('materializes omitted sources as an inherited workspace selection', () => {
    expect(resolveEffectiveSessionSourceSelection(undefined, ['workspace-mcp'])).toEqual({
      enabledSourceSlugs: ['workspace-mcp'],
      inheritsWorkspaceSourceSlugs: true,
    })
  })

  it('keeps an explicit empty source selection distinct from inheritance', () => {
    expect(resolveEffectiveSessionSourceSelection([], ['workspace-mcp'])).toEqual({
      enabledSourceSlugs: [],
      inheritsWorkspaceSourceSlugs: false,
    })
  })

  it('refreshes only inherited selections when workspace defaults change', () => {
    const inherited = resolveEffectiveSessionSourceSelection(undefined, ['old'])
    expect(refreshInheritedSessionSourceSelection(inherited, ['new'])).toBe(true)
    expect(inherited.enabledSourceSlugs).toEqual(['new'])
    expect(refreshInheritedSessionSourceSelection(inherited, ['new'])).toBe(false)

    const explicit = resolveEffectiveSessionSourceSelection(['old'], ['workspace'])
    expect(refreshInheritedSessionSourceSelection(explicit, ['new'])).toBe(false)
    expect(explicit.enabledSourceSlugs).toEqual(['old'])
  })

  it('keeps inherited values out of storage while persisting explicit empty selections', () => {
    expect(sessionSourceSlugsForPersistence(
      resolveEffectiveSessionSourceSelection(undefined, ['workspace-mcp']),
    )).toBeUndefined()
    expect(sessionSourceSlugsForPersistence(
      resolveEffectiveSessionSourceSelection([], ['workspace-mcp']),
    )).toEqual([])
  })

  it('preserves parent source provenance when branching', () => {
    expect(resolveBranchedSessionSourceSelection({
      enabledSourceSlugs: ['old-default'],
      inheritsWorkspaceSourceSlugs: true,
    }, ['new-default'])).toEqual({
      enabledSourceSlugs: ['new-default'],
      inheritsWorkspaceSourceSlugs: true,
    })
    expect(resolveBranchedSessionSourceSelection({
      enabledSourceSlugs: [],
      inheritsWorkspaceSourceSlugs: false,
    }, ['new-default'])).toEqual({
      enabledSourceSlugs: [],
      inheritsWorkspaceSourceSlugs: false,
      persistedSourceSlugs: [],
    })
  })
})

describe('resolveCreateSessionRouteProvenance', () => {
  it('materializes and pins the effective connection for a model-only manual selection', () => {
    expect(resolveCreateSessionRouteProvenance({
      model: 'pi/gpt-5.6-terra',
    }, 'workspace-default')).toEqual({
      modelRoutePinned: true,
      llmConnection: 'workspace-default',
      connectionRoutePinned: true,
    })
  })

  it('fails closed when a pinned model has no effective workspace or global connection', () => {
    expect(() => resolveCreateSessionRouteProvenance({
      model: 'pi/gpt-5.6-terra',
    }, undefined)).toThrow('without a configured LLM connection')
  })

  it('does not turn an explicitly automatic model snapshot into a connection pin', () => {
    expect(resolveCreateSessionRouteProvenance({
      model: 'pi/gpt-5.6-terra',
      modelRoutePinned: false,
      connectionRoutePinned: false,
    }, 'workspace-default')).toEqual({
      modelRoutePinned: false,
      llmConnection: undefined,
      connectionRoutePinned: false,
    })
  })

  it('always pins the provider scope of a pinned model even when a legacy caller says otherwise', () => {
    expect(resolveCreateSessionRouteProvenance({
      model: 'pi/gpt-5.6-terra',
      modelRoutePinned: true,
      llmConnection: 'openai',
      connectionRoutePinned: false,
    }, 'openai')).toEqual({
      modelRoutePinned: true,
      llmConnection: 'openai',
      connectionRoutePinned: true,
    })
  })
})

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

  it('preserves durable manual model-pin provenance', () => {
    const managed = createManagedSession({
      id: 'session_pinned',
      model: 'pi/gpt-5.6-sol',
      modelRoutePinned: true,
    }, workspace as any)

    expect(managed.model).toBe('pi/gpt-5.6-sol')
    expect(managed.modelRoutePinned).toBe(true)
  })

  it('migrates a legacy concrete model without pin provenance as manual', () => {
    const managed = createManagedSession({
      id: 'session_legacy_model',
      model: 'pi/gpt-5.6-sol',
    }, workspace as never)

    expect(managed.model).toBe('pi/gpt-5.6-sol')
    expect(managed.modelRoutePinned).toBe(true)
  })

  it('preserves an explicitly automatic model snapshot', () => {
    const managed = createManagedSession({
      id: 'session_automatic_model',
      model: 'pi/gpt-5.6-terra',
      modelRoutePinned: false,
    }, workspace as never)

    expect(managed.modelRoutePinned).toBe(false)
  })

  it('preserves durable manual connection-pin provenance', () => {
    const managed = createManagedSession({
      id: 'session_connection_pinned',
      llmConnection: 'manual-connection',
      connectionRoutePinned: true,
    }, workspace as any)

    expect(managed.llmConnection).toBe('manual-connection')
    expect(managed.connectionRoutePinned).toBe(true)
  })

  it('preserves durable reasoning-only pin provenance', () => {
    const managed = createManagedSession({
      id: 'session_thinking_pinned',
      thinkingLevel: 'xhigh',
      thinkingLevelPinned: true,
    }, workspace as any)

    expect(managed.thinkingLevel).toBe('xhigh')
    expect(managed.thinkingLevelPinned).toBe(true)
  })

  it('sanitizes self, reverse and cyclic parent-session labels from structural lineage', () => {
    const root = createManagedSession({
      id: 'root',
      parentSessionId: 'root',
      labels: ['project::zero', 'parent-session::root', 'parent-session::child'],
    }, workspace as never)
    expect(root.parentSessionId).toBeUndefined()
    expect(root.labels).toEqual(['project::zero'])

    const child = createManagedSession({
      id: 'child',
      parentSessionId: 'root',
      labels: ['project::zero', 'parent-session::child', 'parent-session::grandchild'],
    }, workspace as never)
    expect(child.parentSessionId).toBe('root')
    expect(child.labels).toEqual(['project::zero', 'parent-session::root'])

    expect(sanitizeParentSessionLabels('root', undefined, ['project::zero'])).toEqual(['project::zero'])
  })
})

describe('resolveSpawnedSessionRoute', () => {
  const parent = {
    llmConnection: 'parent-connection',
    model: 'pi/gpt-5.6-sol',
    thinkingLevel: 'xhigh' as const,
  }

  it('does not inherit an unpinned parent reasoning snapshot', () => {
    expect(resolveSpawnedSessionRoute({}, parent)).toEqual({
      llmConnection: 'parent-connection',
      model: 'pi/gpt-5.6-sol',
      thinkingLevel: undefined,
    })
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
      thinkingLevel: undefined,
    })
  })

  it('does not carry a parent model into an explicitly different connection', () => {
    expect(resolveSpawnedSessionRoute({
      llmConnection: 'anthropic-specialist',
    }, parent)).toEqual({
      llmConnection: 'anthropic-specialist',
      model: undefined,
      thinkingLevel: undefined,
    })
  })

  it('inherits reasoning only from an authenticated reasoning pin', () => {
    expect(resolveSpawnedSessionRoute({}, {
      ...parent,
      modelRoutePinned: true,
      thinkingLevelPinned: true,
    })).toEqual({
      llmConnection: 'parent-connection',
      model: 'pi/gpt-5.6-sol',
      thinkingLevel: 'xhigh',
    })
  })
})

describe('resolveExplicitSpawnedSessionRoute', () => {
  const parent = { llmConnection: 'selected-connection', model: 'pi/gpt-6.1-sol', thinkingLevel: 'high' as const };
  it.each(['List files.', 'Review an implementation.', 'Implement a multi-package migration.'])('inherits the selected model and reasoning for %s', prompt => {
    expect(resolveExplicitSpawnedSessionRoute({}, parent, { prompt, role: 'worker' })).toEqual({
      ...parent, connectionRoutePinned: true, modelRoutePinned: true, thinkingLevelPinned: true,
    });
  });
  it('rejects model-authored provider, model and reasoning overrides', () => {
    expect(resolveExplicitSpawnedSessionRoute({ llmConnection: 'other', model: 'pi/gpt-5.6-luna', thinkingLevel: 'off' }, parent)).toEqual({
      ...parent, connectionRoutePinned: true, modelRoutePinned: true, thinkingLevelPinned: true,
    });
  });
  it('preserves absent reasoning rather than inventing a classification', () => {
    const selection = resolveExplicitSpawnedSessionRoute({}, { ...parent, thinkingLevel: undefined });
    expect(selection.thinkingLevel).toBeUndefined();
    expect(selection.thinkingLevelPinned).toBe(false);
  });
});
