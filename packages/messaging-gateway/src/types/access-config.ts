import type { PlatformType } from './platform.ts';

// ---------------------------------------------------------------------------
// Gateway config (persisted per workspace)
// ---------------------------------------------------------------------------

/**
 * Workspace-level Telegram supergroup ("forum") configuration. When set,
 * the adapter accepts messages from this chat (in addition to DMs) and
 * sessions can be bound to specific topics inside it.
 *
 * Captured by typing `/pair <code>` in the supergroup with a workspace-
 * supergroup-kind pairing code. The bot reads the chat title from
 * `getChat()` once and stores it for display only.
 */
export interface TelegramSupergroupConfig {
  /** Telegram chat_id of the supergroup, e.g. `"-1001234567890"`. */
  chatId: string
  /** Display title captured at pairing time. Refreshed on next successful connect. */
  title: string
  /** Unix-ms timestamp when the supergroup was paired. */
  capturedAt: number
}

/**
 * Workspace-level access policy for a messaging platform.
 *
 * - `open`        — anyone in an accepted chat can run pre-binding commands
 *                   (`/new`, `/bind`) and bound chats fall back to their own
 *                   `BindingConfig.accessMode` for routing.
 * - `owner-only`  — pre-binding commands require sender to be on the
 *                   platform's `owners` list. Bindings whose `accessMode`
 *                   is `'inherit'` use the same list as their allow-list.
 *
 * Defaults vary by migration vs. fresh setup:
 *  - Fresh workspaces pairing the bot for the first time → `'owner-only'`.
 *  - Existing workspaces that predate access control → `'open'` so the
 *    Settings UI can show a "Lock down" banner without breaking traffic.
 */
export type PlatformAccessMode = 'open' | 'owner-only'

/**
 * A user authorised to interact with the workspace's bot. Platform-native
 * `userId` (Telegram numeric user_id as a string). `displayName` and
 * `username` are best-effort metadata captured when the user pairs or sends
 * a message; they're for UI rendering only.
 */
export interface PlatformOwner {
  userId: string
  displayName?: string
  username?: string
  /** Unix-ms when this owner was added to the list. */
  addedAt: number
}

/**
 * Why a sender ended up in the pending list. Drives the UI's "Allow"
 * button: promoting a workspace-level reject is different from promoting
 * a binding-allow-list reject, and conflating them silently was a real
 * privilege-escalation footgun.
 *
 * - `not-owner` — workspace-level pre-binding reject. Allowing means
 *   adding the sender to `platforms.{platform}.owners`.
 * - `not-on-binding-allowlist` — binding-level reject. Allowing means
 *   appending the sender to that binding's `allowedSenderIds`, NOT
 *   touching workspace owners.
 */
export type PendingRejectReason = 'not-owner' | 'not-on-binding-allowlist'

/**
 * A sender the gateway recently rejected. Surfaces in the Settings UI so
 * the operator can promote them with one click instead of typing numeric
 * ids by hand.
 *
 * The store is bounded (LRU + TTL) — see `pending-senders.ts`. Persistence
 * is best-effort: losing the file just means the operator has to wait for
 * the user to attempt access again.
 *
 * Same `(platform, userId)` is allowed to appear multiple times when the
 * sender hits *different* bindings — the operator needs to see (and
 * decide on) each binding-level reject separately rather than having
 * the second silently overwrite the first.
 */
export interface PendingSender {
  /** Platform identity. */
  platform: PlatformType
  userId: string
  displayName?: string
  username?: string
  /** Unix-ms of the most recent rejected attempt. */
  lastAttemptAt: number
  /** Total attempts since this sender first appeared in the pending list. */
  attemptCount: number
  /**
   * Why the sender was rejected. Optional for back-compat with persisted
   * entries written by an earlier build that lacked the field; missing
   * `reason` is treated as `'not-owner'` (the safer default).
   */
  reason?: PendingRejectReason
  /**
   * Binding the reject was scoped to. Only present when
   * `reason === 'not-on-binding-allowlist'`. Lets the operator's "Allow"
   * action target the right binding's `allowedSenderIds`.
   */
  bindingId?: string
  sessionId?: string
  channelId?: string
  threadId?: number
}

export interface MessagingConfig {
  enabled: boolean
  platforms: {
    telegram?: {
      enabled: boolean
      /**
       * Optional configured supergroup. Adapter accepts messages from this
       * chat in addition to DMs. Sessions can bind to specific topics within.
       */
      supergroup?: TelegramSupergroupConfig
      /**
       * Workspace-level access policy. Missing field = `'open'` for back-
       * compat with workspaces that predate access control. Fresh setups
       * land on `'owner-only'` automatically (registry sets it on first pair).
       */
      accessMode?: PlatformAccessMode
      /**
       * Telegram user ids permitted to drive the bot at workspace level.
       * Gates `/new`, `/bind`, `/unbind`, `/status`, `/stop` and serves as
       * the default sender allow-list for bindings whose `accessMode === 'inherit'`.
       *
       * `/pair` itself stays open: if the list is empty, the first
       * successful redeem seeds the list with the consuming sender. After
       * that, only existing owners may redeem further codes.
       */
      owners?: PlatformOwner[]
    }
    whatsapp?: {
      enabled: boolean
      /**
       * When true, messages sent from other devices on the same WA account
       * to the self-JID (your own number) are routed to a bound session.
       * The worker filters its own echoes via sent-ID tracking + a response
       * prefix. Defaults to `true` when unset — the no-second-phone flow is
       * the expected UX for new users.
       */
      selfChatMode?: boolean
    }
    lark?: {
      enabled: boolean
      /**
       * Which Lark/Feishu domain the bot belongs to. A bot is registered
       * with one Open Platform — they're separate ecosystems despite
       * sharing the same SDK + protocols.
       *  - `lark` → open.larksuite.com (international)
       *  - `feishu` → open.feishu.cn (China)
       */
      domain?: 'lark' | 'feishu'
    }
  }
}

export const DEFAULT_MESSAGING_CONFIG: MessagingConfig = {
  enabled: false,
  platforms: {},
}
