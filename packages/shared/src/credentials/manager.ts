/**
 * Credential Manager
 *
 * Main interface for credential storage. Uses encrypted file storage
 * for cross-platform compatibility without OS keychain prompts.
 */
import type { CredentialBackend } from "./backends/types.ts";
import type { CredentialId, CredentialType, StoredCredential, CredentialHealthStatus } from "./types.ts";
import type { LlmAuthType, LlmProviderType } from "../config/llm-connections.ts";
import type { LlmCredentialBinding } from './manager/shared.ts';
import * as managerStorage from './manager/storage.ts';
import * as managerOauth from './manager/oauth.ts';
import * as managerLlm from './manager/llm.ts';
import * as managerLlmOauth from './manager/llm-oauth.ts';
import * as managerServiceAccounts from './manager/service-accounts.ts';
import * as managerHealth from './manager/health.ts';
export type { LlmCredentialBinding } from './manager/shared.ts';

export class CredentialManager {
    /** @internal Shared with the extracted backend helpers. */ public backends: CredentialBackend[] = [];
    /** @internal */ public writeBackend: CredentialBackend | null = null;
    /** @internal */ public initialized = false;
    /** @internal */ public initPromise: Promise<void> | null = null;
    /** @internal */ public mutationTails = new Map<string, Promise<void>>();
    /** @internal */ public async serializeMutation<T>(key: string, mutation: () => Promise<T>): Promise<T> {
        return managerStorage.serializeMutation<T>(this, key, mutation);
    }
    /** @internal */ public llmMutationKey(type: CredentialType, connectionSlug: string): string {
        return managerStorage.llmMutationKey(this, type, connectionSlug);
    }
    /**
     * Explicitly initialize the credential manager.
     * This is optional - methods auto-initialize via ensureInitialized().
     * Use this for eager initialization at app startup if desired.
     */
    async initialize(): Promise<void> {
        return managerStorage.initialize(this);
    }
    /** @internal Shared with the extracted backend helpers. */ public async ensureInitialized(): Promise<void> {
        return managerStorage.ensureInitialized(this);
    }
    /** @internal Shared with the extracted backend helpers. */ public ensureInitializedSync(): void {
        return managerStorage.ensureInitializedSync(this);
    }
    /** @internal Shared with the extracted backend helpers. */ public async _doInitialize(): Promise<void> {
        return managerStorage._doInitialize(this);
    }
    /** Get the name of the active write backend */
    getActiveBackendName(): string | null {
        return managerStorage.getActiveBackendName(this);
    }
    /**
     * Get a credential by ID, trying all backends.
     * Automatically initializes if needed.
     */
    async get(id: CredentialId): Promise<StoredCredential | null> {
        return managerStorage.get(this, id);
    }
    /**
     * Set a credential using the write backend.
     * Automatically initializes if needed.
     */
    async set(id: CredentialId, credential: StoredCredential): Promise<void> {
        return managerStorage.set(this, id, credential);
    }
    /** Atomically load or create a secret when the active backend supports it. */
    async getOrCreate(id: CredentialId, create: () => StoredCredential): Promise<StoredCredential> {
        return managerStorage.getOrCreate(this, id, create);
    }
    /**
     * Delete a credential from all backends.
     * Automatically initializes if needed.
     */
    async delete(id: CredentialId): Promise<boolean> {
        return managerStorage.deleteOperation(this, id);
    }
    deleteSync(id: CredentialId): boolean {
        return managerStorage.deleteSync(this, id);
    }
    /**
     * List credentials matching a filter.
     * Automatically initializes if needed.
     */
    async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
        return managerStorage.list(this, filter);
    }
    // ============================================================
    // Convenience Methods
    // ============================================================
    /** Get Anthropic API key */
    async getApiKey(): Promise<string | null> {
        return managerOauth.getApiKey(this);
    }
    /** Set Anthropic API key */
    async setApiKey(key: string): Promise<void> {
        return managerOauth.setApiKey(this, key);
    }
    /** Get Claude OAuth token */
    async getClaudeOAuth(): Promise<string | null> {
        return managerOauth.getClaudeOAuth(this);
    }
    /** Set Claude OAuth token */
    async setClaudeOAuth(token: string): Promise<void> {
        return managerOauth.setClaudeOAuth(this, token);
    }
    /** Get Claude OAuth credentials (with refresh token, expiry, and source) */
    async getClaudeOAuthCredentials(): Promise<{
        accessToken: string;
        refreshToken?: string;
        expiresAt?: number;
        /** Where the token came from: 'native' (our OAuth), 'cli' (Claude CLI import), or undefined (unknown) */
        source?: 'native' | 'cli';
    } | null> {
        return managerOauth.getClaudeOAuthCredentials(this);
    }
    /** Set Claude OAuth credentials (with refresh token, expiry, and source) */
    async setClaudeOAuthCredentials(credentials: {
        accessToken: string;
        refreshToken?: string;
        expiresAt?: number;
        /** Where the token came from: 'native' (our OAuth), 'cli' (Claude CLI import) */
        source?: 'native' | 'cli';
    }): Promise<void> {
        return managerOauth.setClaudeOAuthCredentials(this, credentials);
    }
    /** Get workspace MCP OAuth credentials */
    async getWorkspaceOAuth(workspaceId: string): Promise<{
        accessToken: string;
        tokenType?: string;
        clientId?: string;
    } | null> {
        return managerOauth.getWorkspaceOAuth(this, workspaceId);
    }
    /** Set workspace MCP OAuth credentials */
    async setWorkspaceOAuth(workspaceId: string, credentials: {
        accessToken: string;
        tokenType?: string;
        clientId?: string;
    }): Promise<void> {
        return managerOauth.setWorkspaceOAuth(this, workspaceId, credentials);
    }
    /** Delete all credentials for a workspace (source credentials) */
    async deleteWorkspaceCredentials(workspaceId: string): Promise<void> {
        return managerOauth.deleteWorkspaceCredentials(this, workspaceId);
    }
    // Note: OpenAI API key methods removed - Codex uses native ChatGPT OAuth flow
    // ============================================================
    // LLM Connection Credentials
    // ============================================================
    /**
     * Get API key for an LLM connection.
     * @param connectionSlug - The connection slug
     * @returns API key or null if not found
     */
    async getLlmApiKey(connectionSlug: string, expectedBindingId?: string): Promise<string | null> {
        return managerLlm.getLlmApiKey(this, connectionSlug, expectedBindingId);
    }
    /**
     * Set API key for an LLM connection.
     * @param connectionSlug - The connection slug
     * @param apiKey - The API key to store
     */
    async setLlmApiKey(connectionSlug: string, apiKey: string): Promise<void> {
        return managerLlm.setLlmApiKey(this, connectionSlug, apiKey);
    }
    /**
     * Delete API key for an LLM connection.
     * @param connectionSlug - The connection slug
     * @returns true if deleted, false if not found
     */
    async deleteLlmApiKey(connectionSlug: string): Promise<boolean> {
        return managerLlm.deleteLlmApiKey(this, connectionSlug);
    }
    /**
     * Get OAuth token for an LLM connection.
     * @param connectionSlug - The connection slug
     * @returns OAuth credentials or null if not found
     */
    async getLlmOAuth(connectionSlug: string, expectedBindingId?: string): Promise<{
        accessToken: string;
        refreshToken?: string;
        expiresAt?: number;
        /** OIDC id_token (used by OpenAI/Codex) */
        idToken?: string;
        /** Opaque host generation; never derived from token material. */
        bindingId?: string;
    } | null> {
        return managerLlmOauth.getLlmOAuth(this, connectionSlug, expectedBindingId);
    }
    /**
     * Set OAuth token for an LLM connection.
     * @param connectionSlug - The connection slug
     * @param credentials - OAuth credentials to store
     */
    async setLlmOAuth(connectionSlug: string, credentials: {
        accessToken: string;
        refreshToken?: string;
        expiresAt?: number;
        /** OIDC id_token (used by OpenAI/Codex) */
        idToken?: string;
    }): Promise<void> {
        return managerLlmOauth.setLlmOAuth(this, connectionSlug, credentials);
    }
    /**
     * Persist an automatic refresh of the credential already bound to this slot.
     * Re-authentication must use setLlmOAuth() instead, which deliberately rotates
     * the binding generation. A legacy unbound credential is assigned its first
     * generation only for an unsealed refresh; a specialized caller always supplies
     * expectedBindingId and therefore continues to fail closed on legacy state.
     */
    async refreshLlmOAuth(connectionSlug: string, credentials: {
        accessToken: string;
        refreshToken?: string;
        expiresAt?: number;
        /** OIDC id_token (used by OpenAI/Codex) */
        idToken?: string;
    }, expectedBindingId?: string): Promise<void> {
        return managerLlmOauth.refreshLlmOAuth(this, connectionSlug, credentials, expectedBindingId);
    }
    /**
     * Delete all credentials for an LLM connection.
     * @param connectionSlug - The connection slug
     */
    async deleteLlmCredentials(connectionSlug: string): Promise<void> {
        return managerLlm.deleteLlmCredentials(this, connectionSlug);
    }
    // ============================================================
    // IAM Credentials (AWS Bedrock)
    // ============================================================
    /**
     * Get IAM credentials for an LLM connection.
     * @param connectionSlug - The connection slug
     * @returns IAM credentials or null if not found
     */
    async getLlmIamCredentials(connectionSlug: string, expectedBindingId?: string): Promise<{
        accessKeyId: string;
        secretAccessKey: string;
        region?: string;
        sessionToken?: string;
    } | null> {
        return managerServiceAccounts.getLlmIamCredentials(this, connectionSlug, expectedBindingId);
    }
    /**
     * Set IAM credentials for an LLM connection.
     * @param connectionSlug - The connection slug
     * @param credentials - IAM credentials to store
     */
    async setLlmIamCredentials(connectionSlug: string, credentials: {
        accessKeyId: string;
        secretAccessKey: string;
        region?: string | undefined;
        sessionToken?: string | undefined;
    }): Promise<void> {
        return managerServiceAccounts.setLlmIamCredentials(this, connectionSlug, credentials);
    }
    // ============================================================
    // Service Account Credentials (GCP Vertex)
    // ============================================================
    /**
     * Get service account credentials for an LLM connection.
     * @param connectionSlug - The connection slug
     * @returns Service account JSON and metadata or null if not found
     */
    async getLlmServiceAccount(connectionSlug: string, expectedBindingId?: string): Promise<{
        serviceAccountJson: string;
        projectId?: string;
        region?: string;
        email?: string;
    } | null> {
        return managerServiceAccounts.getLlmServiceAccount(this, connectionSlug, expectedBindingId);
    }
    /**
     * Set service account credentials for an LLM connection.
     * @param connectionSlug - The connection slug
     * @param credentials - Service account credentials to store
     */
    async setLlmServiceAccount(connectionSlug: string, credentials: {
        serviceAccountJson: string;
        projectId?: string;
        region?: string;
        email?: string;
    }): Promise<void> {
        return managerServiceAccounts.setLlmServiceAccount(this, connectionSlug, credentials);
    }
    /**
     * Resolve the non-secret generation selected by the exact connection auth
     * mechanism. Environment credentials are intentionally not attestable: their
     * principal can change outside the encrypted host store without a generation.
     */
    async getLlmCredentialBinding(connectionSlug: string, authType: LlmAuthType): Promise<LlmCredentialBinding | null> {
        return managerLlm.getLlmCredentialBinding(this, connectionSlug, authType);
    }
    // ============================================================
    // Unified Credential Checking
    // ============================================================
    /**
     * Check if an LLM connection has valid credentials.
     * Uses the new LlmAuthType system - routes by auth mechanism.
     *
     * @param connectionSlug - The connection slug
     * @param authType - The auth type to check
     * @param providerType - Optional provider type for OAuth routing
     * @returns true if credentials exist and are valid
     */
    async hasLlmCredentials(connectionSlug: string, authType: LlmAuthType, providerType?: LlmProviderType): Promise<boolean> {
        return managerLlm.hasLlmCredentials(this, connectionSlug, authType, providerType);
    }
    /** @internal */ public async hasLlmApiKeyCredential(connectionSlug: string): Promise<boolean> {
        return managerLlm.hasLlmApiKeyCredential(this, connectionSlug);
    }
    /** @internal */ public async hasLlmOAuthCredential(connectionSlug: string, providerType?: LlmProviderType): Promise<boolean> {
        return managerLlm.hasLlmOAuthCredential(this, connectionSlug, providerType);
    }
    /** @internal */ public async hasLlmIamCredential(connectionSlug: string): Promise<boolean> {
        return managerLlm.hasLlmIamCredential(this, connectionSlug);
    }
    /** @internal */ public async hasLlmServiceAccountCredential(connectionSlug: string): Promise<boolean> {
        return managerLlm.hasLlmServiceAccountCredential(this, connectionSlug);
    }
    /**
     * Check if a credential is expired (with 5-minute buffer).
     *
     * If expiresAt is not set:
     * - OAuth tokens (have refreshToken): treated as expired to force refresh attempt
     * - API keys (no refreshToken): treated as never expiring
     *
     * This prevents OAuth tokens from being treated as valid forever when
     * the provider doesn't return expires_in in the token response.
     */
    isExpired(credential: StoredCredential): boolean {
        return managerHealth.isExpired(this, credential);
    }
    // ============================================================
    // Health Check
    // ============================================================
    /**
     * Check the health of the credential store.
     *
     * This validates:
     * 1. The credential file can be read and decrypted (if it exists)
     * 2. The default LLM connection has valid credentials
     *
     * Use this on app startup to detect issues before users hit cryptic errors.
     *
     * @returns Health status with any issues found
     */
    async checkHealth(): Promise<CredentialHealthStatus> {
        return managerHealth.checkHealth(this);
    }
}
// Singleton instance
let manager: CredentialManager | null = null;

export function getCredentialManager(): CredentialManager {
    if (!manager) {
        manager = new CredentialManager();
    }
    return manager;
}

export function setCredentialManagerForTesting(instance: CredentialManager | null): void {
    manager = instance;
}
