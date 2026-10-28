import type { AgentEvent } from "@craft-agent/core/types";
import { buildRestrictedSubprocessEnvironment } from "../../processes/index.ts";
import { redactSecretLikeMaterial } from "../../utils/redaction.ts";

export const RUNTIME_DIAGNOSTIC_MAX_CHARS = 4000;

export const DEFAULT_SUBPROCESS_STARTUP_TIMEOUT_MS = 20000;

export const MAX_SUBPROCESS_STARTUP_TIMEOUT_MS = 120000;

export const PI_SUBPROCESS_FORCE_KILL_DELAY_MS = 2000;

export interface PiSubprocessRuntimeContext {
    runtimeId: string;
    sessionId: string;
}

export type PiRuntimeInterruptionCode = Extract<AgentEvent, {
    type: 'runtime_interrupted';
}>['code'];

export class PiRuntimeInterruptedError extends Error {
    readonly interruptionCode: PiRuntimeInterruptionCode;
    constructor(message: string, interruptionCode: PiRuntimeInterruptionCode) {
        super(message);
        this.name = 'PiRuntimeInterruptedError';
        this.interruptionCode = interruptionCode;
    }
}

export function resolvePiSubprocessStartupTimeoutMs(value: string | undefined): number {
    if (value === undefined)
        return DEFAULT_SUBPROCESS_STARTUP_TIMEOUT_MS;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0
        ? Math.min(Math.floor(parsed), MAX_SUBPROCESS_STARTUP_TIMEOUT_MS)
        : DEFAULT_SUBPROCESS_STARTUP_TIMEOUT_MS;
}

/** Inputs intentionally granted to one Pi subprocess generation. */
export interface PiSubprocessEnvironmentOptions {
    proxyEnv?: Record<string, string>;
    envOverrides?: Record<string, string>;
    providerEnv?: Record<string, string>;
    awsEnv?: Record<string, string>;
    sessionDir?: string;
    debugEnabled: boolean;
}

/**
 * Build Pi's child environment without inheriting unrelated host credentials.
 * Provider credentials and per-session values must arrive through an explicit
 * input map, making the privilege boundary reviewable at the call site.
 */
export function buildPiSubprocessEnvironment(options: PiSubprocessEnvironmentOptions, baseEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
    return buildRestrictedSubprocessEnvironment({
        RTK_TELEMETRY_DISABLED: '1',
        ...options.proxyEnv,
        ...options.envOverrides,
        ...options.providerEnv,
        ...options.awsEnv,
        ...(options.sessionDir ? { CRAFT_SESSION_DIR: options.sessionDir } : {}),
        CRAFT_DEBUG: options.debugEnabled ? '1' : '0',
    }, baseEnv);
}

export const BEDROCK_ENVIRONMENT_AUTH_KEYS = [
    // Static/session credentials. These are copied only when the user selected
    // the Bedrock environment credential chain for this connection.
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_SECURITY_TOKEN',
    'AWS_BEARER_TOKEN_BEDROCK',
    // Profile, region and shared credential/config file routing.
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_PROFILE',
    'AWS_DEFAULT_PROFILE',
    'AWS_CONFIG_FILE',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_SDK_LOAD_CONFIG',
    'AWS_CA_BUNDLE',
    // Workload identity / container / instance role credential chain.
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_ROLE_ARN',
    'AWS_ROLE_SESSION_NAME',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
    'AWS_EC2_METADATA_DISABLED',
    'AWS_EC2_METADATA_SERVICE_ENDPOINT',
    'AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE',
    // Explicit Bedrock endpoint/runtime controls.
    'AWS_ENDPOINT_URL',
    'AWS_ENDPOINT_URL_BEDROCK',
    'AWS_BEDROCK_FORCE_HTTP1',
] as const;

export function pickExplicitEnvironment(keys: readonly string[], baseEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of keys) {
        const value = baseEnv[key];
        if (typeof value === 'string')
            env[key] = value;
    }
    return env;
}

export const PROVIDER_CONTRACT_ENVIRONMENT_KEYS = [
    'ROBB_DISABLE_UNSTABLE_PROVIDERS',
    'ROBB_DISABLE_CHATGPT_CODEX_BACKEND',
    'ROBB_DISABLE_GITHUB_COPILOT_PROXY',
    'ROBB_DISABLE_GOOGLE_CODE_ASSIST_V1INTERNAL',
] as const;

/**
 * Grant only non-secret bootstrap and emergency contract controls to Pi.
 * Scoped switches are limited to the selected provider; the master switch is
 * intentionally common to every Pi subprocess.
 */
