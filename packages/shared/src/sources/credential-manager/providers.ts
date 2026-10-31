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
import { inferGoogleServiceFromUrl, inferSlackServiceFromUrl, inferMicrosoftServiceFromUrl, type LoadedSource, type GoogleService, type SlackService, type MicrosoftService } from "../types.ts";
import { type OAuthCallbacks } from "../../auth/oauth.ts";
import { type OAuthSessionContext } from "../../auth/types.ts";
import { startGoogleOAuth, type GoogleOAuthResult, type GoogleOAuthOptions } from "../../auth/google-oauth.ts";
import { startSlackOAuth, type SlackOAuthResult, type SlackOAuthOptions } from "../../auth/slack-oauth.ts";
import { startMicrosoftOAuth, type MicrosoftOAuthResult, type MicrosoftOAuthOptions } from "../../auth/microsoft-oauth.ts";
import { markSourceAuthenticated } from "../storage.ts";
import type { SourceCredentialManager } from '../credential-manager.ts';
import type { AuthResult } from './shared.ts';

/**
   * Authenticate Google API source via Google OAuth
   *
   * Supports multiple Google services (Gmail, Calendar, Drive) via:
   * - provider: "google" with googleService field
   * - provider: "google" with custom googleScopes
   * - Inferred from baseUrl (e.g., gmail.googleapis.com → gmail)
   */
export async function authenticateGoogle(transportOwner: SourceCredentialManager, source: LoadedSource, callbacks: OAuthCallbacks, sessionContext?: OAuthSessionContext): Promise<AuthResult> {
    try {
        // Determine service/scopes from config
        const api = source.config.api;
        let service: GoogleService | undefined;
        let scopes: string[] | undefined;
        if (api?.googleScopes && api.googleScopes.length > 0) {
            // Custom scopes take precedence
            scopes = api.googleScopes;
        }
        else if (api?.googleService) {
            // Use predefined service scopes
            service = api.googleService;
        }
        else {
            // Infer from baseUrl
            service = inferGoogleServiceFromUrl(api?.baseUrl);
            if (!service) {
                return {
                    success: false,
                    error: `Cannot determine Google service for source '${source.config.slug}'. Set googleService ('gmail', 'calendar', 'drive', 'docs', 'sheets', 'youtube', or 'searchconsole') in api config.`,
                };
            }
        }
        const serviceName = service || 'Google API';
        callbacks.onStatus(`Starting ${serviceName} OAuth flow...`);
        const options: GoogleOAuthOptions = {
            ...(service !== undefined ? { service } : {}),
            ...(scopes !== undefined ? { scopes } : {}),
            appType: 'electron',
            // Pass user-provided OAuth credentials from source config (if available)
            ...(api?.googleOAuthClientId !== undefined ? { clientId: api?.googleOAuthClientId } : {}),
            ...(api?.googleOAuthClientSecret !== undefined ? { clientSecret: api?.googleOAuthClientSecret } : {}),
            ...(sessionContext !== undefined ? { sessionContext } : {}),
        };
        const result: GoogleOAuthResult = await startGoogleOAuth(options);
        if (!result.success) {
            return { success: false, error: result.error || 'Google OAuth failed' };
        }
        // Save the credentials (including clientId/clientSecret for token refresh)
        await transportOwner["save"](source, {
            value: result.accessToken!,
            ...(result.refreshToken !== undefined ? { refreshToken: result.refreshToken } : {}),
            ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
            ...(result.clientId !== undefined ? { clientId: result.clientId } : {}),
            ...(result.clientSecret !== undefined ? { clientSecret: result.clientSecret } : {}),
        });
        // Mark source as authenticated in config.json
        markSourceAuthenticated(source.workspaceRootPath, source.config.slug);
        callbacks.onStatus(`${serviceName} authentication successful`);
        return { success: true, ...(result.email !== undefined ? { email: result.email } : {}) };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        callbacks.onError(message);
        return { success: false, error: message };
    }
}

/**
   * Authenticate Slack API source via Slack OAuth
   *
   * Supports multiple Slack services via:
   * - provider: "slack" with slackService field
   * - provider: "slack" with custom slackBotScopes/slackUserScopes
   * - Inferred from baseUrl (slack.com → full)
   */
