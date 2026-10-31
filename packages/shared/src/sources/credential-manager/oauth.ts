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
import { inferGoogleServiceFromUrl, inferSlackServiceFromUrl, inferMicrosoftServiceFromUrl, type LoadedSource, type GoogleService, type MicrosoftService } from "../types.ts";
import { CraftOAuth, prepareMcpOAuth, exchangeMcpOAuth, type OAuthCallbacks } from "../../auth/oauth.ts";
import { type OAuthSessionContext } from "../../auth/types.ts";
import { OAUTH_RELAY_CALLBACK_URL, wrapPreparedOAuthFlowForRelay } from "../../auth/oauth-relay.ts";
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthExchangeResult, OAuthProvider } from "../../auth/oauth-flow-types.ts";
import { prepareGoogleOAuth, exchangeGoogleOAuth } from "../../auth/google-oauth.ts";
import { prepareSlackOAuth, exchangeSlackOAuth } from "../../auth/slack-oauth.ts";
import { prepareMicrosoftOAuth, exchangeMicrosoftOAuth } from "../../auth/microsoft-oauth.ts";
import { prepareGenericOAuth, exchangeGenericOAuth } from "../../auth/generic-oauth.ts";
import { debug } from "../../utils/debug.ts";
import { markSourceAuthenticated } from "../storage.ts";
import type { SourceCredentialManager } from '../credential-manager.ts';
import type { AuthResult } from './shared.ts';

export async function prepareOAuth(transportOwner: SourceCredentialManager, source: LoadedSource, options: {
    callbackPort?: number;
    callbackUrl?: string;
}): Promise<PreparedOAuthFlow> {
    const { callbackPort } = options;
    const relayReturnTo = options.callbackUrl;
    // When callbackUrl is provided (WebUI), keep the provider-facing redirect_uri
    // stable so providers like Google only need a single registered callback.
    // The relay unwraps the real server callback target from the outer state.
    const providerCallbackUrl = relayReturnTo
        ? OAUTH_RELAY_CALLBACK_URL
        : undefined;
    const provider = transportOwner["detectProvider"](source);
    let prepared: PreparedOAuthFlow;
    switch (provider) {
        case 'google': {
            const api = source.config.api;
            let service: GoogleService | undefined;
            let scopes: string[] | undefined;
            if (api?.googleScopes && api.googleScopes.length > 0) {
                scopes = api.googleScopes;
            }
            else if (api?.googleService) {
                service = api.googleService;
            }
            else {
                service = inferGoogleServiceFromUrl(api?.baseUrl);
                if (!service) {
                    throw new Error(`Cannot determine Google service for source '${source.config.slug}'. ` +
                        `Set googleService in api config.`);
                }
            }
            prepared = prepareGoogleOAuth({
                ...(service !== undefined ? { service } : {}),
                ...(scopes !== undefined ? { scopes } : {}),
                ...(callbackPort !== undefined ? { callbackPort } : {}),
                ...(providerCallbackUrl !== undefined ? { callbackUrl: providerCallbackUrl } : {}),
                ...(api?.googleOAuthClientId !== undefined ? { clientId: api?.googleOAuthClientId } : {}),
                ...(api?.googleOAuthClientSecret !== undefined ? { clientSecret: api?.googleOAuthClientSecret } : {}),
            });
            break;
        }
        case 'slack': {
            const api = source.config.api;
            let service: import("../types.ts").SlackService | undefined;
            let userScopes: string[] | undefined;
            if (api?.slackUserScopes && api.slackUserScopes.length > 0) {
                userScopes = api.slackUserScopes;
            }
            else if (api?.slackService) {
                service = api.slackService;
            }
            else {
                service = inferSlackServiceFromUrl(api?.baseUrl) || 'full';
            }
            prepared = prepareSlackOAuth({ ...(service !== undefined ? { service } : {}), ...(userScopes !== undefined ? { userScopes } : {}), ...(callbackPort !== undefined ? { callbackPort } : {}), ...(providerCallbackUrl !== undefined ? { callbackUrl: providerCallbackUrl } : {}) });
            break;
        }
        case 'microsoft': {
            const api = source.config.api;
            let service: MicrosoftService | undefined;
            let scopes: string[] | undefined;
            if (api?.microsoftScopes && api.microsoftScopes.length > 0) {
                scopes = api.microsoftScopes;
            }
            else if (api?.microsoftService) {
                service = api.microsoftService;
            }
            else {
                service = inferMicrosoftServiceFromUrl(api?.baseUrl);
                if (!service) {
                    throw new Error(`Cannot determine Microsoft service for source '${source.config.slug}'. ` +
                        `Set microsoftService in api config.`);
                }
            }
            prepared = prepareMicrosoftOAuth({ ...(service !== undefined ? { service } : {}), ...(scopes !== undefined ? { scopes } : {}), ...(callbackPort !== undefined ? { callbackPort } : {}), ...(providerCallbackUrl !== undefined ? { callbackUrl: providerCallbackUrl } : {}) });
            break;
        }
        case 'generic': {
            const oauthConfig = source.config.api?.oauth;
            if (oauthConfig) {
                // Static config: endpoints provided in config.json
                prepared = prepareGenericOAuth({ oauthConfig, ...(callbackPort !== undefined ? { callbackPort } : {}), ...(providerCallbackUrl !== undefined ? { callbackUrl: providerCallbackUrl } : {}) });
            }
            else {
                // Auto-discovery: hit baseUrl, discover OAuth metadata via RFC 9728/8414,
                // dynamically register a client — same flow as MCP OAuth.
                const baseUrl = source.config.api?.baseUrl;
                if (!baseUrl) {
                    throw new Error(`Source '${source.config.slug}' missing api.baseUrl for OAuth discovery`);
                }
                prepared = await prepareMcpOAuth(baseUrl, { ...(callbackPort !== undefined ? { callbackPort } : {}), ...(providerCallbackUrl !== undefined ? { callbackUrl: providerCallbackUrl } : {}) });
                // Relabel as generic (discovery used MCP internals but this is an API source)
                prepared = { ...prepared, provider: 'generic' };
            }
            break;
        }
        case 'mcp': {
            if (!source.config.mcp?.url) {
                throw new Error('MCP URL not configured');
            }
            prepared = await prepareMcpOAuth(source.config.mcp.url, { ...(callbackPort !== undefined ? { callbackPort } : {}), ...(providerCallbackUrl !== undefined ? { callbackUrl: providerCallbackUrl } : {}) });
            break;
        }
    }
    return relayReturnTo
        ? wrapPreparedOAuthFlowForRelay(prepared, relayReturnTo)
        : prepared;
}

