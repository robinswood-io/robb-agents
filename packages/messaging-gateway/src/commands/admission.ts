import { evaluatePreBindingAccess, executeRejection, type AccessRejectReason } from "../access-control";
import type { IncomingMessage, PlatformAdapter } from "../types";
import type { Commands } from '../commands.ts';
import { ALWAYS_ALLOWED_COMMANDS, parseCommand } from './shared.ts';

export async function handle(transportOwner: Commands, adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const text = msg.text.trim();
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {};
    // Pre-binding gate: every inbound stimulus runs through the access
    // evaluator, including non-command free-form text. Without this,
    // a stranger DMing "hi" would receive the help message (revealing
    // commands) and bypass the pending-senders flow. Only `/pair`
    // (bootstrap) and `/help` (informational) skip the gate.
    const cmd = parseCommand(text).cmd;
    const skipsGate = cmd && ALWAYS_ALLOWED_COMMANDS.has(cmd);
    if (!skipsGate) {
        const verdict = evaluatePreBindingAccess({
            msg,
            workspaceConfig: transportOwner.access.getWorkspaceConfig(),
        });
        if (!verdict.allow) {
            await transportOwner.sendRejection(adapter, msg, verdict.reason);
            return;
        }
    }
    // Exact-cmd dispatch (parsed; supports `/cmd@BotName`). Avoids the old
    // `text.startsWith('/new')` bug where `/newuser` would also dispatch
    // to handleNew.
    if (cmd === '/new') {
        await transportOwner.handleNew(adapter, msg);
    }
    else if (cmd === '/bind') {
        await transportOwner.handleBind(adapter, msg);
    }
    else if (cmd === '/pair') {
        await transportOwner.handlePair(adapter, msg);
    }
    else if (cmd === '/unbind') {
        await transportOwner.handleUnbind(adapter, msg);
    }
    else if (cmd === '/help') {
        await transportOwner.handleHelp(adapter, msg);
    }
    else {
        // Sender passed the access gate (owner or open workspace) and typed
        // free-form text into a chat with no binding. Show the help prompt.
        await adapter.sendText(msg.channelId, 'No session bound to this chat.\n\n' +
            '/new [name] — start a new session\n' +
            '/bind — connect to an existing session\n' +
            '/pair <code> — redeem a pairing code from the app\n' +
            '/help — show all commands', replyOpts);
    }
}

export async function handleCommand(transportOwner: Commands, adapter: PlatformAdapter, msg: IncomingMessage): Promise<boolean> {
    const text = msg.text.trim();
    if (!text.startsWith('/'))
        return false;
    // Strip the optional `@BotName` suffix Telegram uses to disambiguate
    // commands in shared chats. Without this, `/pair@MyBot 123456` would
    // never match the switch case below.
    const { cmd } = parseCommand(text);
    if (!cmd)
        return false;
    transportOwner.log.info('handling chat command', {
        event: 'command_received',
        workspaceId: transportOwner["workspaceId"],
        platform: adapter.platform,
        channelId: msg.channelId,
        senderId: msg.senderId,
        command: cmd,
    });
    // Pre-binding gate for commands that arrive directly (i.e. typed inside
    // an already-bound chat — `gateway.wireAdapter` always tries
    // `handleCommand` before `router.route`). `/pair` and `/help` always pass.
    if (!ALWAYS_ALLOWED_COMMANDS.has(cmd)) {
        const verdict = evaluatePreBindingAccess({
            msg,
            workspaceConfig: transportOwner.access.getWorkspaceConfig(),
        });
        if (!verdict.allow) {
            await transportOwner.sendRejection(adapter, msg, verdict.reason);
            return true;
        }
    }
    switch (cmd) {
        case '/new':
            await transportOwner.handleNew(adapter, msg);
            return true;
        case '/bind':
            await transportOwner.handleBind(adapter, msg);
            return true;
        case '/pair':
            await transportOwner.handlePair(adapter, msg);
            return true;
        case '/unbind':
            await transportOwner.handleUnbind(adapter, msg);
            return true;
        case '/help':
            await transportOwner.handleHelp(adapter, msg);
            return true;
        case '/status':
            await transportOwner.handleStatus(adapter, msg);
            return true;
        case '/stop':
            await transportOwner.handleStop(adapter, msg);
            return true;
        default:
            return false;
    }
}

/**
   * Reject reply for pre-binding gating. Delegates to the shared
   * `executeRejection` so text and button paths emit identical output.
   */
export async function sendRejection(transportOwner: Commands, adapter: PlatformAdapter, msg: IncomingMessage, reason: AccessRejectReason): Promise<void> {
    await executeRejection(adapter, msg, reason, {
        recentRejectReplies: transportOwner.recentRejectReplies,
        ...(transportOwner.access.pendingStore ? { pendingStore: transportOwner.access.pendingStore } : {}),
    }, transportOwner.log);
}
