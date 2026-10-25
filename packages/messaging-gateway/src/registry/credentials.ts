/**
 * MessagingGatewayRegistry — owns per-workspace MessagingGateway instances.
 *
 * Responsibilities:
 *   - Satisfies IMessagingGatewayRegistry for the RPC handlers in server-core.
 *   - Acts as a single EventSink consumer fanning session events to the right gateway.
 *   - Owns the in-memory pairing code manager (shared across workspaces; codes are workspace-scoped).
 *   - Owns per-workspace MessagingConfig (messaging/config.json).
 *   - Owns platform adapter lifecycle (initialize/swap/destroy) via CredentialManager.
 *
 * The registry is constructed once, wired into HandlerDeps, then populated with
 * gateways via initializeWorkspace() for every workspace that has messaging enabled.
 */
import { rmSync } from "node:fs";
import { type LarkCredentials } from "../adapters/lark/index";
import type { MessagingGatewayRegistry } from '../registry.ts';
import { isKnownPlatform, fetchTelegramBotInfo } from './shared.ts';

export async function testTelegramToken(transportOwner: MessagingGatewayRegistry, token: string): Promise<{
    success: boolean;
    botName?: string;
    botUsername?: string;
    error?: string;
}> {
    if (!token || token.trim().length === 0) {
        return { success: false, error: 'Token is empty' };
    }
    try {
        const info = await fetchTelegramBotInfo(token.trim());
        if (!info.ok) {
            return { success: false, error: info.description ?? 'Invalid token' };
        }
        return {
            success: true,
            botName: info.result.first_name ?? info.result.username ?? 'bot',
            botUsername: info.result.username,
        };
    }
    catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : 'Network error',
        };
    }
}

export async function saveTelegramToken(transportOwner: MessagingGatewayRegistry, workspaceId: string, token: string): Promise<void> {
    const trimmed = token.trim();
    if (!trimmed)
        throw new Error('Token is empty');
    const test = await transportOwner["testTelegramToken"](trimmed);
    if (!test.success)
        throw new Error(test.error ?? 'Invalid token');
    await transportOwner["opts"].credentialManager.set({
        type: 'messaging_bearer',
        workspaceId,
        name: 'telegram',
    }, { value: trimmed });
    const state = transportOwner["workspaces"].get(workspaceId) ?? transportOwner["bootstrapWorkspace"](workspaceId);
    // Critical: must NOT replace platforms.telegram with `{ enabled: true }`
    // — that would wipe owners / accessMode / supergroup. Patch only the
    // `enabled` flag and let everything else survive.
    transportOwner["patchTelegramConfig"](workspaceId, { enabled: true }, { ensureMessagingEnabled: true });
    transportOwner["setPlatformRuntime"](workspaceId, state, 'telegram', {
        configured: true,
        connected: false,
        state: 'connecting',
        lastError: undefined,
    });
    await transportOwner["tryConnectTelegram"](workspaceId, state);
    await state.gateway.start();
}

export async function testLarkCredentials(transportOwner: MessagingGatewayRegistry, creds: LarkCredentials): Promise<{
    success: boolean;
    botName?: string;
    error?: string;
}> {
    if (!creds.appId || !creds.appSecret) {
        return { success: false, error: 'App ID or App Secret is empty' };
    }
    try {
        const url = creds.domain === 'feishu'
            ? 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'
            : 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal';
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
        });
        const body = (await res.json()) as {
            code?: number;
            msg?: string;
            tenant_access_token?: string;
        };
        if (body.code !== 0 || !body.tenant_access_token) {
            return { success: false, error: body.msg ?? 'Invalid credentials' };
        }
        return { success: true };
    }
    catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : 'Network error',
        };
    }
}

export async function saveLarkCredentials(transportOwner: MessagingGatewayRegistry, workspaceId: string, creds: LarkCredentials): Promise<void> {
    if (!creds.appId || !creds.appSecret)
        throw new Error('App ID or App Secret is empty');
    if (creds.domain !== 'lark' && creds.domain !== 'feishu') {
        throw new Error('Domain must be "lark" or "feishu"');
    }
    const test = await transportOwner["testLarkCredentials"](creds);
    if (!test.success)
        throw new Error(test.error ?? 'Invalid Lark credentials');
    await transportOwner["opts"].credentialManager.set({
        type: 'messaging_bearer',
        workspaceId,
        name: 'lark',
    }, { value: JSON.stringify(creds) });
    const state = transportOwner["workspaces"].get(workspaceId) ?? transportOwner["bootstrapWorkspace"](workspaceId);
    state.configStore.update({
        enabled: true,
        platforms: { lark: { enabled: true, domain: creds.domain } },
    });
    transportOwner["setPlatformRuntime"](workspaceId, state, 'lark', {
        configured: true,
        connected: false,
        state: 'connecting',
        lastError: undefined,
    });
    await transportOwner["tryConnectLark"](workspaceId, state);
    await state.gateway.start();
}

export async function disconnectPlatform(transportOwner: MessagingGatewayRegistry, workspaceId: string, platform: string): Promise<void> {
    if (!isKnownPlatform(platform))
        return;
    const state = transportOwner["workspaces"].get(workspaceId);
    if (!state)
        return;
    if (platform === 'whatsapp') {
        state.whatsappOffEvent?.();
        state.whatsappOffEvent = undefined;
        if (state.whatsapp) {
            await state.whatsapp.destroy().catch(() => { });
            state.whatsapp = null;
        }
    }
    await state.gateway.unregisterAdapter(platform).catch(() => { });
    state.botUsernames[platform] = undefined;
    transportOwner["pairing"].clearWorkspace(workspaceId);
    // Preserve per-platform fields (owners / accessMode / supergroup for
    // telegram, selfChatMode for whatsapp, domain for lark) so reconnecting
    // doesn't surprise the operator with a reset to public. Use
    // `forgetPlatform` for the full wipe.
    const currentConfig = state.configStore.get();
    const currentPlatformConfig = currentConfig.platforms[platform] ?? { enabled: true };
    const nextPlatforms = {
        ...currentConfig.platforms,
        [platform]: { ...currentPlatformConfig, enabled: false },
    };
    const anyPlatformEnabled = Object.values(nextPlatforms).some((entry) => entry?.enabled);
    state.configStore.update({
        enabled: anyPlatformEnabled,
        platforms: nextPlatforms,
    });
    if (platform !== 'whatsapp') {
        await transportOwner["opts"].credentialManager
            .delete({ type: 'messaging_bearer', workspaceId, name: platform })
            .catch(() => { });
    }
    transportOwner["setPlatformRuntime"](workspaceId, state, platform, {
        configured: false,
        connected: false,
        state: 'disconnected',
        identity: undefined,
        lastError: undefined,
    });
}

export async function forgetPlatform(transportOwner: MessagingGatewayRegistry, workspaceId: string, platform: string): Promise<void> {
    if (!isKnownPlatform(platform))
        return;
    await transportOwner["disconnectPlatform"](workspaceId, platform);
    if (platform === 'whatsapp') {
        const authDir = transportOwner["getWhatsAppAuthStateDir"](workspaceId);
        try {
            rmSync(authDir, { recursive: true, force: true });
            transportOwner["log"].info('forgot WhatsApp auth state', {
                event: 'whatsapp_auth_forgotten',
                workspaceId,
                authDir,
            });
        }
        catch (err) {
            transportOwner["log"].error('failed to forget WhatsApp auth state', {
                event: 'whatsapp_auth_forget_failed',
                workspaceId,
                authDir,
                error: err,
            });
            throw err;
        }
    }
}
