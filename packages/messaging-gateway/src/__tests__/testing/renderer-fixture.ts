import { Renderer, type SessionEvent } from "../../renderer";
import { DEFAULT_BINDING_CONFIG, type AdapterCapabilities, type ChannelBinding, type PlatformAdapter, type SentMessage, type BindingConfig } from "../../types";



// ---------------------------------------------------------------------------
// Fake adapter
// ---------------------------------------------------------------------------

export interface Call {
  kind: 'sendText' | 'editMessage' | 'sendButtons' | 'sendTyping'
  channelId: string
  messageId?: string
  text?: string
}


export function makeAdapter(
  capabilities: Partial<AdapterCapabilities> = {},
  platform: PlatformAdapter['platform'] = 'telegram',
): PlatformAdapter & { calls: Call[] } {
  const calls: Call[] = []
  let nextId = 1

  const caps: AdapterCapabilities = {
    messageEditing: true,
    inlineButtons: true,
    maxButtons: 3,
    maxMessageLength: 4096,
    markdown: 'v2',
    webhookSupport: false,
    ...capabilities,
  }

  const adapter: PlatformAdapter & { calls: Call[] } = {
    platform,
    capabilities: caps,
    calls,
    async initialize() {},
    async destroy() {},
    isConnected() {
      return true
    },
    onMessage() {},
    onButtonPress() {},
    async sendText(channelId: string, text: string): Promise<SentMessage> {
      const messageId = String(nextId++)
      calls.push({ kind: 'sendText', channelId, text, messageId })
      return { platform: 'telegram', channelId, messageId }
    },
    async editMessage(channelId: string, messageId: string, text: string): Promise<void> {
      calls.push({ kind: 'editMessage', channelId, messageId, text })
    },
    async sendButtons(channelId: string, text: string): Promise<SentMessage> {
      const messageId = String(nextId++)
      calls.push({ kind: 'sendButtons', channelId, text, messageId })
      return { platform: 'telegram', channelId, messageId }
    },
    async sendTyping(channelId: string): Promise<void> {
      calls.push({ kind: 'sendTyping', channelId })
    },
    async sendFile(channelId: string): Promise<SentMessage> {
      const messageId = String(nextId++)
      return { platform: 'telegram', channelId, messageId }
    },
  }

  return adapter
}


// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

export function makeBinding(overrides: Partial<BindingConfig> = {}): ChannelBinding {
  return {
    id: 'bind-1',
    workspaceId: 'ws-1',
    sessionId: 'sess-1',
    platform: 'telegram',
    channelId: 'chan-1',
    enabled: true,
    createdAt: Date.now(),
    config: { ...DEFAULT_BINDING_CONFIG, ...overrides },
  }
}


export async function play(
  renderer: Renderer,
  binding: ChannelBinding,
  adapter: PlatformAdapter,
  events: SessionEvent[],
): Promise<void> {
  for (const ev of events) {
    await renderer.handle(ev, binding, adapter)
  }
}


export const ev = {
  delta: (s: string): SessionEvent => ({ type: 'text_delta', sessionId: 's', delta: s }),
  intermediate: (text: string): SessionEvent => ({
    type: 'text_complete',
    sessionId: 's',
    text,
    isIntermediate: true,
  }),
  final: (text: string): SessionEvent => ({
    type: 'text_complete',
    sessionId: 's',
    text,
    isIntermediate: false,
  }),
  // text_complete without an explicit isIntermediate flag — simulates
  // backends that don't set the field (older events or non-Claude agents).
  completeText: (text: string): SessionEvent => ({
    type: 'text_complete',
    sessionId: 's',
    text,
  }),
  toolStart: (displayName?: string): SessionEvent => ({
    type: 'tool_start',
    sessionId: 's',
    toolName: 'read',
    toolUseId: 'u1',
    toolInput: {},
    toolDisplayName: displayName,
  }),
  toolResult: (): SessionEvent => ({
    type: 'tool_result',
    sessionId: 's',
    toolUseId: 'u1',
    toolName: 'read',
    result: 'ok',
  }),
  complete: (): SessionEvent => ({ type: 'complete', sessionId: 's' }),
}
