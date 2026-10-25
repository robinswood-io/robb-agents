import type { CredentialManager } from '../manager.ts';

export async function getApiKey(transportOwner: CredentialManager): Promise<string | null> {
    const cred = await transportOwner["get"]({ type: 'anthropic_api_key' });
    return cred?.value || null;
}

export async function setApiKey(transportOwner: CredentialManager, key: string): Promise<void> {
    await transportOwner["set"]({ type: 'anthropic_api_key' }, { value: key });
}

export async function getClaudeOAuth(transportOwner: CredentialManager): Promise<string | null> {
    const cred = await transportOwner["get"]({ type: 'claude_oauth' });
    return cred?.value || null;
}

export async function setClaudeOAuth(transportOwner: CredentialManager, token: string): Promise<void> {
    await transportOwner["set"]({ type: 'claude_oauth' }, { value: token });
}

export async function getClaudeOAuthCredentials(transportOwner: CredentialManager): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** Where the token came from: 'native' (our OAuth), 'cli' (Claude CLI import), or undefined (unknown) */
    source?: 'native' | 'cli';
} | null> {
    const cred = await transportOwner["get"]({ type: 'claude_oauth' });
    if (!cred)
        return null;
    return {
        accessToken: cred.value,
        refreshToken: cred.refreshToken,
        expiresAt: cred.expiresAt,
        source: cred.source as 'native' | 'cli' | undefined,
    };
}

export async function setClaudeOAuthCredentials(transportOwner: CredentialManager, credentials: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** Where the token came from: 'native' (our OAuth), 'cli' (Claude CLI import) */
    source?: 'native' | 'cli';
}): Promise<void> {
    await transportOwner["set"]({ type: 'claude_oauth' }, {
        value: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        expiresAt: credentials.expiresAt,
        source: credentials.source,
    });
}

export async function getWorkspaceOAuth(transportOwner: CredentialManager, workspaceId: string): Promise<{
    accessToken: string;
    tokenType?: string;
    clientId?: string;
} | null> {
    const cred = await transportOwner["get"]({ type: 'workspace_oauth', workspaceId });
    if (!cred)
        return null;
    return {
        accessToken: cred.value,
        tokenType: cred.tokenType,
        clientId: cred.clientId,
    };
}

export async function setWorkspaceOAuth(transportOwner: CredentialManager, workspaceId: string, credentials: {
    accessToken: string;
    tokenType?: string;
    clientId?: string;
}): Promise<void> {
    await transportOwner["set"]({ type: 'workspace_oauth', workspaceId }, {
        value: credentials.accessToken,
        tokenType: credentials.tokenType,
        clientId: credentials.clientId,
    });
}

export async function deleteWorkspaceCredentials(transportOwner: CredentialManager, workspaceId: string): Promise<void> {
    const allCreds = await transportOwner["list"]({ workspaceId });
    for (const cred of allCreds) {
        await transportOwner["delete"](cred);
    }
}
