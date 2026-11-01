import type { PlatformType } from './platform.ts';

// ---------------------------------------------------------------------------
// Channel binding
// ---------------------------------------------------------------------------

/**
 * How agent output is rendered to the chat.
 *
 * - `streaming` — legacy behaviour: live edits during the final turn, and
 *   every intermediate `text_complete` starts a fresh message. Produces
 *   multiple messages per agent run. Kept for parity with in-app UI.
 * - `progress` — one evolving message per run. Posts a "💭 thinking…"
 *   bubble on first activity, edits it as tools run, replaces it with
 *   the final answer on `complete`. Intermediate assistant text is
 *   dropped. Default for new bindings.
 * - `final_only` — silent until `complete`, then one message with the
 *   final text. Nothing is posted if the run has no final text.
 */
export type ResponseMode = 'streaming' | 'progress' | 'final_only'

/**
 * Per-binding access policy.
 *
 * - `inherit`     — defer to the platform's owners list (default for new bindings).
 * - `allow-list`  — only senders in `allowedSenderIds` may route to the bound session.
 * - `open`        — anyone in an accepted chat may route. Used as the migration
 *                   default for bindings created before access control existed,
 *                   and for explicitly-public bindings (e.g. support bots).
 */
export type BindingAccessMode = 'inherit' | 'allow-list' | 'open'

export interface BindingConfig {
  /** How outbound agent output is rendered. Default: 'progress' */
  responseMode: ResponseMode
  /**
   * @deprecated Use `responseMode` instead. Retained so persisted configs
   * written by older versions keep validating; the renderer ignores this
   * field when `responseMode` is present.
   */
  streamResponses: boolean
  /** Show compact tool activity summaries. Default: false */
  showToolActivity: boolean
  /** WHERE approval happens (not WHETHER — session mode is authoritative). */
  approvalChannel: 'chat' | 'app'
  /** Telegram edit interval in ms. ~3500ms stays under 20 edits/min. */
  editIntervalMs: number
  /**
   * Per-binding access mode. Governs Router.route() admission for this
   * binding only. Defaults vary by migration vs. fresh creation:
   *  - Fresh bindings (created after access control shipped): `'inherit'`.
   *  - Migrated bindings (legacy data with no field set): `'open'` so prod
   *    behaviour is unchanged until the owner explicitly locks down.
   */
  accessMode: BindingAccessMode
  /**
   * Sender ids permitted to route into this binding when `accessMode === 'allow-list'`.
   * Ignored otherwise. The list is platform-native (Telegram numeric user_id
   * as a string).
   */
  allowedSenderIds: string[]
}

export const DEFAULT_BINDING_CONFIG: BindingConfig = {
  responseMode: 'progress',
  streamResponses: true,
  showToolActivity: false,
  approvalChannel: 'chat',
  editIntervalMs: 3500,
  accessMode: 'inherit',
  allowedSenderIds: [],
}

export function getDefaultBindingConfig(platform: PlatformType): BindingConfig {
  return {
    ...DEFAULT_BINDING_CONFIG,
    approvalChannel: platform === 'whatsapp' ? 'app' : DEFAULT_BINDING_CONFIG.approvalChannel,
  }
}

export function normalizeBindingConfig(
  platform: PlatformType,
  config?: Partial<BindingConfig>,
): BindingConfig {
  const base = getDefaultBindingConfig(platform)
  const resolvedResponseMode: ResponseMode =
    config?.responseMode ??
    (config?.streamResponses === false ? 'final_only' : config?.streamResponses === true ? 'streaming' : base.responseMode)

  // Migration rule: if a persisted config predates access control (no
  // `accessMode` field), treat the binding as `'open'` so prod behaviour
  // doesn't change silently. Owners explicitly lock down via Settings.
  const accessMode: BindingAccessMode =
    config?.accessMode ?? (config !== undefined ? 'open' : base.accessMode)

  const allowedSenderIds = Array.isArray(config?.allowedSenderIds)
    ? [...config!.allowedSenderIds]
    : []

  return {
    ...base,
    ...config,
    responseMode: resolvedResponseMode,
    approvalChannel: platform === 'whatsapp' ? 'app' : (config?.approvalChannel ?? base.approvalChannel),
    accessMode,
    allowedSenderIds,
  }
}

export interface ChannelBinding {
  id: string
  workspaceId: string
  sessionId: string
  platform: PlatformType
  channelId: string
  /**
   * Telegram supergroup forum topic id. Undefined = DM, General topic, or
   * non-Telegram. Eviction on `bind()` keys on `(platform, channelId, threadId ?? null)`,
   * so DMs and topics in the same supergroup are independently bindable.
   */
  threadId?: number
  channelName?: string
  enabled: boolean
  createdAt: number
  config: BindingConfig
}
