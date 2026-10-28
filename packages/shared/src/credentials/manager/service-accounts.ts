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
        ...(cred.awsRegion !== undefined ? { region: cred.awsRegion } : {}),
        ...(cred.awsSessionToken !== undefined ? { sessionToken: cred.awsSessionToken } : {}),
    };
}

export async function setLlmIamCredentials(transportOwner: CredentialManager, connectionSlug: string, credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    region?: string | undefined;
    sessionToken?: string | undefined;
}): Promise<void> {
    await transportOwner.serializeMutation(transportOwner.llmMutationKey('llm_iam', connectionSlug), async () => {
        await transportOwner["set"]({ type: 'llm_iam', connectionSlug }, {
            value: credentials.secretAccessKey, // Primary secret in value field
            awsAccessKeyId: credentials.accessKeyId,
            ...(credentials.region !== undefined ? { awsRegion: credentials.region } : {}),
            ...(credentials.sessionToken !== undefined ? { awsSessionToken: credentials.sessionToken } : {}),
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
        ...(cred.gcpProjectId !== undefined ? { projectId: cred.gcpProjectId } : {}),
        ...(cred.gcpRegion !== undefined ? { region: cred.gcpRegion } : {}),
        ...(cred.serviceAccountEmail !== undefined ? { email: cred.serviceAccountEmail } : {}),
    };
}

export async function setLlmServiceAccount(transportOwner: CredentialManager, connectionSlug: string, credentials: {
    serviceAccountJson: string;
    projectId?: string;
    region?: string;
    email?: string;
}): Promise<void> {
    await transportOwner.serializeMutation(transportOwner.llmMutationKey('llm_service_account', connectionSlug), async () => {
        await transportOwner["set"]({ type: 'llm_service_account', connectionSlug }, {
            value: credentials.serviceAccountJson, // Full JSON in value field
            ...(credentials.projectId !== undefined ? { gcpProjectId: credentials.projectId } : {}),
            ...(credentials.region !== undefined ? { gcpRegion: credentials.region } : {}),
            ...(credentials.email !== undefined ? { serviceAccountEmail: credentials.email } : {}),
            bindingId: randomUUID(),
        });
    });
}