export function buildPiProviderEnvironment(piAuthProvider: string | undefined, baseEnv: NodeJS.ProcessEnv = process.env, googleCloudProject?: string): Record<string, string> {
    const keys: string[] = [PROVIDER_CONTRACT_ENVIRONMENT_KEYS[0]];
    if (piAuthProvider === 'openai-codex')
        keys.push(PROVIDER_CONTRACT_ENVIRONMENT_KEYS[1]);
    if (piAuthProvider === 'github-copilot')
        keys.push(PROVIDER_CONTRACT_ENVIRONMENT_KEYS[2]);
    if (piAuthProvider === 'google-gemini-code-assist') {
        keys.push(PROVIDER_CONTRACT_ENVIRONMENT_KEYS[3], 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT_ID');
    }
    if (piAuthProvider === 'mistral-vibe')
        keys.push('ROBB_VIBE_ACP_COMMAND');
    if (piAuthProvider === 'google-antigravity')
        keys.push('ROBB_ANTIGRAVITY_COMMAND');
    const environment = pickExplicitEnvironment(keys, baseEnv);
    if (piAuthProvider === 'google-gemini-code-assist' && googleCloudProject?.trim()) {
        environment["GOOGLE_CLOUD_PROJECT"] = googleCloudProject.trim();
        delete environment["GOOGLE_CLOUD_PROJECT_ID"];
    }
    return environment;
}

export type PiAuthPayload = {
    provider: string;
    credential: {
        type: 'api_key';
        key: string;
    } | {
        type: 'oauth';
        access: string;
        refresh: string;
        expires: number;
    } | {
        type: 'iam';
        accessKeyId: string;
        secretAccessKey: string;
        region?: string;
        sessionToken?: string;
    };
};

export type TokenRefreshOutcome = {
    refreshed: false;
} | {
    refreshed: true;
    piAuth: PiAuthPayload;
    bindingId?: string;
};

export const PREEMPTIVE_PI_OAUTH_PROVIDERS = new Set([
    'openai-codex',
    'github-copilot',
    'google-gemini-code-assist',
]);

/**
 * Decide whether a cold Pi runtime must join/start OAuth refresh before it
 * reads credentials. Joining an in-flight refresh closes the race where an
 * auth-failed runtime is disposed while its replacement still sees the stale
 * token.
 */
export function shouldRefreshPiOAuthBeforeSpawn(input: {
    authType?: string;
    piAuthProvider?: string;
    refreshToken?: string;
    expiresAt?: number;
    refreshInFlight: boolean;
    nowMs?: number;
}): boolean {
    if (input.authType !== 'oauth')
        return false;
    if (!input.piAuthProvider || !PREEMPTIVE_PI_OAUTH_PROVIDERS.has(input.piAuthProvider)) {
        return false;
    }
    if (input.refreshInFlight)
        return true;
    if (!input.refreshToken)
        return false;
    const nowMs = input.nowMs ?? Date.now();
    return !input.expiresAt || input.expiresAt < nowMs + 5 * 60000;
}

// Supplement the shared free-text redactor with credential formats that can
// appear in Pi/provider stderr without an `Authorization: Bearer` prefix.
// Keep this narrow: stderr remains useful, while known credential material is
// removed before it reaches either onDebug or a user-facing connection error.
export function redactRuntimeDiagnosticText(value: string): string {
    const sensitiveKey = [
        'authorization',
        'proxy[_-]?authorization',
        'api[_-]?key',
        'access[_-]?token',
        'refresh[_-]?token',
        'session[_-]?token',
        'password',
        'passwd',
        'passphrase',
        'client[_-]?secret',
        'secret[_-]?access[_-]?key',
        'aws[_-]?secret[_-]?access[_-]?key',
        'private[_-]?key',
        'signing[_-]?key',
    ].join('|');
    return redactSecretLikeMaterial(value)
        // Quoted JSON/logfmt keys and values.
        .replace(new RegExp(`(["'](?:${sensitiveKey})["']\\s*:\\s*)["'][^"'\\r\\n]*["']`, 'gi'), '$1"[REDACTED]"')
        // Environment variables and unquoted logfmt values.
        .replace(new RegExp(`(\\b(?:${sensitiveKey})\\b\\s*[=:]\\s*)[^\\s,;]+`, 'gi'), '$1[REDACTED]')
        // Common opaque credential formats when stderr prints only the value.
        .replace(/\bsk-(?:(?:proj|ant(?:-api\d+)?)-)?[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
        .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]')
        .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED]')
        .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
}

// ============================================================
// PiAgent Implementation
// ============================================================
/** Backend-executed session tools currently supported by PiAgent. */
export const PI_BACKEND_SESSION_TOOL_NAMES = new Set<string>([
    'call_llm',
    'spawn_session',
    'browser_tool',
]);

/**
 * Map a transport `err.code` to an agent-facing string for `browser_tool` failures.
 * Returns null for unknown codes so callers can fall back to the raw `err.message`.
 *
 * Receiver-side check: keyed on `err.code === 'X'`, never `instanceof CodedError` —
 * the transport reconstructs a plain `Error` with `.code` attached.
 */
export function mapBrowserToolErrorCode(code: string): string | null {
    switch (code) {
        case 'BROWSER_NO_CAPABLE_CLIENT':
        case 'CAPABILITY_UNAVAILABLE':
            return 'No connected desktop client supports browser tools, or no client is currently connected. ' +
                'Ask the user to open this workspace from the Robb Agents desktop app.';
        case 'CLIENT_DISCONNECTED':
            return 'The desktop client that owned this browser session disconnected. ' +
                'Ask the user to reconnect and retry.';
        case 'CLIENT_REQUEST_TIMEOUT':
            return 'Browser operation timed out (>30s). The desktop client may be unresponsive.';
        case 'BROWSER_INSTANCE_NOT_OWNED':
            return 'That browser instance ID doesn\'t belong to this session. ' +
                'Use `windows` to list owned instances, or `open` to create a new one.';
        case 'BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED':
            return 'File upload from a remote agent is not supported. ' +
                'Ask the user to attach the file to the session.';
        case 'BROWSER_REMOTE_EVALUATE_BLOCKED':
            return 'JavaScript evaluation is disabled on this desktop client. ' +
                'Ask the user to enable it in settings.';
        default:
            return null;
    }
}
