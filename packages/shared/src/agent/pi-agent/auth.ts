import { getBackendRuntime } from "../backend/internal/driver-types.ts";
// Credential manager for token storage
import { getCredentialManager } from "../../credentials/manager.ts";
// ChatGPT OAuth token refresh (used when Pi routes ChatGPT auth)
import { refreshChatGptTokens } from "../../auth/chatgpt-oauth.ts";
import type { PiAgent } from '../pi-agent.ts';
import { BEDROCK_ENVIRONMENT_AUTH_KEYS, pickExplicitEnvironment, buildPiProviderEnvironment } from './shared.ts';
import type { PiAuthPayload, TokenRefreshOutcome } from './shared.ts';
import type { PiBuildAwsEnvRuntimePayload, PiBuildProviderEnvRuntimePayload } from './protocol.ts';

/**
   * Build structured Pi auth from connection config.
   * Returns a provider-aware credential object for the subprocess,
   * or null if no piAuthProvider is configured (falls back to legacy getApiKey).
   *
   * OAuth tokens from Craft (Claude Max, ChatGPT Plus, Copilot) are passed as
   * api_key type because they function as bearer tokens that the Pi SDK's provider
   * modules use directly. The OAuth exchange happens on the Craft side; by the time
   * it reaches Pi, it's just an access token.
   */
export async function getPiAuth(transportOwner: PiAgent): Promise<PiAuthPayload | null> {
    const piAuthProvider = getBackendRuntime(transportOwner["config"]).piAuthProvider;
    if (!piAuthProvider)
        return null;
    try {
        const credentialManager = getCredentialManager();
        const slug = transportOwner["config"].connectionSlug || 'pi';
        if (transportOwner["config"].authType === 'oauth') {
            const oauth = await credentialManager.getLlmOAuth(slug, transportOwner["config"].expectedLlmCredentialBindingId);
            if (oauth?.accessToken) {
                // Copilot and OpenAI Codex: pass full OAuth credential so the Pi SDK can derive the
                // correct API endpoint and perform native token refresh.
                if ((piAuthProvider === 'github-copilot' || piAuthProvider === 'openai-codex') && oauth.refreshToken) {
                    transportOwner["debug"](`Retrieved ${piAuthProvider} OAuth credential for Pi provider`);
                    return {
                        provider: piAuthProvider,
                        credential: {
                            type: 'oauth',
                            access: oauth.accessToken,
                            refresh: oauth.refreshToken,
                            expires: oauth.expiresAt ?? 0,
                        },
                    };
                }
                // Other OAuth providers: pass as api_key (bearer token)
                transportOwner["debug"](`Retrieved OAuth access token for Pi provider: ${piAuthProvider}`);
                return {
                    provider: piAuthProvider,
                    credential: { type: 'api_key', key: oauth.accessToken },
                };
            }
        }
        else if (transportOwner["config"].authType === 'iam_credentials') {
            // AWS IAM credentials — pass structured fields so the subprocess can
            // identify the credential type. Actual AWS env var injection happens
            // at spawn time (see spawnSubprocess) for proper process isolation.
            const iam = await credentialManager.getLlmIamCredentials(slug, transportOwner["config"].expectedLlmCredentialBindingId);
            if (iam) {
                transportOwner["debug"](`Retrieved IAM credentials for Pi provider: ${piAuthProvider}`);
                return {
                    provider: piAuthProvider,
                    credential: {
                        type: 'iam',
                        accessKeyId: iam.accessKeyId,
                        secretAccessKey: iam.secretAccessKey,
                        ...(iam.region !== undefined ? { region: iam.region } : {}),
                        ...(iam.sessionToken !== undefined ? { sessionToken: iam.sessionToken } : {}),
                    },
                };
            }
        }
        else {
            // API key-based connections.
            // NOTE: authType === 'environment' (e.g. Bedrock with ~/.aws/credentials)
            // intentionally falls through here, finds no API key, and returns null.
            // buildAwsEnv() grants the AWS credential chain only to the selected
            // Bedrock subprocess; it is not part of generic process.env inheritance.
            const apiKey = await credentialManager.getLlmApiKey(slug, transportOwner["config"].expectedLlmCredentialBindingId);
            if (apiKey) {
                transportOwner["debug"](`Retrieved API key credential for Pi provider: ${piAuthProvider}`);
                return {
                    provider: piAuthProvider,
                    credential: { type: 'api_key', key: apiKey },
                };
            }
        }
        transportOwner["debug"](`No credentials found for Pi provider: ${piAuthProvider}`);
        return null;
    }
    catch (error) {
        transportOwner["debug"](`Failed to retrieve Pi auth: ${error}`);
        return null;
    }
}

