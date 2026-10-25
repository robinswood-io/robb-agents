import { randomUUID } from "node:crypto";
import type { CredentialManager } from '../manager.ts';

export async function getLlmOAuth(transportOwner: CredentialManager, connectionSlug: string, expectedBindingId?: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** OIDC id_token (used by OpenAI/Codex) */
    idToken?: string;
    /** Opaque host generation; never derived from token material. */
    bindingId?: string;
} | null> {
    const cred = await transportOwner["get"]({ type: 'llm_oauth', connectionSlug });
    if (expectedBindingId && cred?.bindingId !== expectedBindingId) {
        throw new Error(`LLM credential generation drifted for "${connectionSlug}"`);
    }
    if (!cred)
        return null;
    return {
        accessToken: cred.value,
        refreshToken: cred.refreshToken,
        expiresAt: cred.expiresAt,
        idToken: cred.idToken,
        bindingId: cred.bindingId,
    };
}

export async function setLlmOAuth(transportOwner: CredentialManager, connectionSlug: string, credentials: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** OIDC id_token (used by OpenAI/Codex) */
    idToken?: string;
}): Promise<void> {
    await transportOwner["serializeMutation"](transportOwner["llmMutationKey"]('llm_oauth', connectionSlug), async () => {
        await transportOwner["set"]({ type: 'llm_oauth', connectionSlug }, {
            value: credentials.accessToken,
            refreshToken: credentials.refreshToken,
            expiresAt: credentials.expiresAt,
            idToken: credentials.idToken,
            bindingId: randomUUID(),
        });
    });
}

export async function refreshLlmOAuth(transportOwner: CredentialManager, connectionSlug: string, credentials: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** OIDC id_token (used by OpenAI/Codex) */
    idToken?: string;
}, expectedBindingId?: string): Promise<void> {
    await transportOwner["serializeMutation"](transportOwner["llmMutationKey"]('llm_oauth', connectionSlug), async () => {
        const current = await transportOwner["get"]({ type: 'llm_oauth', connectionSlug });
        if (!current) {
            throw new Error(`Cannot refresh missing LLM OAuth credential "${connectionSlug}"`);
        }
        if (expectedBindingId && current.bindingId !== expectedBindingId) {
            throw new Error(`LLM credential generation drifted for "${connectionSlug}"`);
        }
        const bindingId = current.bindingId ?? randomUUID();
        await transportOwner["set"]({ type: 'llm_oauth', connectionSlug }, {
            value: credentials.accessToken,
            refreshToken: credentials.refreshToken,
            expiresAt: credentials.expiresAt,
            idToken: credentials.idToken,
            bindingId,
        });
    });
}
