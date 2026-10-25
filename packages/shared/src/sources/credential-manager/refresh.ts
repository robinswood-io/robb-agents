/**
 * SourceCredentialManager
 *
 * Unified credential management for sources. Consolidates credential CRUD,
 * credential ID resolution, expiry checking, and OAuth flows.
 *
 * This replaces scattered credential logic across:
 * - SourceService.getSourceToken()
 * - SourceService.getApiCredential()
 * - SourceService.getCredentialId()
 * - session-scoped-tools OAuth triggers
 * - IPC handlers for credential storage
 */
import { hasRenewEndpoint, type LoadedSource } from "../types.ts";
import { buildAuthorizationHeader } from "../api-tools.ts";
import type { StoredCredential } from "../../credentials/types.ts";
import { CraftOAuth } from "../../auth/oauth.ts";
import { refreshGoogleToken } from "../../auth/google-oauth.ts";
import { refreshSlackToken } from "../../auth/slack-oauth.ts";
import { refreshMicrosoftToken } from "../../auth/microsoft-oauth.ts";
import { refreshGenericOAuthToken } from "../../auth/generic-oauth.ts";
import { debug } from "../../utils/debug.ts";
import type { SourceCredentialManager } from '../credential-manager.ts';
import { substituteTokenInBody, substituteTokenInHeaders } from './shared.ts';

export async function refresh(transportOwner: SourceCredentialManager, source: LoadedSource): Promise<string | null> {
    const key = source.config.slug;
    // Return existing refresh promise if one is in progress
    const pending = transportOwner["pendingRefreshes"].get(key);
    if (pending) {
        debug(`[SourceCredentialManager] Reusing pending refresh for ${key}`);
        return pending;
    }
    // Create and track new refresh promise
    const refreshPromise = transportOwner["doRefresh"](source).finally(() => {
        transportOwner["pendingRefreshes"].delete(key);
    });
    transportOwner["pendingRefreshes"].set(key, refreshPromise);
    return refreshPromise;
}

/**
   * Internal refresh implementation
   */
export async function doRefresh(transportOwner: SourceCredentialManager, source: LoadedSource): Promise<string | null> {
    const cred = await transportOwner["load"](source);
    if (!cred) {
        debug(`[SourceCredentialManager] No credential for ${source.config.slug}`);
        return null;
    }
    // API renew endpoint (non-OAuth token refresh) — check before provider routing.
    // These sources may not have a separate refreshToken; they use the current
    // access token for renewal.
    if (hasRenewEndpoint(source)) {
        return transportOwner["refreshApiRenew"](source, cred);
    }
    // For all other refresh strategies, a refreshToken is required.
    if (!cred.refreshToken) {
        debug(`[SourceCredentialManager] No refresh token for ${source.config.slug}`);
        return null;
    }
    // Google API refresh
    if (source.config.provider === 'google') {
        return transportOwner["refreshGoogle"](source, cred);
    }
    // Slack API refresh
    if (source.config.provider === 'slack') {
        return transportOwner["refreshSlack"](source, cred);
    }
    // Microsoft API refresh
    if (source.config.provider === 'microsoft') {
        return transportOwner["refreshMicrosoft"](source, cred);
    }
    // Generic OAuth refresh
    if (source.config.api?.authType === 'oauth') {
        if (source.config.api?.oauth?.tokenUrl) {
            // Static config: tokenUrl from config.json
            return transportOwner["refreshGeneric"](source, cred);
        }
        // Auto-discovered: re-discover token endpoint from baseUrl via MCP OAuth refresh
        if (source.config.api?.baseUrl && cred.clientId) {
            return transportOwner["refreshMcp"]({ ...source, config: { ...source.config, type: 'mcp', mcp: { url: source.config.api.baseUrl, authType: 'oauth' } } }, cred);
        }
        return null;
    }
    // MCP refresh
    if (source.config.type === 'mcp' && source.config.mcp?.url) {
        return transportOwner["refreshMcp"](source, cred);
    }
    return null;
}

/**
   * Refresh token via a custom API renew endpoint (non-OAuth).
   * Uses the current access token for renewal — no separate refresh token needed.
   */
