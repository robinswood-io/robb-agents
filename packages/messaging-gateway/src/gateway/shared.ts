/**
 * MessagingGateway — orchestrator for messaging platform adapters.
 *
 * Runs in-process alongside SessionManager. Wires adapters, router,
 * renderer, and binding store together. One instance per workspace.
 */
import type { ISessionManager } from "@craft-agent/server-core/handlers";
import { type PairingCodeConsumer } from "../commands";
import type { PlatformType, MessagingConfig, MessagingLogger, PlatformOwner } from "../types";

export const consoleLogger: MessagingLogger = {
    info: (message, meta) => console.log('[MessagingGateway]', message, meta ?? ''),
    warn: (message, meta) => console.warn('[MessagingGateway]', message, meta ?? ''),
    error: (message, meta) => console.error('[MessagingGateway]', message, meta ?? ''),
    child(context) {
        return {
            info: (message, meta) => console.log('[MessagingGateway]', context, message, meta ?? ''),
            warn: (message, meta) => console.warn('[MessagingGateway]', context, message, meta ?? ''),
            error: (message, meta) => console.error('[MessagingGateway]', context, message, meta ?? ''),
            child: (next) => consoleLogger.child({ ...context, ...next }),
        };
    },
};

export interface GatewayOptions {
    sessionManager: ISessionManager;
    workspaceId: string;
    /** Absolute path to the messaging storage directory. */
    storageDir: string;
    /** Optional legacy directory for one-shot migration of bindings.json. */
    legacyStorageDir?: string;
    /** Optional consumer that resolves /pair codes issued elsewhere. */
    pairingConsumer?: PairingCodeConsumer;
    /** Fired after any binding mutation (bind/unbind). */
    onBindingChanged?: () => void;
    /**
     * Reads the workspace's MessagingConfig. Called per-message so config
     * edits (toggling accessMode, adding owners) take effect without restart.
     * Optional — when omitted, the gateway falls back to a permissive
     * "everything is open" config (useful for legacy callers and unit tests).
     */
    getWorkspaceConfig?: () => MessagingConfig;
    /**
     * Append `candidate` to the platform's owners list iff the list is
     * currently empty. No-op otherwise. Used by Commands.handlePair to
     * bootstrap ownership the first time anyone redeems a code.
     */
    seedOwnerOnFirstPair?: (platform: PlatformType, candidate: PlatformOwner) => Promise<PlatformOwner[]>;
    /**
     * Fires after the pending-senders store mutates, so the registry can push
     * an event to the renderer. Mirrors `onBindingChanged`.
     */
    onPendingChanged?: () => void;
    /** Optional logger — defaults to console. Pass a structured host logger in Electron. */
    logger?: MessagingLogger;
}

/**
 * Per-plan metadata tracked while a plan approval button is live on a chat.
 * Used to disable the inline keyboard after a tap. Keyed by plan token.
 */
export interface PlanMessageRecord {
    bindingId: string;
    platform: PlatformType;
    channelId: string;
    messageId: string;
}

/**
 * Per-permission-prompt metadata tracked while inline Approve/Deny buttons
 * are live on a chat. Keyed by `requestId`. Two roles:
 *
 *  1. Idempotency claim — `handleButtonPress` removes the entry before doing
 *     anything visible, so a second tap on the same prompt finds nothing and
 *     silently no-ops. Stops the duplicate "✅ Allowed / ❌ Denied" flood.
 *  2. Stale-prompt cleanup — when the agent moves past the permission
 *     (resolved from any channel — desktop, MCP, etc.), `onSessionEvent`
 *     sweeps the entry and clears the inline keyboard so the user can't
 *     even produce a callback by tapping a stale button.
 */
export interface PermissionMessageRecord {
    bindingId: string;
    sessionId: string;
    platform: PlatformType;
    channelId: string;
    messageId: string;
    threadId?: number;
}

export interface PendingCompactAccept {
    token: string;
    sessionId: string;
    bindingId: string;
    platform: PlatformType;
    channelId: string;
    /** Forum topic id where the press came from (Telegram supergroup), if any. */
    threadId?: number;
    messageId: string;
    planPath: string;
    createdAt: number;
}

export const COMPACT_ACCEPT_TTL_MS = 10 * 60 * 1000;
