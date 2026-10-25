import { beforeEach, describe, expect, it } from 'bun:test'
import { BrowserPaneManager, createBrowserPaneTestManager, getTestBrowserInstance, invalidKeyInput } from './fixtures/browser-pane-fixture'

describe('BrowserPaneManager', () => {
let manager: ReturnType<typeof createBrowserPaneTestManager>
beforeEach(() => { manager = createBrowserPaneTestManager() })
describe('explicit remote keyboard text', () => {
    it('uses one bounded CDP text operation and revokes it if the browser is rebound', async () => {
      const manager = new BrowserPaneManager()
      manager.createInstance('keyboard-fixture')
      const instance = getTestBrowserInstance(manager, 'keyboard-fixture')
      let calls = 0
      instance.cdp.typeKeys = async (text: string, isCurrent: () => boolean) => {
        calls++
        expect(text).toBe('é € []')
        expect(isCurrent()).toBe(true)
        instance.boundSessionId = 'another-session'
        expect(isCurrent()).toBe(false)
      }
      await manager.sendKey('keyboard-fixture', { key: 'Unidentified', text: 'é € []' })
      expect(calls).toBe(1)
      await manager.destroyAll()
    })

    it('applies host clipboard policy before page JavaScript can return a forged success', async () => {
      const manager = new BrowserPaneManager()
      manager.createInstance('clipboard-policy-fixture')
      const instance = getTestBrowserInstance(manager, 'clipboard-policy-fixture')
      let pageCalls = 0
      instance.cdp.setClipboard = async () => { pageCalls++ }
      instance.cdp.getClipboard = async () => { pageCalls++; return 'old system contents' }
      await expect(manager.setClipboard('clipboard-policy-fixture', 'text')).rejects.toThrow('denied by browser policy')
      await expect(manager.getClipboard('clipboard-policy-fixture')).rejects.toThrow('unknown, not empty')
      expect(pageCalls).toBe(0)
      await manager.destroyAll()
    })

    it('rejects shortcut modifiers before delivering keyboard text', async () => {
      const manager = new BrowserPaneManager()
      manager.createInstance('keyboard-modifiers')
      const instance = getTestBrowserInstance(manager, 'keyboard-modifiers')
      instance.cdp.typeKeys = async () => { throw new Error('must not deliver') }
      await expect(manager.sendKey('keyboard-modifiers', { key: 'Unidentified', text: 'v', modifiers: ['meta'] })).rejects.toThrow('shortcut modifiers')
      for (const modifiers of [{}, 0, true, '']) {
        await expect(manager.sendKey('keyboard-modifiers', invalidKeyInput({ key: 'Unidentified', text: 'v', modifiers }))).rejects.toThrow('shortcut modifiers')
      }
      await manager.destroyAll()
    })
  })

describe('workspaceId stamping', () => {
    it('createForSession with workspaceId stamps the field on a new instance', () => {
      const id = manager.createForSession('sess-ws', { workspaceId: 'ws-alpha' })
      const info = manager.listInstances().find((i) => i.id === id)
      expect(info?.workspaceId).toBe('ws-alpha')
    })

    it('createForSession without workspaceId defaults to null', () => {
      const id = manager.createForSession('sess-plain')
      const info = manager.listInstances().find((i) => i.id === id)
      expect(info?.workspaceId).toBeNull()
    })

    it('manual createInstance with no options leaves workspaceId null (unbound window)', () => {
      manager.createInstance('manual-ws')
      const info = manager.listInstances().find((i) => i.id === 'manual-ws')
      expect(info?.workspaceId).toBeNull()
    })

    it('manual createInstance accepts workspaceId option (TopBar manual open)', () => {
      // The browser-pane CREATE handler passes ctx.workspaceId so TopBar-
      // opened windows stay scoped to the workspace the user clicked from,
      // rather than being broadcast to every workspace.
      manager.createInstance('manual-scoped', { workspaceId: 'ws-toolbar' })
      const info = manager.listInstances().find((i) => i.id === 'manual-scoped')
      expect(info?.workspaceId).toBe('ws-toolbar')
    })

    it('reusing an unbound manual window adopts the new binder workspace', () => {
      manager.createInstance('manual-reuse')
      expect(manager.listInstances().find((i) => i.id === 'manual-reuse')?.workspaceId).toBeNull()

      const id = manager.createForSession('sess-reuse-ws', { workspaceId: 'ws-beta' })
      expect(id).toBe('manual-reuse')

      const info = manager.listInstances().find((i) => i.id === 'manual-reuse')
      expect(info?.workspaceId).toBe('ws-beta')
      expect(info?.ownerSessionId).toBe('sess-reuse-ws')
    })

    it('bindSession with workspaceId overwrites the instance workspaceId', () => {
      manager.createInstance('bind-ws')
      manager.bindSession('bind-ws', 'sess-bound', { workspaceId: 'ws-gamma' })
      const info = manager.listInstances().find((i) => i.id === 'bind-ws')
      expect(info?.workspaceId).toBe('ws-gamma')
      expect(info?.boundSessionId).toBe('sess-bound')
    })

    it('setAgentControl backfills workspaceId when previously null', () => {
      // Legacy path: instance was created without a workspace, then the overlay
      // path supplies it. Backfill should stamp it.
      manager.createInstance('legacy-overlay')
      manager.bindSession('legacy-overlay', 'sess-legacy')
      manager.setAgentControl('sess-legacy', { displayName: 'browser_navigate' }, { workspaceId: 'ws-delta' })

      const info = manager.listInstances().find((i) => i.id === 'legacy-overlay')
      expect(info?.workspaceId).toBe('ws-delta')
    })

    it('toInfo emits workspaceId on the DTO', () => {
      manager.createForSession('sess-dto', { workspaceId: 'ws-epsilon' })
      const dto = manager.listInstances().find((i) => i.ownerSessionId === 'sess-dto')
      expect(dto).toBeDefined()
      expect(dto).toHaveProperty('workspaceId', 'ws-epsilon')
    })

    describe('cross-workspace reuse', () => {
      it('does NOT reuse an unbound session window from another workspace', () => {
        // Session in workspace A opens a window, then its turn ends — the
        // unbind path sets ownerType='manual' and clears boundSessionId, but
        // workspaceId stays = A. A session in workspace B asking for a window
        // must NOT pick it up; that would "move" the window across workspaces.
        const wsA = manager.createForSession('sess-a', { workspaceId: 'ws-a' })
        manager.unbindAllForSession('sess-a')

        // Sanity: instance is now unbound + manual but retains workspaceId=A.
        const after = manager.listInstances().find((i) => i.id === wsA)
        expect(after?.boundSessionId).toBeNull()
        expect(after?.ownerType).toBe('manual')
        expect(after?.workspaceId).toBe('ws-a')

        const wsB = manager.createForSession('sess-b', { workspaceId: 'ws-b' })
        expect(wsB).not.toBe(wsA)
        expect(manager.listInstances()).toHaveLength(2)

        // Workspace-A's window still belongs to A.
        const stillA = manager.listInstances().find((i) => i.id === wsA)
        expect(stillA?.workspaceId).toBe('ws-a')
      })

      it('DOES reuse an unbound window within the same workspace (next-turn case)', () => {
        // The legitimate same-workspace reuse: session-A ends a turn, leaves
        // an unbound window behind; the same workspace's session-A (or any
        // session in workspace A) should grab it on the next turn.
        const original = manager.createForSession('sess-a1', { workspaceId: 'ws-a' })
        manager.unbindAllForSession('sess-a1')

        const reused = manager.createForSession('sess-a2', { workspaceId: 'ws-a' })
        expect(reused).toBe(original)
        expect(manager.listInstances()).toHaveLength(1)
      })

      it('lets any workspace adopt a truly unbound (workspaceId=null) manual window', () => {
        manager.createInstance('manual-anyworkspace')
        expect(manager.listInstances().find((i) => i.id === 'manual-anyworkspace')?.workspaceId).toBeNull()

        const adopted = manager.createForSession('sess-c', { workspaceId: 'ws-c' })
        expect(adopted).toBe('manual-anyworkspace')
        expect(manager.listInstances().find((i) => i.id === 'manual-anyworkspace')?.workspaceId).toBe('ws-c')
      })

      it('does NOT reuse a workspaceId=null unbound window when allowReuseManual=false', () => {
        // Remote-bridge dispatcher path: every lifecycle call passes
        // allowReuseManual=false so a stale window from before workspace
        // stamping (workspaceId=null) cannot get hijacked by a remote agent
        // for an unrelated workspace.
        manager.createInstance('legacy-unstamped')
        expect(manager.listInstances().find((i) => i.id === 'legacy-unstamped')?.workspaceId).toBeNull()

        const fresh = manager.createForSession('sess-d', {
          workspaceId: 'ws-d',
          allowReuseManual: false,
        })
        expect(fresh).not.toBe('legacy-unstamped')
        // Legacy window is left untouched.
        expect(manager.listInstances().find((i) => i.id === 'legacy-unstamped')?.workspaceId).toBeNull()
        // A new instance was created for the remote session.
        expect(manager.listInstances().find((i) => i.id === fresh)?.ownerSessionId).toBe('sess-d')
      })
    })
  })
})
