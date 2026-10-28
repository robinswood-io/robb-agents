import { readPlatformAccessMode, readPlatformOwners } from "../access-control";
import type { IncomingMessage, PlatformAdapter } from "../types";
import type { Commands } from '../commands.ts';
import { parseCommand } from './shared.ts';

// -------------------------------------------------------------------------
  // Command handlers
  // -------------------------------------------------------------------------
export async function handleNew(transportOwner: Commands, adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const name = parseCommand(msg.text).args || undefined;
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {};
    try {
        const session = await transportOwner["sessionManager"].createSession(transportOwner["workspaceId"], { name });
        transportOwner["bindingStore"].bind(transportOwner["workspaceId"], session.id, adapter.platform, msg.channelId, msg.senderName, undefined, msg.threadId);
        const displayName = session.name || session.id;
        await adapter.sendText(msg.channelId, `Created "${displayName}" — you're connected. Just type to start.`, replyOpts);
        transportOwner.log.info('session created and bound from chat', {
            event: 'session_created_from_chat',
            workspaceId: transportOwner["workspaceId"],
            sessionId: session.id,
            platform: adapter.platform,
            channelId: msg.channelId,
            threadId: msg.threadId,
        });
    }
    catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        transportOwner.log.error('failed to create session from chat', {
            event: 'session_create_failed',
            workspaceId: transportOwner["workspaceId"],
            platform: adapter.platform,
            channelId: msg.channelId,
            error: err,
        });
        await adapter.sendText(msg.channelId, `Failed to create session: ${errorMsg}`, replyOpts);
    }
}

export async function handleBind(transportOwner: Commands, adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const bindArg = parseCommand(msg.text).args;
    const recent = transportOwner.getRecentSessions();
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {};
    if (bindArg) {
        const session = await transportOwner.resolveBindTarget(bindArg, recent);
        if (!session) {
            await adapter.sendText(msg.channelId, `Session not found: ${bindArg}`, replyOpts);
            return;
        }
        transportOwner["bindingStore"].bind(transportOwner["workspaceId"], session.id, adapter.platform, msg.channelId, msg.senderName, undefined, msg.threadId);
        transportOwner.log.info('chat bound to existing session', {
            event: 'chat_bound',
            workspaceId: transportOwner["workspaceId"],
            sessionId: session.id,
            platform: adapter.platform,
            channelId: msg.channelId,
            threadId: msg.threadId,
            bindArg,
        });
        await adapter.sendText(msg.channelId, `Bound to "${session.name || session.id}"`, replyOpts);
        return;
    }
    if (recent.length === 0) {
        await adapter.sendText(msg.channelId, 'No sessions found. Use /new to create one.', replyOpts);
        return;
    }
    if (adapter.capabilities.inlineButtons) {
        const buttons = recent.slice(0, adapter.capabilities.maxButtons).map((s) => ({
            id: `bind:${s.id}`,
            label: (s.name || s.id.slice(0, 8)).slice(0, 30),
            data: s.id,
        }));
        await adapter.sendButtons(msg.channelId, 'Recent sessions:', buttons, replyOpts);
        return;
    }
    const lines = recent.map((s, i) => {
        const name = s.name || s.id.slice(0, 8);
        return `${i + 1}. ${name} (${s.id.slice(0, 8)})`;
    });
    await adapter.sendText(msg.channelId, 'Recent sessions:\n' + lines.join('\n') + '\n\nUse /bind <number> to connect, or /bind <session-id> if you already know it.', replyOpts);
}

