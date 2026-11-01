import type { PendingSendersStore } from "../pending-senders";
import type { MessagingConfig, MessagingLogger, PlatformOwner, PlatformType } from "../types";

export const NOOP_LOGGER: MessagingLogger = {
    info: () => { },
    warn: () => { },
    error: () => { },
    child: () => NOOP_LOGGER,
};

/**
 * Result of consuming a pairing code. The `kind` discriminator tells the
 * caller which downstream flow to run (bind a session, or register the
 * supergroup chat at the workspace level).
 */
export type PairingConsumeResult = {
    kind: 'session';
    workspaceId: string;
    sessionId: string;
} | {
    kind: 'workspace-supergroup';
    workspaceId: string;
};

/**
 * Supplied by the registry. The gateway passes the consumer down to Commands so
 * /pair can redeem codes issued via the app UI. Only codes belonging to the
 * gateway's own workspace are honored.
 */
export interface PairingCodeConsumer {
    /**
     * Returns whether this sender may still attempt a /pair consume this minute.
     * Defence-in-depth against brute-forcing the 6-digit code. Counted on entry,
     * not after validation, so wrong guesses consume budget too.
     */
    canConsume(platform: PlatformType, senderId: string): boolean;
    /** Returns the pending pairing if the code is valid, or null. */
    consume(platform: PlatformType, code: string): PairingConsumeResult | null;
    /**
     * Register the supergroup that just paired itself. Invoked from
     * Commands.handlePair when the consumed code's kind is
     * `workspace-supergroup`. Performs the persistence + adapter-reconfigure
     * dance that lives in the registry.
     */
    bindWorkspaceSupergroup?(args: {
        platform: PlatformType;
        chatId: string;
        /** Optional fall-back display name; the registry can fetch a real one via getChat. */
        fallbackTitle?: string;
    }): Promise<{
        title: string;
    }>;
}

/**
 * Access-control wiring supplied by the gateway. Commands consults the
 * workspace config on every command invocation (so config edits take effect
 * without restart) and uses `seedOwnerOnFirstPair` to bootstrap ownership
 * the first time anyone redeems a pairing code.
 */
export interface AccessControlDeps {
    getWorkspaceConfig: () => MessagingConfig;
    /**
     * Append the sender to the platform's owners list iff the list is currently
     * empty for that platform. Returns the updated list (or the existing list
     * if the seed didn't run). Called from `/pair` consume.
     */
    seedOwnerOnFirstPair: (platform: PlatformType, candidate: PlatformOwner) => Promise<PlatformOwner[]>;
    /** Optional pending-senders store for recording rejected attempts. */
    pendingStore?: PendingSendersStore;
}

/**
 * Commands the gateway lets *anyone* run, regardless of ownership. `/pair`
 * is the bootstrap exception (first sender to redeem becomes owner) and
 * `/help` is informational.
 */
export const ALWAYS_ALLOWED_COMMANDS = new Set(['/pair', '/help']);

/**
 * Telegram (and other Bot-API platforms) lets users address commands to
 * specific bots in shared chats: `/pair@MyBot 123456`. Without stripping
 * the `@BotName` suffix, the cmd token doesn't match our switch cases and
 * supergroup pairing breaks for users typing the canonical group form.
 *
 * Returns `{ cmd: '', args: '' }` for non-command text. Lower-cases the
 * cmd so callsites can do exact-string comparisons.
 */
export function parseCommand(text: string): {
    cmd: string;
    args: string;
} {
    const trimmed = text.trim();
    const m = trimmed.match(/^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
    if (!m)
        return { cmd: '', args: '' };
    return { cmd: '/' + m[1]!.toLowerCase(), args: (m[2] ?? '').trim() };
}
