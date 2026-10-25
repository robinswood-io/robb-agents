/**
 * Commands — handles chat commands from unbound or bound channels.
 *
 * /new [name]    — create session + bind
 * /bind          — list recent sessions (or by id / index)
 * /pair <code>   — finish a session-initiated pairing flow
 * /unbind        — disconnect channel
 * /help          — show available commands
 * /status        — show current binding
 * /stop          — abort the current agent run
 */
import type { ISessionManager } from "@craft-agent/server-core/handlers";
import type { IncomingMessage, PlatformAdapter } from "../types";
import type { Commands } from '../commands.ts';

export async function handleStatus(transportOwner: Commands, adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {};
    const binding = transportOwner["bindingStore"].findByChannel(adapter.platform, msg.channelId, msg.threadId);
    if (!binding) {
        await adapter.sendText(msg.channelId, 'No session bound. Use /bind, /new, or /pair.', replyOpts);
        return;
    }
    const session = await transportOwner["sessionManager"].getSession(binding.sessionId);
    const name = session?.name || binding.sessionId.slice(0, 8);
    const mode = binding.config.approvalChannel;
    const responseMode = binding.config.responseMode;
    await adapter.sendText(msg.channelId, `Bound to "${name}"\nApproval: ${mode}\nResponse mode: ${responseMode}`, replyOpts);
}

export async function handleStop(transportOwner: Commands, adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {};
    const binding = transportOwner["bindingStore"].findByChannel(adapter.platform, msg.channelId, msg.threadId);
    if (!binding) {
        await adapter.sendText(msg.channelId, 'No session bound.', replyOpts);
        return;
    }
    try {
        await transportOwner["sessionManager"].cancelProcessing(binding.sessionId);
        await adapter.sendText(msg.channelId, 'Stopped.', replyOpts);
    }
    catch {
        await adapter.sendText(msg.channelId, 'Nothing to stop.', replyOpts);
    }
}

export async function handleHelp(transportOwner: Commands, adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    const bindLine = adapter.platform === 'whatsapp'
        ? '/bind — list recent sessions (then use /bind <number>)\n'
        : '/bind — pick from recent sessions\n';
    const replyOpts = msg.threadId !== undefined ? { threadId: msg.threadId } : {};
    await adapter.sendText(msg.channelId, 'Commands:\n' +
        '/new [name] — create + bind new session\n' +
        bindLine +
        '/bind <id> — bind to specific session\n' +
        '/pair <code> — redeem an app-generated pairing code\n' +
        '/unbind — disconnect this chat\n' +
        '/status — show current binding\n' +
        '/stop — abort current agent run\n' +
        '/help — show this message', replyOpts);
}

export function getRecentSessions(transportOwner: Commands): ReturnType<ISessionManager['getSessions']> {
    return transportOwner["sessionManager"].getSessions(transportOwner["workspaceId"])
        .filter((s) => !s.isArchived)
        .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
        .slice(0, 10);
}

export async function resolveBindTarget(transportOwner: Commands, bindArg: string, recent: ReturnType<ISessionManager['getSessions']>): Promise<Awaited<ReturnType<ISessionManager['getSession']>> | undefined> {
    if (/^\d+$/.test(bindArg)) {
        const index = Number(bindArg);
        if (index >= 1 && index <= recent.length) {
            return recent[index - 1];
        }
    }
    return transportOwner["sessionManager"].getSession(bindArg);
}
