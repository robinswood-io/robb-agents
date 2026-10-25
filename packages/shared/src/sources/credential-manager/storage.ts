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
import { type LoadedSource } from "../types.ts";
import type { CredentialId, StoredCredential } from "../../credentials/types.ts";
import { getCredentialManager } from "../../credentials/index.ts";
import { debug } from "../../utils/debug.ts";
import { randomUUID } from "node:crypto";
import type { SourceCredentialManager } from '../credential-manager.ts';
import type { ApiCredential } from './shared.ts';

export async function save(transportOwner: SourceCredentialManager, source: LoadedSource, credential: StoredCredential): Promise<void> {
    const credentialId = transportOwner["getCredentialId"](source);
    const manager = getCredentialManager();
    await manager.set(credentialId, {
        ...credential,
        // Fresh authentication/pasted credentials omit bindingId and therefore
        // rotate the non-secret authority identity. Refresh paths spread the
        // stored credential and preserve it.
        bindingId: credential.bindingId ?? randomUUID(),
    });
    debug(`[SourceCredentialManager] Saved ${credentialId.type} for ${source.config.slug}`);
}

export async function load(transportOwner: SourceCredentialManager, source: LoadedSource): Promise<StoredCredential | null> {
    return (await transportOwner["loadWithIdentity"](source))?.credential ?? null;
}

export async function loadWithIdentity(transportOwner: SourceCredentialManager, source: LoadedSource): Promise<{
    credential: StoredCredential;
    credentialId: CredentialId;
} | null> {
    const manager = getCredentialManager();
    // For MCP sources, try both OAuth and bearer credentials
    // (stdio transport doesn't need credentials)
    if (source.config.type === 'mcp' && source.config.mcp?.transport !== 'stdio' && source.config.mcp?.authType !== 'none') {
        return transportOwner["loadMcpCredentialWithIdentity"](source);
    }
    // API sources with authType:'none' must never read the shared source_apikey
    // slot. 'none', 'header', and 'query' all map to source_apikey for storage
    // compatibility; reading here would resurrect stale header/query credentials
    // after a source is switched to public/default-header auth.
    if (source.config.type === 'api' && source.config.api?.authType === 'none') {
        debug(`[SourceCredentialManager] Skipping credential load for public API source ${source.config.slug}`);
        return null;
    }
    // For other sources, use the credential ID based on authType
    const credentialId = transportOwner["getCredentialId"](source);
    const cred = await manager.get(credentialId);
    if (cred) {
        debug(`[SourceCredentialManager] Found ${credentialId.type} for ${source.config.slug}`);
    }
    return cred ? { credential: cred, credentialId } : null;
}

export async function loadMcpCredentialWithIdentity(transportOwner: SourceCredentialManager, source: LoadedSource): Promise<{
    credential: StoredCredential;
    credentialId: CredentialId;
} | null> {
    const manager = getCredentialManager();
    const baseId = {
        workspaceId: source.workspaceId,
        sourceId: source.config.slug,
    };
    // Try OAuth first
    const oauthId: CredentialId = { type: 'source_oauth', ...baseId };
    const oauthCreds = await manager.get(oauthId);
    if (oauthCreds?.value) {
        debug(`[SourceCredentialManager] Found source_oauth for ${source.config.slug}`);
        return { credential: oauthCreds, credentialId: oauthId };
    }
    // Fall back to bearer
    const bearerId: CredentialId = { type: 'source_bearer', ...baseId };
    const bearerCreds = await manager.get(bearerId);
    if (bearerCreds?.value) {
        debug(`[SourceCredentialManager] Found source_bearer for ${source.config.slug}`);
        return { credential: bearerCreds, credentialId: bearerId };
    }
    debug(`[SourceCredentialManager] No credential found for MCP source ${source.config.slug}`);
    return null;
}

export async function deleteOperation(transportOwner: SourceCredentialManager, source: LoadedSource): Promise<boolean> {
    const credentialId = transportOwner["getCredentialId"](source);
    const manager = getCredentialManager();
    const deleted = await manager.delete(credentialId);
    if (deleted) {
        debug(`[SourceCredentialManager] Deleted ${credentialId.type} for ${source.config.slug}`);
    }
    return deleted;
}

export function deleteSync(transportOwner: SourceCredentialManager, source: LoadedSource): boolean {
    const credentialId = transportOwner["getCredentialId"](source);
    const manager = getCredentialManager();
    const deleted = manager.deleteSync(credentialId);
    if (deleted) {
        debug(`[SourceCredentialManager] Deleted ${credentialId.type} for ${source.config.slug}`);
    }
    return deleted;
}

export async function loadRuntimeCredentialSnapshot(transportOwner: SourceCredentialManager, source: LoadedSource): Promise<{
    stored: StoredCredential | null;
    credentialId: CredentialId | null;
    bindingId?: string;
    token: string | null;
    apiCredential: ApiCredential | null;
}> {
    const bound = await transportOwner["loadWithIdentity"](source);
    const stored = bound?.credential ?? null;
    return {
        stored,
        credentialId: bound?.credentialId ?? null,
        ...(stored?.bindingId ? { bindingId: stored.bindingId } : {}),
        token: stored?.value && !transportOwner["isExpired"](stored) ? stored.value : null,
        apiCredential: transportOwner["parseApiCredential"](source, stored),
    };
}
