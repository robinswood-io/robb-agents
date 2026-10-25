import { ScriptedSessionAgent } from './testing/scripted-session-agent.ts';
import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { describe, expect, it } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager'
import { cleanupModeState, getPermissionModeDiagnostics, initializeModeState } from '@craft-agent/shared/agent'

const workspace = { id: 'isolated-workspace', slug: 'isolated', name: 'Fixture', rootPath: '/tmp/permission-alias', createdAt: 1 };

describe('SessionManager permission mode boundary', () => {
  it('rejects an unknown mode before changing managed state, notifying the backend, or persisting', () => {
    const id = 'permission-api-invalid'
    const calls: unknown[] = []
    const managed = createManagedSession({ id, permissionMode: 'safe' }, workspace, { agent: Object.assign(new ScriptedSessionAgent(workspace), {
      setPermissionMode: (mode: string) => { calls.push(['backend', mode]); },
    }) })
    const host = Object.create(SessionManager.prototype)
  Object.defineProperty(host, 'runtimeState', { value: host, configurable: true });
    sessionRuntimeStateForTest(host).sessions = new Map([[id, managed]])
    sessionRuntimeStateForTest(host).shuttingDown = false
    sessionRuntimeStateForTest(host).retiringSessions = new WeakSet()
    host.sendEvent = (...args: unknown[]) => calls.push(['event', ...args])
    host.persistSession = () => calls.push(['persist'])
    initializeModeState(id, 'safe')
    try {
      const before = getPermissionModeDiagnostics(id)
      expect(() => host.setSessionPermissionMode(id, 'unrecognized')).toThrow('Invalid permissionMode')
      expect(managed.permissionMode).toBe('safe')
      expect(getPermissionModeDiagnostics(id)).toEqual(before)
      expect(calls).toEqual([])
    } finally {
      cleanupModeState(id)
    }
  })

  it.each([['explore', 'safe'], ['execute', 'allow-all']] as const)('normalizes %s consistently in runtime, backend, event, and persistence', (input, expected) => {
    const id = `permission-api-${input}`
    const backendModes: string[] = []
    const persistedModes: string[] = []
    const events: Array<{ permissionMode: string }> = []
    const managed = createManagedSession({ id, permissionMode: 'ask' }, workspace, { agent: Object.assign(new ScriptedSessionAgent(workspace), {
      setPermissionMode: (mode: string) => { backendModes.push(mode); },
    }) })
    const host = Object.create(SessionManager.prototype)
  Object.defineProperty(host, 'runtimeState', { value: host, configurable: true });
    sessionRuntimeStateForTest(host).sessions = new Map([[id, managed]])
    sessionRuntimeStateForTest(host).shuttingDown = false
    sessionRuntimeStateForTest(host).retiringSessions = new WeakSet()
    host.sendEvent = (event: { permissionMode: string }) => events.push(event)
    host.persistSession = () => persistedModes.push(managed.permissionMode ?? 'ask')
    initializeModeState(id, 'ask')
    try {
      host.setSessionPermissionMode(id, input)
      expect(managed.permissionMode).toBe(expected)
      expect(getPermissionModeDiagnostics(id).permissionMode).toBe(expected)
      expect(backendModes).toEqual([expected])
      expect(persistedModes).toEqual([expected])
      expect(events).toHaveLength(1)
      expect(events[0]?.permissionMode).toBe(expected)
    } finally {
      cleanupModeState(id)
    }
  })
})