export async function authenticateSlack(transportOwner: SourceCredentialManager, source: LoadedSource, callbacks: OAuthCallbacks, sessionContext?: OAuthSessionContext): Promise<AuthResult> {
    try {
        // Determine service/scopes from config
        const api = source.config.api;
        let service: SlackService | undefined;
        let userScopes: string[] | undefined;
        if (api?.slackUserScopes && api.slackUserScopes.length > 0) {
            // Custom scopes take precedence
            userScopes = api.slackUserScopes;
        }
        else if (api?.slackService) {
            // Use predefined service scopes
            service = api.slackService;
        }
        else {
            // Infer from baseUrl (defaults to 'full')
            service = inferSlackServiceFromUrl(api?.baseUrl) || 'full';
        }
        const serviceName = service ? `Slack ${service}` : 'Slack';
        callbacks.onStatus(`Starting ${serviceName} OAuth flow...`);
        const options: SlackOAuthOptions = {
            ...(service !== undefined ? { service } : {}),
            ...(userScopes !== undefined ? { userScopes } : {}),
            appType: 'electron',
            ...(sessionContext !== undefined ? { sessionContext } : {}),
        };
        const result: SlackOAuthResult = await startSlackOAuth(options);
        if (!result.success) {
            return { success: false, error: result.error || 'Slack OAuth failed' };
        }
        // Save the credentials
        await transportOwner["save"](source, {
            value: result.accessToken!,
            ...(result.refreshToken !== undefined ? { refreshToken: result.refreshToken } : {}),
            ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
        });
        // Mark source as authenticated in config.json
        markSourceAuthenticated(source.workspaceRootPath, source.config.slug);
        callbacks.onStatus(`${serviceName} authentication successful`);
        // Use teamName as the identifier (similar to email for Google)
        return { success: true, ...(result.teamName !== undefined ? { email: result.teamName } : {}) };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        callbacks.onError(message);
        return { success: false, error: message };
    }
}

/**
   * Authenticate Microsoft API source via Microsoft OAuth
   *
   * Supports multiple Microsoft services (Outlook, OneDrive, Calendar, Teams) via:
   * - provider: "microsoft" with microsoftService field
   * - provider: "microsoft" with custom microsoftScopes
   * - Inferred from baseUrl (e.g., graph.microsoft.com → outlook)
   */
export async function authenticateMicrosoft(transportOwner: SourceCredentialManager, source: LoadedSource, callbacks: OAuthCallbacks, sessionContext?: OAuthSessionContext): Promise<AuthResult> {
    try {
        // Determine service/scopes from config
        const api = source.config.api;
        let service: MicrosoftService | undefined;
        let scopes: string[] | undefined;
        if (api?.microsoftScopes && api.microsoftScopes.length > 0) {
            // Custom scopes take precedence
            scopes = api.microsoftScopes;
        }
        else if (api?.microsoftService) {
            // Use predefined service scopes
            service = api.microsoftService;
        }
        else {
            // Infer from baseUrl
            service = inferMicrosoftServiceFromUrl(api?.baseUrl);
            if (!service) {
                return {
                    success: false,
                    error: `Cannot determine Microsoft service for source '${source.config.slug}'. Set microsoftService ('outlook', 'calendar', 'onedrive', 'teams', or 'sharepoint') in api config.`,
                };
            }
        }
        const serviceName = service || 'Microsoft API';
        callbacks.onStatus(`Starting ${serviceName} OAuth flow...`);
        const options: MicrosoftOAuthOptions = {
            ...(service !== undefined ? { service } : {}),
            ...(scopes !== undefined ? { scopes } : {}),
            appType: 'electron',
            ...(sessionContext !== undefined ? { sessionContext } : {}),
        };
        const result: MicrosoftOAuthResult = await startMicrosoftOAuth(options);
        if (!result.success) {
            return { success: false, error: result.error || 'Microsoft OAuth failed' };
        }
        // Save the credentials
        await transportOwner["save"](source, {
            value: result.accessToken!,
            ...(result.refreshToken !== undefined ? { refreshToken: result.refreshToken } : {}),
            ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
        });
        // Mark source as authenticated in config.json
        markSourceAuthenticated(source.workspaceRootPath, source.config.slug);
        callbacks.onStatus(`${serviceName} authentication successful`);
        return { success: true, ...(result.email !== undefined ? { email: result.email } : {}) };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        callbacks.onError(message);
        return { success: false, error: message };
    }
}

/**
   * Authenticate source via generic OAuth flow (CLI/test convenience wrapper).
   * Note: The session-based UI flow goes through prepareOAuth() + exchangeAndStore() instead.
   */
export async function authenticateGeneric(_transportOwner: SourceCredentialManager, source: LoadedSource, _cb: OAuthCallbacks, _sessionContext?: OAuthSessionContext): Promise<AuthResult> {
    const oauthConfig = source.config.api?.oauth;
    if (!oauthConfig) {
        return { success: false, error: 'Source missing api.oauth config block' };
    }
    // CLI generic OAuth is not yet implemented — the desktop app handles this
    // through the source_oauth_trigger → prepareOAuth → exchangeAndStore pipeline.
    return { success: false, error: 'Generic OAuth CLI flow not supported — use the desktop app or source_oauth_trigger tool' };
}
