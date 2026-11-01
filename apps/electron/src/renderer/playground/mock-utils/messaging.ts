import type { MessagingPlatformRuntimeInfo, WhatsAppUiEvent } from "../../../shared/types";
import type { MessagingBinding } from "../../atoms/messaging";
import type { BindingAccess, PendingSender, PlatformAccessMode, PlatformOwner } from "../../components/messaging/access/types";


// ============================================================================
// Messaging mock state + control handle
// ============================================================================
//
// The real messaging flow is driven by IPC push events (platform status,
// binding changes, WhatsApp pairing phases). To make the messaging UI
// previewable, we replace those IPC calls with an in-memory event bus and
// expose a `window.__playgroundMessaging` handle so variant/preview wrappers
// can flip state (connected ↔ disconnected, WhatsApp phase, bindings) without
// remounting the component.

export type PlatformStatusListener = (
  workspaceId: string,
  platform: string,
  status: MessagingPlatformRuntimeInfo,
) => void

export type BindingListener = (workspaceId: string) => void

export type WhatsAppEventListener = (payload: { workspaceId: string; event: WhatsAppUiEvent }) => void


export const PLAYGROUND_WORKSPACE_ID = 'playground-workspace'


export type AllowListPlatform = 'telegram' | 'whatsapp' | 'lark'


export interface AllowListState {
  accessMode: PlatformAccessMode
  owners: PlatformOwner[]
  pending: PendingSender[]
  /** Per-binding access. Keyed by bindingId. */
  bindings: Record<string, BindingAccess>
}


export interface MessagingMockState {
  runtime: {
    telegram: MessagingPlatformRuntimeInfo
    whatsapp: MessagingPlatformRuntimeInfo
  }
  bindings: MessagingBinding[]
  /** Workspace-level allow-list state per platform (Phase 1 mock surface). */
  allowList: Record<AllowListPlatform, AllowListState>
  platformStatusListeners: Set<PlatformStatusListener>
  bindingListeners: Set<BindingListener>
  waEventListeners: Set<WhatsAppEventListener>
}


export function defaultRuntime(platform: 'telegram' | 'whatsapp'): MessagingPlatformRuntimeInfo {
  return {
    platform,
    configured: false,
    connected: false,
    state: 'disconnected',
    updatedAt: Date.now(),
  }
}


export function defaultAllowList(): AllowListState {
  return { accessMode: 'open', owners: [], pending: [], bindings: {} }
}


export const messagingMockState: MessagingMockState = {
  runtime: {
    telegram: defaultRuntime('telegram'),
    whatsapp: defaultRuntime('whatsapp'),
  },
  bindings: [],
  allowList: {
    telegram: defaultAllowList(),
    whatsapp: defaultAllowList(),
    lark: defaultAllowList(),
  },
  platformStatusListeners: new Set(),
  bindingListeners: new Set(),
  waEventListeners: new Set(),
}


export function emitPlatformStatus(platform: 'telegram' | 'whatsapp') {
  const status = messagingMockState.runtime[platform]
  for (const listener of messagingMockState.platformStatusListeners) {
    try { listener(PLAYGROUND_WORKSPACE_ID, platform, status) } catch (err) { console.error(err) }
  }
}


export function emitBindingChanged() {
  for (const listener of messagingMockState.bindingListeners) {
    try { listener(PLAYGROUND_WORKSPACE_ID) } catch (err) { console.error(err) }
  }
}


export function emitWhatsAppEvent(event: WhatsAppUiEvent) {
  for (const listener of messagingMockState.waEventListeners) {
    try { listener({ workspaceId: PLAYGROUND_WORKSPACE_ID, event }) } catch (err) { console.error(err) }
  }
}


export interface PlaygroundMessagingHandle {
  /** Snapshot of current state (for debugging from DevTools). */
  state: MessagingMockState
  setTelegramConnected: (connected: boolean, identity?: string) => void
  setWhatsAppConnected: (connected: boolean, identity?: string) => void
  setBindings: (bindings: MessagingBinding[]) => void
  fireWAEvent: (event: WhatsAppUiEvent) => void
  reset: () => void
}


/**
 * Allow-list mock control. Lets AllowListPreview drive the workspace-level
 * owners / pending / per-binding-access mock state without going through the
 * IPC mocks. Phase 3 wiring will read the same state via electronAPI.
 */
export interface PlaygroundAllowListHandle {
  setAccessMode: (platform: AllowListPlatform, mode: PlatformAccessMode) => void
  setOwners: (platform: AllowListPlatform, owners: PlatformOwner[]) => void
  setPending: (platform: AllowListPlatform, pending: PendingSender[]) => void
  setBindingAccess: (
    platform: AllowListPlatform,
    bindingId: string,
    access: BindingAccess,
  ) => void
  reset: () => void
}


export const playgroundMessagingHandle: PlaygroundMessagingHandle = {
  state: messagingMockState,
  setTelegramConnected(connected, identity) {
    messagingMockState.runtime.telegram = {
      platform: 'telegram',
      configured: connected,
      connected,
      state: connected ? 'connected' : 'disconnected',
      ...(identity !== undefined ? { identity: identity } : {}),
      updatedAt: Date.now(),
    }
    emitPlatformStatus('telegram')
  },
  setWhatsAppConnected(connected, identity) {
    messagingMockState.runtime.whatsapp = {
      platform: 'whatsapp',
      configured: connected,
      connected,
      state: connected ? 'connected' : 'disconnected',
      ...(identity !== undefined ? { identity: identity } : {}),
      updatedAt: Date.now(),
    }
    emitPlatformStatus('whatsapp')
  },
  setBindings(bindings) {
    messagingMockState.bindings = bindings
    emitBindingChanged()
  },
  fireWAEvent(event) {
    emitWhatsAppEvent(event)
  },
  reset() {
    messagingMockState.runtime.telegram = defaultRuntime('telegram')
    messagingMockState.runtime.whatsapp = defaultRuntime('whatsapp')
    messagingMockState.bindings = []
    messagingMockState.allowList.telegram = defaultAllowList()
    messagingMockState.allowList.whatsapp = defaultAllowList()
    messagingMockState.allowList.lark = defaultAllowList()
    emitPlatformStatus('telegram')
    emitPlatformStatus('whatsapp')
    emitBindingChanged()
  },
}


export const playgroundAllowListHandle: PlaygroundAllowListHandle = {
  setAccessMode(platform, mode) {
    messagingMockState.allowList[platform].accessMode = mode
  },
  setOwners(platform, owners) {
    messagingMockState.allowList[platform].owners = owners
  },
  setPending(platform, pending) {
    messagingMockState.allowList[platform].pending = pending
  },
  setBindingAccess(platform, bindingId, access) {
    messagingMockState.allowList[platform].bindings[bindingId] = access
  },
  reset() {
    messagingMockState.allowList.telegram = defaultAllowList()
    messagingMockState.allowList.whatsapp = defaultAllowList()
    messagingMockState.allowList.lark = defaultAllowList()
  },
}
