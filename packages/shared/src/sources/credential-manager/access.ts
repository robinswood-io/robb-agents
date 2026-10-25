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
import { isApiOAuthProvider, type LoadedSource } from "../types.ts";
import type { CredentialId, StoredCredential } from "../../credentials/types.ts";
import type { OAuthProvider } from "../../auth/oauth-flow-types.ts";
import { debug } from "../../utils/debug.ts";
import { loadSourceConfig, saveSourceConfig } from "../storage.ts";
import type { SourceCredentialManager } from '../credential-manager.ts';
import type { BasicAuthCredential, MultiHeaderCredential, ApiCredential } from './shared.ts';

export async function getToken(transportOwner: SourceCredentialManager, source: LoadedSource): Promise<string | null> {
    const cred = await transportOwner["load"](source);
    if (!cred?.value)
        return null;
    // Check expiry
    if (transportOwner["isExpired"](cred)) {
        debug(`[SourceCredentialManager] Token expired for ${source.config.slug}`);
        return null;
    }
    return cred.value;
}

export async function getApiCredential(transportOwner: SourceCredentialManager, source: LoadedSource): Promise<ApiCredential | null> {
    return transportOwner["parseApiCredential"](source, await transportOwner["load"](source));
}

export async function getApiCredentialWithIdentity(transportOwner: SourceCredentialManager, source: LoadedSource): Promise<{
    credential: ApiCredential;
    bindingId?: string;
} | null> {
    const bound = await transportOwner["loadWithIdentity"](source);
    const credential = transportOwner["parseApiCredential"](source, bound?.credential ?? null);
    if (credential === null)
        return null;
    return {
        credential,
        ...(bound?.credential.bindingId ? { bindingId: bound.credential.bindingId } : {}),
    };
}

export function parseApiCredential(transportOwner: SourceCredentialManager, source: LoadedSource, cred: StoredCredential | null): ApiCredential | null {
    // Check both API and MCP headerNames (same credential store pattern)
    const headerNames = source.config.api?.headerNames || source.config.mcp?.headerNames;
    debug(`[SourceCredentialManager] getApiCredential for ${source.config.slug}: cred.value exists=${!!cred?.value}, headerNames=${JSON.stringify(headerNames)}`);
    if (!cred?.value)
        return null;
    // Check for multi-header auth (JSON with header names as keys)
    // Works for both API sources (api.headerNames) and MCP sources (mcp.headerNames)
    if (headerNames?.length) {
        debug(`[SourceCredentialManager] Attempting multi-header parse for ${source.config.slug}, raw value length=${cred.value.length}`);
        try {
            const parsed = JSON.parse(cred.value);
            debug(`[SourceCredentialManager] Parsed JSON keys: ${Object.keys(parsed).join(', ')}`);
            // Validate all required headers are present
            const hasAllHeaders = headerNames.every((h) => h in parsed);
            debug(`[SourceCredentialManager] hasAllHeaders=${hasAllHeaders}`);
            if (hasAllHeaders) {
                return parsed as MultiHeaderCredential;
            }
        }
        catch (e) {
            // Not JSON, fall through to other auth types
            debug(`[SourceCredentialManager] JSON parse failed: ${e}`);
        }
    }
    // Check for basic auth (JSON with username/password)
    if (source.config.api?.authType === 'basic') {
        try {
            const parsed = JSON.parse(cred.value);
            if (parsed.username && parsed.password) {
                return parsed as BasicAuthCredential;
            }
        }
        catch {
            // Not JSON, treat as regular credential
        }
    }
    return cred.value;
}

export function getCredentialId(transportOwner: SourceCredentialManager, source: LoadedSource): CredentialId {
    const mcp = source.config.mcp;
    const api = source.config.api;
    let type: CredentialId['type'];
    if (source.config.type === 'mcp') {
        type = mcp?.authType === 'bearer' ? 'source_bearer' : 'source_oauth';
    }
    else if (source.config.type === 'api') {
        // Order matters: provider-specific checks first, then generic OAuth fallback
        if (isApiOAuthProvider(source.config.provider)) {
            type = 'source_oauth';
        }
        else if (api?.authType === 'oauth') {
            // Generic OAuth API sources — explicit config or auto-discovery
            type = 'source_oauth';
        }
        else if (api?.authType === 'bearer') {
            type = 'source_bearer';
        }
        else if (api?.authType === 'basic') {
            type = 'source_basic';
        }
        else {
            // header, query, or other → stored as apikey
            type = 'source_apikey';
        }
    }
    else {
        type = 'source_oauth';
    }
    return {
        type,
        workspaceId: source.workspaceId,
        sourceId: source.config.slug,
    };
}

export function isExpired(transportOwner: SourceCredentialManager, credential: StoredCredential): boolean {
    if (!credential.expiresAt)
        return false;
    return Date.now() > credential.expiresAt;
}

export function needsRefresh(transportOwner: SourceCredentialManager, credential: StoredCredential): boolean {
    if (!credential.expiresAt)
        return false;
    const fiveMinutes = 5 * 60 * 1000;
    return Date.now() > credential.expiresAt - fiveMinutes;
}

export function markSourceNeedsReauth(transportOwner: SourceCredentialManager, source: LoadedSource, errorMessage: string): void {
    try {
        const config = loadSourceConfig(source.workspaceRootPath, source.config.slug);
        if (config) {
            config.isAuthenticated = false;
            config.connectionStatus = 'needs_auth';
            config.connectionError = errorMessage;
            saveSourceConfig(source.workspaceRootPath, config);
            debug(`[SourceCredentialManager] Marked ${source.config.slug} as needing re-auth: ${errorMessage}`);
        }
    }
    catch (error) {
        debug(`[SourceCredentialManager] Failed to mark ${source.config.slug} as needing re-auth:`, error);
    }
}

export async function hasValidCredentials(transportOwner: SourceCredentialManager, source: LoadedSource): Promise<boolean> {
    const token = await transportOwner["getToken"](source);
    return token !== null;
}

export function detectProvider(transportOwner: SourceCredentialManager, source: LoadedSource): OAuthProvider {
    // Order matters: provider-specific checks first, then generic OAuth fallback
    if (source.config.provider === 'google')
        return 'google';
    if (source.config.provider === 'slack')
        return 'slack';
    if (source.config.provider === 'microsoft')
        return 'microsoft';
    // Generic OAuth: either explicit oauth config block or authType 'oauth' with auto-discovery
    if (source.config.api?.authType === 'oauth')
        return 'generic';
    return 'mcp';
}
