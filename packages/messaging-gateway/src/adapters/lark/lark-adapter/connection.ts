import * as lark from "@larksuiteoapi/node-sdk";
import type { PlatformConfig } from "../../../types";
import type { LarkAdapter } from '../index.ts';
import { NOOP_LOGGER, parseLarkCredentials, resolveLarkDomain } from './shared.ts';
import type { LarkClient, LarkMessageEvent, LarkCardActionEvent } from './shared.ts';

export async function initialize(transportOwner: LarkAdapter, config: PlatformConfig): Promise<void> {
    transportOwner["log"] = config.logger ?? NOOP_LOGGER;
    const creds = parseLarkCredentials(config.token);
    const sdkDomain = resolveLarkDomain(creds.domain);
    // Construct REST client (sends + lookups go through this).
    transportOwner["client"] = new lark.Client({
        appId: creds.appId,
        appSecret: creds.appSecret,
        domain: sdkDomain,
        loggerLevel: lark.LoggerLevel.warn,
    }) as unknown as LarkClient;
    // Long-connection WS client + event dispatcher.
    //
    // Lifecycle hooks log explicitly so we can distinguish "socket never
    // opened" from "socket open but no events firing" — the second one
    // usually means the app's scopes or event subscriptions are misconfigured
    // on the Open Platform side, which is invisible from our side otherwise.
    transportOwner["wsClient"] = new lark.WSClient({
        appId: creds.appId,
        appSecret: creds.appSecret,
        domain: sdkDomain,
        loggerLevel: lark.LoggerLevel.info,
        onReady: () => {
            transportOwner["log"].info('[lark] ws ready', { event: 'lark_ws_ready' });
        },
        onError: (err: unknown) => {
            transportOwner["log"].error('[lark] ws error', {
                event: 'lark_ws_error',
                error: err instanceof Error ? err.message : String(err),
            });
        },
        onReconnecting: () => {
            transportOwner["log"].info('[lark] ws reconnecting', { event: 'lark_ws_reconnecting' });
        },
        onReconnected: () => {
            transportOwner["log"].info('[lark] ws reconnected', { event: 'lark_ws_reconnected' });
        },
    } as unknown as ConstructorParameters<typeof lark.WSClient>[0]);
    // The SDK's `register` typing is a wide-open union over hundreds of event
    // names. Cast the handler block once via `unknown` to keep the adapter
    // readable; the per-handler payload casts above handle the actual shape.
    const eventDispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: unknown) => {
            await transportOwner["handleIncomingMessage"](data as LarkMessageEvent);
        },
        'card.action.trigger': async (data: unknown) => {
            await transportOwner["handleCardAction"](data as LarkCardActionEvent);
            // Lark expects a synchronous return that may patch the card; we
            // return an empty object (no patch) and let `clearButtons` do the
            // visual cleanup async via the binding's existing post-press flow.
            return {};
        },
    } as unknown as Parameters<lark.EventDispatcher['register']>[0]);
    await transportOwner["wsClient"].start({ eventDispatcher });
    transportOwner["connected"] = true;
    transportOwner["log"].info('[lark] connected', {
        event: 'lark_connected',
        domain: creds.domain,
    });
}

export async function destroy(transportOwner: LarkAdapter): Promise<void> {
    // The SDK's WSClient doesn't currently expose a `.stop()` method in its
    // public types — it tears down on process exit. We null out our refs so
    // re-init works; the underlying socket gets garbage-collected.
    transportOwner["wsClient"] = null;
    transportOwner["client"] = null;
    transportOwner["connected"] = false;
    transportOwner["sentMsgTypes"].clear();
}
