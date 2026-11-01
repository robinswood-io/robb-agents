/** Validate the raw OAuth RPC replies shared by Electron and the Web UI. */
export function assertOAuthStart(value: unknown): asserts value is { flowId: string; state: string; authUrl: string } {
    if (!value || typeof value !== 'object' || !('flowId' in value) || typeof value.flowId !== 'string'
        || !('state' in value) || typeof value.state !== 'string' || !('authUrl' in value) || typeof value.authUrl !== 'string') {
        throw new Error('Invalid OAuth start response');
    }
}

type OAuthResult = { success: boolean; error?: string; email?: string; authUrl?: string; flowId?: string };

export function assertOAuthResult(value: unknown): asserts value is OAuthResult {
    if (!value || typeof value !== 'object' || !('success' in value) || typeof value.success !== 'boolean') {
        throw new Error('Invalid OAuth result');
    }
    for (const key of ['error', 'email', 'authUrl', 'flowId'] as const) {
        const field: unknown = Reflect.get(value, key);
        if (key in value && field !== undefined && typeof field !== 'string') {
            throw new Error(`Invalid OAuth result field: ${key}`);
        }
    }
}

