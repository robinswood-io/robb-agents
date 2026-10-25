import type { PushTarget } from "@craft-agent/shared/protocol";
import { RPC_CHANNELS } from "@craft-agent/shared/protocol";
import { type SessionEvent } from "../renderer";
import type { MessagingGateway } from '../gateway.ts';

export function onSessionEvent(transportOwner: MessagingGateway, channel: string, _target: PushTarget, ...args: unknown[]): void {
    if (channel !== RPC_CHANNELS.sessions.EVENT)
        return;
    const event = args[0] as SessionEvent | undefined;
    if (!event?.sessionId)
        return;
    // If this session has a pending "accept & compact" that is now finishing
    // compaction, dispatch the approval now. Before the fan-out so the
    // renderer's own `info:compaction_complete` path doesn't race.
    if (event.type === 'info' &&
        (event as {
            statusType?: string;
        }).statusType === 'compaction_complete') {
        void transportOwner["finishPendingCompactAccept"](event.sessionId);
    }
    // Drop stale permission prompts for this session. The agent halts while
    // a permission is pending, so any non-permission_request event implies
    // the prior prompt was resolved (from the desktop, an MCP allow-list,
    // remember-window auto-approval, etc.). Without this sweep the inline
    // keyboard stays live in Telegram and users keep tapping stale buttons,
    // which is the visible side of #726.
    transportOwner["sweepStalePermissions"](event);
    const bindings = transportOwner["bindingStore"].findBySession(event.sessionId);
    if (bindings.length === 0)
        return;
    for (const binding of bindings) {
        const adapter = transportOwner["adapters"].get(binding.platform);
        if (!adapter || !adapter.isConnected()) {
            transportOwner["log"].warn('dropping session event — adapter not connected', {
                event: 'adapter_not_connected',
                sessionId: event.sessionId,
                platform: binding.platform,
                eventType: event.type,
            });
            continue;
        }
        transportOwner["renderer"].handle(event, binding, adapter).catch((err) => {
            transportOwner["log"].error('renderer failed to emit event to chat', {
                event: 'renderer_failed',
                sessionId: event.sessionId,
                bindingId: binding.id,
                platform: binding.platform,
                channelId: binding.channelId,
                error: err,
            });
        });
    }
}