export async function handlePair(transportOwner: Commands, adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {};
    if (!transportOwner["pairingConsumer"]) {
        await adapter.sendText(msg.channelId, 'Pairing is not available in this build.', replyOpts);
        return;
    }
    // Throttle BEFORE format validation — otherwise an attacker gets
    // unlimited "is this a valid format" feedback that's almost as useful
    // as a code check. Every `/pair` attempt counts against the budget.
    if (!transportOwner["pairingConsumer"].canConsume(adapter.platform, msg.senderId)) {
        transportOwner.log.warn('pairing consume rate limit hit', {
            event: 'pairing_consume_rate_limited',
            workspaceId: transportOwner["workspaceId"],
            platform: adapter.platform,
            channelId: msg.channelId,
            senderId: msg.senderId,
        });
        await adapter.sendText(msg.channelId, '⏳ Too many pairing attempts. Try again in a minute.', replyOpts);
        return;
    }
    // Use the centralized parser so `/pair@MyBot 123456` works the same
    // as `/pair 123456` — Telegram routes commands by bot suffix in
    // group chats and many users will type the canonical form.
    const { args } = parseCommand(msg.text);
    const code = args.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) {
        await adapter.sendText(msg.channelId, 'Usage: /pair <6-digit code>\n\nGenerate a code from the session menu or the Telegram supergroup setup in the Robb Agents app.', replyOpts);
        return;
    }
    // Pre-consume access gate. Bootstrap rule: when the platform has zero
    // owners, ANY successful redeem seeds the first owner (the user who
    // typed `/pair`). Once owners exist, only existing owners may redeem
    // further codes — without this, an attacker who steals or guesses a
    // code becomes an owner.
    const wsConfig = transportOwner.access.getWorkspaceConfig();
    const wsMode = readPlatformAccessMode(wsConfig, adapter.platform);
    const owners = readPlatformOwners(wsConfig, adapter.platform);
    if (wsMode === 'owner-only' &&
        owners.length > 0 &&
        !owners.some((o) => o.userId === msg.senderId)) {
        transportOwner.log.info('pairing redeem blocked: sender is not an owner', {
            event: 'pairing_redeem_not_owner',
            workspaceId: transportOwner["workspaceId"],
            platform: adapter.platform,
            senderId: msg.senderId,
        });
        await adapter.sendText(msg.channelId, 'Only existing bot owners can redeem pairing codes. Ask an owner to add you in the Robb Agents app.', replyOpts);
        return;
    }
    const entry = transportOwner["pairingConsumer"].consume(adapter.platform, code);
    if (!entry) {
        await adapter.sendText(msg.channelId, 'Invalid or expired pairing code.', replyOpts);
        return;
    }
    // Seed the first owner. The seeder is a no-op when the list is already
    // populated, so it's safe to call unconditionally on every successful
    // redeem. Failures are logged but never block the pair itself — losing
    // the seed only means the operator has to add the user manually later.
    try {
        await transportOwner.access.seedOwnerOnFirstPair(adapter.platform, {
            userId: msg.senderId,
            ...(msg.senderName ? { displayName: msg.senderName } : {}),
            ...(msg.senderUsername ? { username: msg.senderUsername } : {}),
            addedAt: Date.now(),
        });
    }
    catch (err) {
        transportOwner.log.warn('seedOwnerOnFirstPair failed (non-fatal)', {
            event: 'pairing_owner_seed_failed',
            workspaceId: transportOwner["workspaceId"],
            platform: adapter.platform,
            senderId: msg.senderId,
            error: err,
        });
    }
    if (entry.kind === 'workspace-supergroup') {
        await transportOwner.handleSupergroupPair(adapter, msg, entry, replyOpts);
        return;
    }
    // entry.kind === 'session'
    const session = await transportOwner["sessionManager"].getSession(entry.sessionId);
    if (!session) {
        await adapter.sendText(msg.channelId, 'Session no longer exists.', replyOpts);
        return;
    }
    transportOwner["bindingStore"].bind(entry.workspaceId, entry.sessionId, adapter.platform, msg.channelId, msg.senderName, undefined, msg.threadId);
    transportOwner.log.info('pairing code redeemed', {
        event: 'pairing_redeemed',
        kind: 'session',
        workspaceId: entry.workspaceId,
        sessionId: entry.sessionId,
        platform: adapter.platform,
        channelId: msg.channelId,
        threadId: msg.threadId,
    });
    const topicHint = msg.threadId !== undefined
        ? ` (topic #${msg.threadId})`
        : '';
    await adapter.sendText(msg.channelId, `✅ Paired with "${session.name || session.id}"${topicHint}. You can start chatting now.`, replyOpts);
}

/**
   * Workspace-supergroup pairing: a `/pair <code>` typed in a Telegram
   * supergroup with a workspace-supergroup-kind code. We register the
   * supergroup's chat_id at the workspace level so the adapter starts
   * accepting messages from it (in addition to DMs).
   */
export async function handleSupergroupPair(transportOwner: Commands, adapter: PlatformAdapter, msg: IncomingMessage, entry: {
    workspaceId: string;
}, replyOpts: {
    threadId?: number;
}): Promise<void> {
    if (adapter.platform !== 'telegram') {
        await adapter.sendText(msg.channelId, 'Workspace-supergroup pairing is only supported on Telegram.', replyOpts);
        return;
    }
    if (!transportOwner["pairingConsumer"]?.bindWorkspaceSupergroup) {
        await adapter.sendText(msg.channelId, 'Supergroup pairing is not enabled in this build.', replyOpts);
        return;
    }
    try {
        const result = await transportOwner["pairingConsumer"].bindWorkspaceSupergroup({
            platform: adapter.platform,
            chatId: msg.channelId,
            ...(msg.senderName !== undefined ? { fallbackTitle: msg.senderName } : {}),
        });
        transportOwner.log.info('pairing code redeemed', {
            event: 'pairing_redeemed',
            kind: 'workspace-supergroup',
            workspaceId: entry.workspaceId,
            platform: adapter.platform,
            channelId: msg.channelId,
            title: result.title,
        });
        await adapter.sendText(msg.channelId, `✅ Supergroup *${result.title}* paired. Sessions can now be bound to topics in this group.`, replyOpts);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        transportOwner.log.error('workspace supergroup bind failed', {
            event: 'workspace_supergroup_bind_failed',
            workspaceId: entry.workspaceId,
            platform: adapter.platform,
            channelId: msg.channelId,
            error: err,
        });
        await adapter.sendText(msg.channelId, `❌ Couldn't pair this supergroup: ${message}`, replyOpts);
    }
}

export async function handleUnbind(transportOwner: Commands, adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {};
    const removed = transportOwner["bindingStore"].unbind(adapter.platform, msg.channelId, msg.threadId);
    if (removed) {
        await adapter.sendText(msg.channelId, 'Disconnected from session.', replyOpts);
    }
    else {
        await adapter.sendText(msg.channelId, 'No session is bound to this chat.', replyOpts);
    }
}