export async function refreshApiRenew(transportOwner: SourceCredentialManager, source: LoadedSource, cred: StoredCredential): Promise<string | null> {
    const renewConfig = source.config.api?.renewEndpoint;
    if (!renewConfig?.path)
        return null;
    const baseUrl = source.config.api!.baseUrl;
    const authScheme = source.config.api!.authScheme;
    const currentToken = cred.value;
    try {
        // 1. Resolve URL
        const url = renewConfig.path.startsWith('http')
            ? renewConfig.path
            : new URL(renewConfig.path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
        // 2. Build headers: defaultHeaders < renewEndpoint.headers < Authorization
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...source.config.api!.defaultHeaders,
            ...substituteTokenInHeaders(renewConfig.headers, currentToken),
        };
        // Add Authorization unless explicitly overridden in renewEndpoint.headers
        if (!renewConfig.headers?.['Authorization'] && !renewConfig.headers?.['authorization']) {
            headers['Authorization'] = buildAuthorizationHeader(authScheme, currentToken);
        }
        // 3. Build body with {{token}} substitution
        const method = renewConfig.method ?? 'POST';
        const fetchOptions: RequestInit = { method, headers };
        if (renewConfig.body && method !== 'GET') {
            fetchOptions.body = JSON.stringify(substituteTokenInBody(renewConfig.body, currentToken));
        }
        // 4. Execute
        const response = await fetch(url, fetchOptions);
        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(`Renew endpoint returned ${response.status}: ${errorText.slice(0, 200)}`);
        }
        const json = await response.json() as Record<string, unknown>;
        // 5. Extract new token
        const tokenField = renewConfig.tokenField ?? 'access_token';
        const newToken = json[tokenField];
        if (typeof newToken !== 'string' || !newToken) {
            throw new Error(`Renew response missing "${tokenField}" field`);
        }
        // 6. Extract expiry
        const expiresInField = renewConfig.expiresInField ?? 'expires_in';
        const expiresInRaw = json[expiresInField];
        let expiresAt: number | undefined;
        if (typeof expiresInRaw === 'number' && expiresInRaw > 0) {
            expiresAt = Date.now() + expiresInRaw * 1000;
        }
        else if (renewConfig.fallbackTtlSecs) {
            expiresAt = Date.now() + renewConfig.fallbackTtlSecs * 1000;
        }
        // If neither is available, expiresAt stays undefined — needsRefresh() will
        // trigger refresh on next session start (safe but noisy).
        // 7. Save updated credential
        await transportOwner["save"](source, {
            ...cred,
            value: newToken,
            ...(expiresAt !== undefined ? { expiresAt } : {}),
        });
        debug(`[SourceCredentialManager] Refreshed token via renew endpoint for ${source.config.slug}`);
        return newToken;
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        debug(`[SourceCredentialManager] Renew endpoint refresh failed for ${source.config.slug}:`, error);
        transportOwner["markSourceNeedsReauth"](source, `Token refresh failed: ${errorMsg}`);
        return null;
    }
}

/**
   * Refresh Google OAuth token
   */
export async function refreshGoogle(transportOwner: SourceCredentialManager, source: LoadedSource, cred: StoredCredential): Promise<string | null> {
    try {
        // Pass stored credentials (or fall back to env vars via undefined)
        const result = await refreshGoogleToken(cred.refreshToken!, cred.clientId, cred.clientSecret);
        // Update stored credentials
        await transportOwner["save"](source, {
            ...cred,
            value: result.accessToken,
            expiresAt: result.expiresAt,
        });
        debug(`[SourceCredentialManager] Refreshed Google token for ${source.config.slug}`);
        return result.accessToken;
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        debug(`[SourceCredentialManager] Google token refresh failed:`, error);
        transportOwner["markSourceNeedsReauth"](source, `Token refresh failed: ${errorMsg}`);
        return null;
    }
}

/**
   * Refresh Slack OAuth token
   */
