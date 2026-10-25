import { RPC_CHANNELS } from "@craft-agent/shared/protocol";
import type { MessagingGatewayRegistry } from '../registry.ts';

export function emitBindingChanged(transportOwner: MessagingGatewayRegistry, workspaceId: string): void {
    transportOwner["opts"].publishEvent?.(RPC_CHANNELS.messaging.BINDING_CHANGED, { to: 'workspace', workspaceId }, workspaceId);
}

export function emitPendingChanged(transportOwner: MessagingGatewayRegistry, workspaceId: string): void {
    // Channel name kept symmetric with BINDING_CHANGED. Phase 3 wires the
    // RPC channel constant; for now this is a no-op when the constant is
    // absent.
    const channel = (RPC_CHANNELS.messaging as Record<string, string | undefined>).PENDING_CHANGED;
    if (!channel)
        return;
    transportOwner["opts"].publishEvent?.(channel, { to: 'workspace', workspaceId }, workspaceId);
}
