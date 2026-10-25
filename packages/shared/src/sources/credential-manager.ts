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
import { type LoadedSource } from "./types.ts";
import type { CredentialId, StoredCredential } from "../credentials/types.ts";
import { type OAuthCallbacks } from "../auth/oauth.ts";
import { type OAuthSessionContext } from "../auth/types.ts";
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthProvider } from "../auth/oauth-flow-types.ts";
import type { AuthResult, ApiCredential } from './credential-manager/shared.ts';
import * as credentialManagerStorage from './credential-manager/storage.ts';
import * as credentialManagerAccess from './credential-manager/access.ts';
import * as credentialManagerOauth from './credential-manager/oauth.ts';
import * as credentialManagerProviders from './credential-manager/providers.ts';
import * as credentialManagerRefresh from './credential-manager/refresh.ts';
export type { AuthResult, BasicAuthCredential, MultiHeaderCredential, ApiCredential } from './credential-manager/shared.ts';
export { isMultiHeaderCredential } from './credential-manager/shared.ts';

/**
 * SourceCredentialManager - unified credential operations for sources
 *
 * Usage:
 * ```typescript
 * const credManager = new SourceCredentialManager();
 *
 * // Save credentials
 * await credManager.save(source, { value: 'token123' });
 *
 * // Load credentials
 * const cred = await credManager.load(source);
 *
 * // Run OAuth flow
 * const result = await credManager.authenticate(source, {
 *   onStatus: (msg) => console.log(msg),
 *   onError: (err) => console.error(err),
 * });
 * ```
 */
