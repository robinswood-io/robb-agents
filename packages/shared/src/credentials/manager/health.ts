import type { StoredCredential, CredentialHealthStatus, CredentialHealthIssue } from "../types.ts";
import { debug } from "../../utils/debug.ts";
import type { CredentialManager } from '../manager.ts';

export function isExpired(transportOwner: CredentialManager, credential: StoredCredential): boolean {
    if (credential.expiresAt) {
        // Consider expired if within 5 minutes of expiry
        return Date.now() > credential.expiresAt - 5 * 60 * 1000;
    }
    // No expiresAt set - behavior depends on credential type
    if (credential.refreshToken) {
        // OAuth token without expiry - treat as expired to force refresh
        // This is safer than assuming it's valid forever
        debug('[CredentialManager] OAuth token missing expiresAt - treating as expired');
        return true;
    }
    // API key without expiry - these typically don't expire
    return false;
}

export async function checkHealth(transportOwner: CredentialManager): Promise<CredentialHealthStatus> {
    const issues: CredentialHealthIssue[] = [];
    try {
        await transportOwner["ensureInitialized"]();
        // 1. Try to list credentials - this triggers decryption
        // If file is corrupted or can't be decrypted, this will throw
        await transportOwner["list"]({});
    }
    catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const lowerMsg = errorMsg.toLowerCase();
        // Detect decryption failures (usually means machine migration)
        if (lowerMsg.includes('decrypt') || lowerMsg.includes('cipher') || lowerMsg.includes('authentication tag')) {
            issues.push({
                type: 'decryption_failed',
                message: 'Credentials from another machine detected. Please re-authenticate.',
                error: errorMsg,
            });
        }
        else if (lowerMsg.includes('json') || lowerMsg.includes('parse') || lowerMsg.includes('unexpected')) {
            issues.push({
                type: 'file_corrupted',
                message: 'Credential file is corrupted. Please re-authenticate.',
                error: errorMsg,
            });
        }
        else {
            // Unknown error - treat as corruption
            issues.push({
                type: 'file_corrupted',
                message: 'Failed to read credentials. Please re-authenticate.',
                error: errorMsg,
            });
        }
        return { healthy: false, issues };
    }
    // 2. Check if default connection has credentials
    // Import lazily to avoid circular dependency
    try {
        const { getDefaultLlmConnection, getLlmConnection } = await import("../../config/storage.ts");
        const defaultSlug = getDefaultLlmConnection();
        if (defaultSlug) {
            const connection = getLlmConnection(defaultSlug);
            if (connection && connection.authType !== 'none' && connection.authType !== 'environment') {
                const hasCredentials = await transportOwner["hasLlmCredentials"](defaultSlug, connection.authType, connection.providerType);
                if (!hasCredentials) {
                    issues.push({
                        type: 'no_default_credentials',
                        message: `No credentials found for default connection "${connection.name}".`,
                    });
                }
            }
        }
    }
    catch (configError) {
        // Config not yet initialized - skip this check
        debug('[CredentialManager] Skipping default connection check - config not available');
    }
    return {
        healthy: issues.length === 0,
        issues,
    };
}
