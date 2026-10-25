import { randomUUID } from "node:crypto";
import type { CredentialManager } from '../manager.ts';

export async function getLlmIamCredentials(transportOwner: CredentialManager, connectionSlug: string, expectedBindingId?: string): Promise<{
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    sessionToken?: string;
} | null> {
    const cred = await transportOwner["get"]({ type: 'llm_iam', connectionSlug });
    if (expectedBindingId && cred?.bindingId !== expectedBindingId) {
        throw new Error(`LLM credential generation drifted for "${connectionSlug}"`);
    }
    if (!cred || !cred.awsAccessKeyId)
        return null;
    return {
        accessKeyId: cred.awsAccessKeyId,
        secretAccessKey: cred.value, // Secret key stored in value field
        region: cred.awsRegion,
        sessionToken: cred.awsSessionToken,
    };
}

export async function setLlmIamCredentials(transportOwner: CredentialManager, connectionSlug: string, credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    sessionToken?: string;
}): Promise<void> {
    await transportOwner["serializeMutation"](transportOwner["llmMutationKey"]('llm_iam', connectionSlug), async () => {
        await transportOwner["set"]({ type: 'llm_iam', connectionSlug }, {
            value: credentials.secretAccessKey, // Primary secret in value field
            awsAccessKeyId: credentials.accessKeyId,
            awsRegion: credentials.region,
            awsSessionToken: credentials.sessionToken,
            bindingId: randomUUID(),
        });
    });
}

export async function getLlmServiceAccount(transportOwner: CredentialManager, connectionSlug: string, expectedBindingId?: string): Promise<{
    serviceAccountJson: string;
    projectId?: string;
    region?: string;
    email?: string;
} | null> {
    const cred = await transportOwner["get"]({ type: 'llm_service_account', connectionSlug });
    if (expectedBindingId && cred?.bindingId !== expectedBindingId) {
        throw new Error(`LLM credential generation drifted for "${connectionSlug}"`);
    }
    if (!cred)
        return null;
    return {
        serviceAccountJson: cred.value, // Full JSON stored in value field
        projectId: cred.gcpProjectId,
        region: cred.gcpRegion,
        email: cred.serviceAccountEmail,
    };
}

export async function setLlmServiceAccount(transportOwner: CredentialManager, connectionSlug: string, credentials: {
    serviceAccountJson: string;
    projectId?: string;
    region?: string;
    email?: string;
}): Promise<void> {
    await transportOwner["serializeMutation"](transportOwner["llmMutationKey"]('llm_service_account', connectionSlug), async () => {
        await transportOwner["set"]({ type: 'llm_service_account', connectionSlug }, {
            value: credentials.serviceAccountJson, // Full JSON in value field
            gcpProjectId: credentials.projectId,
            gcpRegion: credentials.region,
            serviceAccountEmail: credentials.email,
            bindingId: randomUUID(),
        });
    });
}