/**
   * Build AWS environment variables from piAuth credentials for the subprocess.
   *
   * The Pi SDK's Bedrock provider reads from the AWS default credential chain
   * (env vars), not from Pi AuthStorage. We inject at spawn time so credentials
   * are scoped to the subprocess and don't leak to the main process.
   *
   * NOTE: IAM credentials (especially STS session tokens) are immutable after
   * spawn — they cannot be refreshed in a running subprocess. Long sessions
   * with temporary credentials (~1h STS tokens) will fail on expiry.
   */
export function buildAwsEnv(transportOwner: PiAgent, piAuth: Awaited<ReturnType<PiAgent['getPiAuth']>>, runtime: PiBuildAwsEnvRuntimePayload): Record<string, string> {
    if (runtime.piAuthProvider !== 'amazon-bedrock')
        return {};
    // Environment auth is an explicit user choice for this one Bedrock
    // connection. Preserve the AWS default credential chain without exposing
    // cloud credentials to any other Pi provider.
    const env: Record<string, string> = transportOwner["config"].authType === 'environment'
        ? pickExplicitEnvironment(BEDROCK_ENVIRONMENT_AUTH_KEYS)
        : {};
    if (piAuth?.credential.type === 'iam') {
        env["AWS_ACCESS_KEY_ID"] = piAuth.credential.accessKeyId;
        env["AWS_SECRET_ACCESS_KEY"] = piAuth.credential.secretAccessKey;
        if (piAuth.credential.region)
            env["AWS_REGION"] = piAuth.credential.region;
        if (piAuth.credential.sessionToken)
            env["AWS_SESSION_TOKEN"] = piAuth.credential.sessionToken;
        transportOwner["debug"]('Injecting IAM credentials into subprocess env for AWS SDK');
    }
    // Defensive: force HTTP/1.1 for Bedrock. AWS SDK v3 defaults to HTTP/2
    // (NodeHttp2Handler) which can be incompatible with Bun/Electron runtimes.
    env["AWS_BEDROCK_FORCE_HTTP1"] = process.env["AWS_BEDROCK_FORCE_HTTP1"]
        || env["AWS_BEDROCK_FORCE_HTTP1"]
        || '1';
    return env;
}

/**
   * Preserve non-secret provider bootstrap values only for the provider that
   * consumes them. They are deliberately not part of the generic host env.
   */
export function buildProviderEnv(_transportOwner: PiAgent, runtime: PiBuildProviderEnvRuntimePayload): Record<string, string> {
    return buildPiProviderEnvironment(runtime.piAuthProvider, process.env, runtime.googleCloudProject);
}

/**
   * Refresh OAuth tokens and push updated credentials to the running subprocess.
   * Handles both Copilot (Pi SDK) and ChatGPT Plus token refresh.
   */
