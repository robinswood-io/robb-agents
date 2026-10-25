import type { PlatformAdapter, PlatformType, IncomingMessage, ButtonPress } from "../types";
import type { MessagingGateway } from '../gateway.ts';

export function registerAdapter(transportOwner: MessagingGateway, adapter: PlatformAdapter): void {
    const existing = transportOwner["adapters"].get(adapter.platform);
    if (existing) {
        existing.destroy().catch((err) => {
            transportOwner["log"].warn('failed to destroy existing adapter during replacement', {
                event: 'adapter_replace_destroy_failed',
                platform: adapter.platform,
                error: err,
            });
        });
    }
    transportOwner["adapters"].set(adapter.platform, adapter);
    if (transportOwner["started"]) {
        transportOwner["wireAdapter"](adapter);
    }
}

export async function unregisterAdapter(transportOwner: MessagingGateway, platform: PlatformType): Promise<void> {
    const adapter = transportOwner["adapters"].get(platform);
    if (!adapter)
        return;
    transportOwner["adapters"].delete(platform);
    try {
        await adapter.destroy();
        transportOwner["log"].info('adapter unregistered', {
            event: 'adapter_unregistered',
            platform,
        });
    }
    catch (err) {
        transportOwner["log"].error('failed to destroy adapter', {
            event: 'adapter_destroy_failed',
            platform,
            error: err,
        });
    }
}

export async function start(transportOwner: MessagingGateway): Promise<void> {
    if (transportOwner["started"])
        return;
    transportOwner["started"] = true;
    for (const adapter of transportOwner["adapters"].values()) {
        transportOwner["wireAdapter"](adapter);
    }
    transportOwner["log"].info('gateway started', { event: 'gateway_started' });
}

export async function stop(transportOwner: MessagingGateway): Promise<void> {
    if (!transportOwner["started"])
        return;
    transportOwner["started"] = false;
    for (const [platform, adapter] of transportOwner["adapters"]) {
        try {
            await adapter.destroy();
            transportOwner["log"].info('adapter stopped', {
                event: 'adapter_stopped',
                platform,
            });
        }
        catch (err) {
            transportOwner["log"].error('failed to stop adapter', {
                event: 'adapter_stop_failed',
                platform,
                error: err,
            });
        }
    }
    transportOwner["adapters"].clear();
}

export function wireAdapter(transportOwner: MessagingGateway, adapter: PlatformAdapter): void {
    adapter.onMessage(async (msg: IncomingMessage) => {
        const isCommand = msg.text.trim().startsWith('/');
        if (isCommand) {
            const handled = await transportOwner["commands"].handleCommand(adapter, msg);
            if (handled)
                return;
        }
        await transportOwner["router"].route(adapter, msg);
    });
    adapter.onButtonPress(async (press: ButtonPress) => {
        await transportOwner["handleButtonPress"](adapter.platform, press);
    });
    transportOwner["log"].info('adapter registered', {
        event: 'adapter_registered',
        platform: adapter.platform,
        capabilities: adapter.capabilities,
    });
}