export class SourceCredentialManager {
    // Track in-flight refresh promises to prevent concurrent refreshes for the same source
    // This prevents race conditions (especially important for Microsoft which rotates refresh tokens)
    private pendingRefreshes = new Map<string, Promise<string | null>>();
    // ============================================================
    // Core CRUD Operations
    // ============================================================
    /**
     * Save credential for a source
     */
    async save(source: LoadedSource, credential: StoredCredential): Promise<void> {
        return credentialManagerStorage.save(this, source, credential);
    }
    /**
     * Load credential for a source
     *
     * For MCP sources, tries both OAuth and bearer credentials as fallback
     * (credentials may have been stored via different auth modes)
     */
    async load(source: LoadedSource): Promise<StoredCredential | null> {
        return credentialManagerStorage.load(this, source);
    }
    /**
     * Load the effective credential together with the exact vault slot selected
     * by host fallback rules. Specialized-profile capability sealing consumes
     * only the opaque bindingId and slot, never credential material.
     */
    async loadWithIdentity(source: LoadedSource): Promise<{
        credential: StoredCredential;
        credentialId: CredentialId;
    } | null> {
        return credentialManagerStorage.loadWithIdentity(this, source);
    }
    private async loadMcpCredentialWithIdentity(source: LoadedSource): Promise<{
        credential: StoredCredential;
        credentialId: CredentialId;
    } | null> {
        return credentialManagerStorage.loadMcpCredentialWithIdentity(this, source);
    }
    /**
     * Delete credential for a source
     */
    async delete(source: LoadedSource): Promise<boolean> {
        return credentialManagerStorage.deleteOperation(this, source);
    }
    /**
     * Delete credential for a source synchronously.
     * Used by sync config-save paths to avoid stale credential reads on immediate reload.
     */
    deleteSync(source: LoadedSource): boolean {
        return credentialManagerStorage.deleteSync(this, source);
    }
    /**
     * Get token value for a source (convenience method)
     * Returns null if no credential exists or if expired
     */
    async getToken(source: LoadedSource): Promise<string | null> {
        return credentialManagerAccess.getToken(this, source);
    }
    /**
     * Get API credential for a source (handles basic auth and multi-header JSON parsing)
     */
    async getApiCredential(source: LoadedSource): Promise<ApiCredential | null> {
        return credentialManagerAccess.getApiCredential(this, source);
    }
    /** Load and parse one exact credential generation without a second vault read. */
    async getApiCredentialWithIdentity(source: LoadedSource): Promise<{
        credential: ApiCredential;
        bindingId?: string;
    } | null> {
        return credentialManagerAccess.getApiCredentialWithIdentity(this, source);
    }
    /**
     * Load one immutable runtime view from a single vault read. Governed Mission
     * builders use this object for both identity verification and secret injection
     * so a credential replacement cannot land between two reads.
     */
    async loadRuntimeCredentialSnapshot(source: LoadedSource): Promise<{
        stored: StoredCredential | null;
        credentialId: CredentialId | null;
        bindingId?: string;
        token: string | null;
        apiCredential: ApiCredential | null;
    }> {
        return credentialManagerStorage.loadRuntimeCredentialSnapshot(this, source);
    }
    private parseApiCredential(source: LoadedSource, cred: StoredCredential | null): ApiCredential | null {
        return credentialManagerAccess.parseApiCredential(this, source, cred);
    }
    // ============================================================
    // Credential ID Resolution
    // ============================================================
    /**
     * Get the credential ID for a source
     *
     * Determines the correct credential type based on:
     * - Source type (mcp, api, local)
     * - Auth type (oauth, bearer, header, etc.)
     */
    getCredentialId(source: LoadedSource): CredentialId {
        return credentialManagerAccess.getCredentialId(this, source);
    }
    // ============================================================
    // Expiry Checking
    // ============================================================
    /**
     * Check if a credential is expired
     */
    isExpired(credential: StoredCredential): boolean {
        return credentialManagerAccess.isExpired(this, credential);
    }
    /**
     * Check if a credential needs refresh (within 5 min of expiry)
     */
    needsRefresh(credential: StoredCredential): boolean {
        return credentialManagerAccess.needsRefresh(this, credential);
    }
    /**
     * Mark a source as needing re-authentication.
     * Called when token is missing/expired or token refresh fails.
     * Updates config.json so the UI shows "needs auth" and the agent gets proper context.
     */
    markSourceNeedsReauth(source: LoadedSource, errorMessage: string): void {
        return credentialManagerAccess.markSourceNeedsReauth(this, source, errorMessage);
    }
    /**
     * Check if source has valid (non-expired) credentials
     */
    async hasValidCredentials(source: LoadedSource): Promise<boolean> {
        return credentialManagerAccess.hasValidCredentials(this, source);
    }
    // ============================================================
    // Server-Owned OAuth (Prepare / Exchange)
    // ============================================================
    /**
     * Detect the OAuth provider for a source.
     */
    detectProvider(source: LoadedSource): OAuthProvider {
        return credentialManagerAccess.detectProvider(this, source);
    }
    /**
     * Prepare an OAuth flow for a source (server-side).
     *
     * Generates PKCE, state, and auth URL without opening a browser or starting
     * a callback server. The caller provides either callbackPort (Electron local
     * server) or callbackUrl (WebUI server endpoint) for the redirect URI.
     *
     * Returns a PreparedOAuthFlow that should be stored in the flow store
     * and partially returned to the client (authUrl, state, flowId).
     */
    async prepareOAuth(source: LoadedSource, options: {
        callbackPort?: number;
        callbackUrl?: string;
    }): Promise<PreparedOAuthFlow> {
        return credentialManagerOauth.prepareOAuth(this, source, options);
    }
    /**
     * Exchange an authorization code for tokens and store them (server-side).
     *
     * Called after the client forwards the code from the OAuth callback.
     * Routes to the correct provider exchange, saves credentials, and marks
     * the source as authenticated.
     */
    async exchangeAndStore(source: LoadedSource, provider: OAuthProvider, params: OAuthExchangeParams): Promise<AuthResult> {
        return credentialManagerOauth.exchangeAndStore(this, source, provider, params);
    }
    // ============================================================
    // OAuth Authentication (Monolithic — convenience wrapper for CLI/test)
    // ============================================================
    /**
     * Authenticate source via OAuth
     *
     * Handles both MCP OAuth and Gmail OAuth flows.
     * On success, credentials are automatically saved.
     */
    async authenticate(source: LoadedSource, callbacks?: OAuthCallbacks, sessionContext?: OAuthSessionContext): Promise<AuthResult> {
        return credentialManagerOauth.authenticate(this, source, callbacks, sessionContext);
    }
    private async authenticateMcp(source: LoadedSource, callbacks: OAuthCallbacks, sessionContext?: OAuthSessionContext): Promise<AuthResult> {
        return credentialManagerOauth.authenticateMcp(this, source, callbacks, sessionContext);
    }
    private async authenticateGoogle(source: LoadedSource, callbacks: OAuthCallbacks, sessionContext?: OAuthSessionContext): Promise<AuthResult> {
        return credentialManagerProviders.authenticateGoogle(this, source, callbacks, sessionContext);
    }
    private async authenticateSlack(source: LoadedSource, callbacks: OAuthCallbacks, sessionContext?: OAuthSessionContext): Promise<AuthResult> {
        return credentialManagerProviders.authenticateSlack(this, source, callbacks, sessionContext);
    }
    private async authenticateMicrosoft(source: LoadedSource, callbacks: OAuthCallbacks, sessionContext?: OAuthSessionContext): Promise<AuthResult> {
        return credentialManagerProviders.authenticateMicrosoft(this, source, callbacks, sessionContext);
    }
    /**
     * Refresh token for a source
     *
     * Returns the new access token, or null if refresh fails.
     * On success, credentials are automatically updated.
     *
     * Uses promise deduplication to prevent concurrent refresh requests for the same source.
     * This is important because:
     * - Multiple API calls may hit refresh simultaneously when token is expiring
     * - Microsoft rotates refresh tokens, so concurrent refreshes could cause token invalidation
     */
    async refresh(source: LoadedSource): Promise<string | null> {
        return credentialManagerRefresh.refresh(this, source);
    }
    private async doRefresh(source: LoadedSource): Promise<string | null> {
        return credentialManagerRefresh.doRefresh(this, source);
    }
    private async refreshApiRenew(source: LoadedSource, cred: StoredCredential): Promise<string | null> {
        return credentialManagerRefresh.refreshApiRenew(this, source, cred);
    }
    private async refreshGoogle(source: LoadedSource, cred: StoredCredential): Promise<string | null> {
        return credentialManagerRefresh.refreshGoogle(this, source, cred);
    }
    private async refreshSlack(source: LoadedSource, cred: StoredCredential): Promise<string | null> {
        return credentialManagerRefresh.refreshSlack(this, source, cred);
    }
    private async refreshMicrosoft(source: LoadedSource, cred: StoredCredential): Promise<string | null> {
        return credentialManagerRefresh.refreshMicrosoft(this, source, cred);
    }
    private async authenticateGeneric(source: LoadedSource, _cb: OAuthCallbacks, _sessionContext?: OAuthSessionContext): Promise<AuthResult> {
        return credentialManagerProviders.authenticateGeneric(this, source, _cb, _sessionContext);
    }
    private async refreshGeneric(source: LoadedSource, cred: StoredCredential): Promise<string | null> {
        return credentialManagerRefresh.refreshGeneric(this, source, cred);
    }
    private async refreshMcp(source: LoadedSource, cred: StoredCredential): Promise<string | null> {
        return credentialManagerRefresh.refreshMcp(this, source, cred);
    }
}
// ============================================================
// Helper Functions
// ============================================================
/**
 * Check if a single source needs authentication.
 * Returns true if the source requires auth but isn't yet authenticated.
 *
 * This is the **inverse** of the auth portion of isSourceUsable().
 * - isSourceUsable() → Is the source ready to use? (enabled AND auth OK)
 * - sourceNeedsAuthentication() → Does the source need auth to become usable?
 *
 * Use this to prompt users for authentication, not for filtering sources.
 * For filtering sources, use isSourceUsable() from storage.ts.
 *
 * This correctly handles:
 * - MCP sources with authType: "none" → never needs auth
 * - MCP sources with stdio transport → never needs auth (runs locally)
 * - MCP sources with oauth/bearer → needs auth if not authenticated
 * - API sources with authType: "none" → never needs auth
 * - API sources with bearer/basic/header/query auth → needs auth if not authenticated
 */