export async function refreshAndPushTokens(transportOwner: PiAgent, agentClass: typeof PiAgent): Promise<void> {
    if (transportOwner["config"].authType !== 'oauth')
        return;
    const slug = transportOwner["config"].connectionSlug || 'pi';
    const expectedBindingId = transportOwner["config"].expectedLlmCredentialBindingId;
    const refreshKey = `${slug}\u0000${expectedBindingId ?? 'unsealed'}`;
    // Global mutex — if another PiAgent instance on the same connection slug
    // is already refreshing, just wait for that to finish and push the
    // (now-fresh) credentials to our subprocess.
    const existing = agentClass.globalRefreshMutex.get(refreshKey);
    if (existing) {
        transportOwner["debug"](`Waiting on existing refresh for slug "${slug}"`);
        const outcome = await existing;
        // Reuse the credential returned by the successful owner. Re-reading the
        // store after a failed refresh could return and push the expired token.
        if (outcome.refreshed
            && outcome.bindingId === expectedBindingId
            && transportOwner["subprocess"]) {
            transportOwner["send"]({ type: 'token_update', piAuth: outcome.piAuth });
            transportOwner["debug"]('Pushed credentials refreshed by sibling instance');
        }
        return;
    }
    const refreshPromise: Promise<TokenRefreshOutcome> = (async () => {
        const piAuthProvider = getBackendRuntime(transportOwner["config"]).piAuthProvider;
        const credentialManager = getCredentialManager();
        const stored = await credentialManager.getLlmOAuth(slug, expectedBindingId);
        if (!stored?.refreshToken) {
            transportOwner["debug"]('No refresh token available — re-auth required');
            transportOwner["onBackendAuthRequired"]?.('No refresh token — please sign in again');
            return { refreshed: false };
        }
        try {
            if (piAuthProvider === 'github-copilot') {
                // Copilot: refresh the short-lived Copilot token using the GitHub access token
                const { refreshGitHubCopilotToken } = await import("../../auth/copilot-oauth.ts");
                const newCreds = await refreshGitHubCopilotToken(stored.refreshToken);
                await credentialManager.refreshLlmOAuth(slug, {
                    accessToken: newCreds.access,
                    refreshToken: newCreds.refresh,
                    expiresAt: newCreds.expires,
                }, expectedBindingId);
            }
            else if (piAuthProvider === 'google-gemini-code-assist') {
                const { refreshGoogleGeminiTokens } = await import('@craft-agent/shared/auth');
                const newTokens = await refreshGoogleGeminiTokens(stored.refreshToken);
                await credentialManager.refreshLlmOAuth(slug, {
                    accessToken: newTokens.accessToken,
                    ...(newTokens.idToken !== undefined ? { idToken: newTokens.idToken } : {}),
                    refreshToken: newTokens.refreshToken ?? stored.refreshToken,
                    expiresAt: newTokens.expiresAt,
                }, expectedBindingId);
            }
            else {
                // ChatGPT Plus: use existing refresh utility
                const newTokens = await refreshChatGptTokens(stored.refreshToken);
                await credentialManager.refreshLlmOAuth(slug, {
                    accessToken: newTokens.accessToken,
                    idToken: newTokens.idToken,
                    ...(newTokens.refreshToken !== undefined ? { refreshToken: newTokens.refreshToken } : {}),
                    ...(newTokens.expiresAt !== undefined ? { expiresAt: newTokens.expiresAt } : {}),
                }, expectedBindingId);
            }
            transportOwner["debug"]('Token refresh successful');
            // Read only after the credential write completed. The resulting
            // payload is also handed to sibling waiters so none re-read stale data.
            const piAuth = await transportOwner.getPiAuth();
            if (!piAuth) {
                transportOwner["debug"]('Token refresh completed but no fresh credential was available');
                transportOwner["onBackendAuthRequired"]?.('Token refresh completed without a usable credential — please sign in again');
                return { refreshed: false };
            }
            if (transportOwner["subprocess"]) {
                transportOwner["send"]({ type: 'token_update', piAuth });
                transportOwner["debug"]('Pushed refreshed credentials to subprocess');
            }
            return { refreshed: true, piAuth, ...(expectedBindingId !== undefined ? { bindingId: expectedBindingId } : {}) };
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            transportOwner["debug"](`Token refresh failed: ${msg}`);
            transportOwner["onBackendAuthRequired"]?.(`Token refresh failed: ${msg}`);
            return { refreshed: false };
        }
    })();
    // Share the refresh promise across instances using this credential.
    agentClass.globalRefreshMutex.set(refreshKey, refreshPromise);
    try {
        await refreshPromise;
    }
    finally {
        // Only clear global if it's still our promise (no newer refresh started)
        if (agentClass.globalRefreshMutex.get(refreshKey) === refreshPromise) {
            agentClass.globalRefreshMutex.delete(refreshKey);
        }
    }
}

/**
   * Retrieve API key from the credential manager for subprocess injection.
   * Legacy fallback when piAuthProvider is not set.
   * The subprocess expects a single API key string (passed via init.apiKey).
   */
export async function getApiKey(transportOwner: PiAgent): Promise<string | null> {
    try {
        const credentialManager = getCredentialManager();
        const slug = transportOwner["config"].connectionSlug || 'pi';
        // Try LLM OAuth first (for OAuth-based connections)
        const oauth = await credentialManager.getLlmOAuth(slug, transportOwner["config"].expectedLlmCredentialBindingId);
        if (oauth?.accessToken) {
            transportOwner["debug"]('Retrieved API key from LLM OAuth');
            return oauth.accessToken;
        }
        // Try Anthropic API key
        const apiKey = transportOwner["config"].expectedLlmCredentialBindingId
            ? await credentialManager.getLlmApiKey(slug, transportOwner["config"].expectedLlmCredentialBindingId)
            : await credentialManager.getApiKey();
        if (apiKey) {
            transportOwner["debug"]('Retrieved Anthropic API key');
            return apiKey;
        }
        transportOwner["debug"]('No API keys found for Pi agent');
        return null;
    }
    catch (error) {
        transportOwner["debug"](`Failed to retrieve API key: ${error}`);
        return null;
    }
}