export async function exchangeAndStore(transportOwner: SourceCredentialManager, source: LoadedSource, provider: OAuthProvider, params: OAuthExchangeParams): Promise<AuthResult> {
    let result: OAuthExchangeResult;
    switch (provider) {
        case 'google':
            result = await exchangeGoogleOAuth(params);
            break;
        case 'slack':
            result = await exchangeSlackOAuth(params);
            break;
        case 'microsoft':
            result = await exchangeMicrosoftOAuth(params);
            break;
        case 'generic':
            result = await exchangeGenericOAuth(params);
            break;
        case 'mcp':
            result = await exchangeMcpOAuth(params);
            break;
    }
    if (!result.success) {
        return { success: false, ...(result.error !== undefined ? { error: result.error } : {}) };
    }
    // Save credentials
    await transportOwner["save"](source, {
        value: result.accessToken!,
        ...(result.refreshToken !== undefined ? { refreshToken: result.refreshToken } : {}),
        ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
        ...(result.oauthClientId !== undefined ? { clientId: result.oauthClientId } : {}),
        ...(result.oauthClientSecret !== undefined ? { clientSecret: result.oauthClientSecret } : {}),
    });
    // Mark source as authenticated in config.json
    markSourceAuthenticated(source.workspaceRootPath, source.config.slug);
    debug(`[SourceCredentialManager] OAuth exchange+store complete for ${source.config.slug}`);
    return { success: true, ...(result.email !== undefined ? { email: result.email } : {}) };
}

export async function authenticate(transportOwner: SourceCredentialManager, source: LoadedSource, callbacks?: OAuthCallbacks, sessionContext?: OAuthSessionContext): Promise<AuthResult> {
    const defaultCallbacks: OAuthCallbacks = {
        onStatus: (msg) => debug(`[SourceCredentialManager] ${msg}`),
        onError: (err) => debug(`[SourceCredentialManager] Error: ${err}`),
    };
    const cb = callbacks || defaultCallbacks;
    // Google APIs use Google OAuth
    if (source.config.provider === 'google') {
        return transportOwner.authenticateGoogle(source, cb, sessionContext);
    }
    // Slack APIs use Slack OAuth
    if (source.config.provider === 'slack') {
        return transportOwner.authenticateSlack(source, cb, sessionContext);
    }
    // Microsoft APIs use Microsoft OAuth
    if (source.config.provider === 'microsoft') {
        return transportOwner.authenticateMicrosoft(source, cb, sessionContext);
    }
    // Generic OAuth (explicit config or auto-discovery from baseUrl)
    if (source.config.api?.authType === 'oauth') {
        return transportOwner.authenticateGeneric(source, cb, sessionContext);
    }
    // MCP OAuth flow
    if (source.config.type === 'mcp' && source.config.mcp?.authType === 'oauth') {
        return transportOwner.authenticateMcp(source, cb, sessionContext);
    }
    return {
        success: false,
        error: `Source ${source.config.slug} does not use OAuth authentication`,
    };
}

/**
   * Authenticate MCP source via OAuth
   */
export async function authenticateMcp(transportOwner: SourceCredentialManager, source: LoadedSource, callbacks: OAuthCallbacks, sessionContext?: OAuthSessionContext): Promise<AuthResult> {
    if (!source.config.mcp?.url) {
        return { success: false, error: 'MCP URL not configured' };
    }
    try {
        const oauth = new CraftOAuth({ mcpUrl: source.config.mcp.url }, callbacks, sessionContext);
        const { tokens, clientId } = await oauth.authenticate();
        // Save the credentials
        await transportOwner["save"](source, {
            value: tokens.accessToken,
            ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
            ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
            clientId,
            tokenType: tokens.tokenType,
        });
        // Mark source as authenticated in config.json
        markSourceAuthenticated(source.workspaceRootPath, source.config.slug);
        return { success: true };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        callbacks.onError(message);
        return { success: false, error: message };
    }
}