export function sourceNeedsAuthentication(source: LoadedSource): boolean {
    const mcp = source.config.mcp;
    const api = source.config.api;
    // MCP sources with oauth/bearer auth (stdio transport never needs auth)
    if (source.config.type === 'mcp' && mcp) {
        if (mcp.transport === 'stdio') {
            // Stdio sources run locally and don't need authentication
            return false;
        }
        // Only require auth if authType is explicitly set to 'oauth' or 'bearer'
        // Undefined or 'none' means no authentication required
        if (mcp.authType && mcp.authType !== 'none' && !source.config.isAuthenticated) {
            return true;
        }
    }
    // API sources with auth requirements
    if (source.config.type === 'api' && api) {
        if (api.authType !== 'none' && api.authType !== undefined && !source.config.isAuthenticated) {
            return true;
        }
    }
    return false;
}

/**
 * Get sources that need authentication
 * Returns enabled sources that require auth but aren't yet authenticated
 */
export function getSourcesNeedingAuth(sources: LoadedSource[]): LoadedSource[] {
    return sources.filter((source) => {
        if (!source.config.enabled)
            return false;
        return sourceNeedsAuthentication(source);
    });
}

// Singleton instance
let instance: SourceCredentialManager | null = null;

/**
 * Get shared SourceCredentialManager instance
 */
export function getSourceCredentialManager(): SourceCredentialManager {
    if (!instance) {
        instance = new SourceCredentialManager();
    }
    return instance;
}