export async function refreshSlack(transportOwner: SourceCredentialManager, source: LoadedSource, cred: StoredCredential): Promise<string | null> {
    try {
        const result = await refreshSlackToken(cred.refreshToken!, cred.clientId);
        // Update stored credentials
        await transportOwner["save"](source, {
            ...cred,
            value: result.accessToken,
            expiresAt: result.expiresAt,
        });
        debug(`[SourceCredentialManager] Refreshed Slack token for ${source.config.slug}`);
        return result.accessToken;
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        debug(`[SourceCredentialManager] Slack token refresh failed:`, error);
        transportOwner["markSourceNeedsReauth"](source, `Token refresh failed: ${errorMsg}`);
        return null;
    }
}

/**
   * Refresh Microsoft OAuth token
   */
export async function refreshMicrosoft(transportOwner: SourceCredentialManager, source: LoadedSource, cred: StoredCredential): Promise<string | null> {
    try {
        const result = await refreshMicrosoftToken(cred.refreshToken!);
        // Update stored credentials (Microsoft may rotate refresh tokens)
        await transportOwner["save"](source, {
            ...cred,
            value: result.accessToken,
            refreshToken: result.refreshToken || cred.refreshToken,
            expiresAt: result.expiresAt,
        });
        debug(`[SourceCredentialManager] Refreshed Microsoft token for ${source.config.slug}`);
        return result.accessToken;
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        debug(`[SourceCredentialManager] Microsoft token refresh failed:`, error);
        transportOwner["markSourceNeedsReauth"](source, `Token refresh failed: ${errorMsg}`);
        return null;
    }
}

/**
   * Refresh generic OAuth token.
   * tokenUrl from source config, clientId/clientSecret from stored credential falling back to config.
   */
export async function refreshGeneric(transportOwner: SourceCredentialManager, source: LoadedSource, cred: StoredCredential): Promise<string | null> {
    const oauthConfig = source.config.api?.oauth;
    if (!oauthConfig?.tokenUrl) {
        debug(`[SourceCredentialManager] No tokenUrl in config for generic OAuth refresh`);
        transportOwner["markSourceNeedsReauth"](source, 'Missing tokenUrl in api.oauth config');
        return null;
    }
    try {
        const result = await refreshGenericOAuthToken(cred.refreshToken!, oauthConfig.tokenUrl, cred.clientId || oauthConfig.clientId, cred.clientSecret || oauthConfig.clientSecret);
        await transportOwner["save"](source, {
            ...cred,
            value: result.accessToken,
            refreshToken: result.refreshToken || cred.refreshToken,
            expiresAt: result.expiresAt,
        });
        debug(`[SourceCredentialManager] Refreshed generic OAuth token for ${source.config.slug}`);
        return result.accessToken;
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        debug(`[SourceCredentialManager] Generic OAuth token refresh failed:`, error);
        transportOwner["markSourceNeedsReauth"](source, `Token refresh failed: ${errorMsg}`);
        return null;
    }
}

/**
   * Refresh MCP OAuth token
   */
export async function refreshMcp(transportOwner: SourceCredentialManager, source: LoadedSource, cred: StoredCredential): Promise<string | null> {
    if (!cred.clientId) {
        debug(`[SourceCredentialManager] No clientId for MCP token refresh`);
        transportOwner["markSourceNeedsReauth"](source, 'Missing clientId for token refresh');
        return null;
    }
    try {
        // Only remote transport can refresh tokens - stdio doesn't use OAuth
        if (!source.config.mcp?.url) {
            // This is expected for stdio transport - not an error
            debug(`[SourceCredentialManager] No URL for MCP token refresh (stdio transport)`);
            return null;
        }
        const oauth = new CraftOAuth({ mcpUrl: source.config.mcp.url }, {
            onStatus: () => { },
            onError: () => { },
        });
        const tokens = await oauth.refreshAccessToken(cred.refreshToken!, cred.clientId);
        // Update stored credentials
        await transportOwner["save"](source, {
            ...cred,
            value: tokens.accessToken,
            refreshToken: tokens.refreshToken || cred.refreshToken,
            expiresAt: tokens.expiresAt,
        });
        debug(`[SourceCredentialManager] Refreshed MCP token for ${source.config.slug}`);
        return tokens.accessToken;
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        debug(`[SourceCredentialManager] MCP token refresh failed:`, error);
        transportOwner["markSourceNeedsReauth"](source, `Token refresh failed: ${errorMsg}`);
        return null;
    }
}
