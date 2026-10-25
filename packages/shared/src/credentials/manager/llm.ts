import type { LlmAuthType, LlmProviderType } from "../../config/llm-connections.ts";
import { randomUUID } from "node:crypto";
import type { CredentialManager } from '../manager.ts';
import type { LlmCredentialBinding } from './shared.ts';

export async function getLlmApiKey(transportOwner: CredentialManager, connectionSlug: string, expectedBindingId?: string): Promise<string | null> {
    const cred = await transportOwner["get"]({ type: 'llm_api_key', connectionSlug });
    if (expectedBindingId && cred?.bindingId !== expectedBindingId) {
        throw new Error(`LLM credential generation drifted for "${connectionSlug}"`);
    }
    return cred?.value || null;
}

export async function setLlmApiKey(transportOwner: CredentialManager, connectionSlug: string, apiKey: string): Promise<void> {
    await transportOwner["serializeMutation"](transportOwner["llmMutationKey"]('llm_api_key', connectionSlug), async () => {
        await transportOwner["set"]({ type: 'llm_api_key', connectionSlug }, {
            value: apiKey,
            bindingId: randomUUID(),
        });
    });
}

export async function deleteLlmApiKey(transportOwner: CredentialManager, connectionSlug: string): Promise<boolean> {
    return transportOwner["serializeMutation"](transportOwner["llmMutationKey"]('llm_api_key', connectionSlug), () => transportOwner["delete"]({ type: 'llm_api_key', connectionSlug }));
}

export async function deleteLlmCredentials(transportOwner: CredentialManager, connectionSlug: string): Promise<void> {
    for (const type of [
        'llm_api_key', 'llm_oauth', 'llm_iam', 'llm_service_account',
    ] as const) {
        await transportOwner["serializeMutation"](transportOwner["llmMutationKey"](type, connectionSlug), () => transportOwner["delete"]({ type, connectionSlug }));
    }
}

export async function getLlmCredentialBinding(transportOwner: CredentialManager, connectionSlug: string, authType: LlmAuthType): Promise<LlmCredentialBinding | null> {
    if (authType === 'none' || authType === 'environment')
        return null;
    const slot: LlmCredentialBinding['slot'] = authType === 'oauth'
        ? 'llm_oauth'
        : authType === 'iam_credentials'
            ? 'llm_iam'
            : authType === 'service_account_file'
                ? 'llm_service_account'
                : 'llm_api_key';
    const credential = await transportOwner["get"]({ type: slot, connectionSlug });
    return credential?.bindingId
        ? { slot, bindingId: credential.bindingId }
        : null;
}

export async function hasLlmCredentials(transportOwner: CredentialManager, connectionSlug: string, authType: LlmAuthType, providerType?: LlmProviderType): Promise<boolean> {
    switch (authType) {
        // No credentials needed
        case 'none':
        case 'environment':
            return true;
        // API key variants - all use the same storage
        case 'api_key':
        case 'api_key_with_endpoint':
        case 'bearer_token':
            return transportOwner["hasLlmApiKeyCredential"](connectionSlug);
        // OAuth - browser flow
        case 'oauth':
            return transportOwner["hasLlmOAuthCredential"](connectionSlug, providerType);
        // AWS IAM credentials
        case 'iam_credentials':
            return transportOwner["hasLlmIamCredential"](connectionSlug);
        // GCP service account
        case 'service_account_file':
            return transportOwner["hasLlmServiceAccountCredential"](connectionSlug);
        default:
            // Exhaustive check - TypeScript will error if we miss a case
            const _exhaustive: never = authType;
            return false;
    }
}

/**
   * Check if connection has valid API key credential.
   * @internal
   */
export async function hasLlmApiKeyCredential(transportOwner: CredentialManager, connectionSlug: string): Promise<boolean> {
    const apiKey = await transportOwner["getLlmApiKey"](connectionSlug);
    return !!apiKey;
}

/**
   * Check if connection has valid OAuth credential.
   * @internal
   */
export async function hasLlmOAuthCredential(transportOwner: CredentialManager, connectionSlug: string, providerType?: LlmProviderType): Promise<boolean> {
    const oauth = await transportOwner["getLlmOAuth"](connectionSlug);
    if (!oauth) {
        if (providerType === 'anthropic') {
            const legacy = await transportOwner["getClaudeOAuthCredentials"]().catch(() => null);
            if (legacy?.accessToken) {
                if (legacy.expiresAt && transportOwner["isExpired"]({ value: legacy.accessToken, expiresAt: legacy.expiresAt })) {
                    return !!legacy.refreshToken;
                }
                return true;
            }
        }
        return false;
    }
    // Check if expired
    if (oauth.expiresAt && transportOwner["isExpired"]({ value: oauth.accessToken, expiresAt: oauth.expiresAt })) {
        return !!oauth.refreshToken; // Can refresh
    }
    return true;
}

/**
   * Check if connection has valid IAM credential.
   * @internal
   */
export async function hasLlmIamCredential(transportOwner: CredentialManager, connectionSlug: string): Promise<boolean> {
    const cred = await transportOwner["getLlmIamCredentials"](connectionSlug);
    return !!cred?.accessKeyId && !!cred?.secretAccessKey;
}

/**
   * Check if connection has valid service account credential.
   * @internal
   */
export async function hasLlmServiceAccountCredential(transportOwner: CredentialManager, connectionSlug: string): Promise<boolean> {
    const cred = await transportOwner["getLlmServiceAccount"](connectionSlug);
    return !!cred?.serviceAccountJson;
}
