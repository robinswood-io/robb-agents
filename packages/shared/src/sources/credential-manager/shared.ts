

/**
 * Result of authentication attempt
 */
export interface AuthResult {
    success: boolean;
    error?: string;
    /** For Gmail OAuth, includes user's email */
    email?: string;
}

/**
 * API credential types (string for simple auth, object for basic auth or multi-header)
 */
export interface BasicAuthCredential {
    username: string;
    password: string;
}

/**
 * Multi-header credentials stored as Record<string, string>
 * Used for APIs like Datadog that require multiple auth headers (DD-API-KEY + DD-APPLICATION-KEY)
 */
export type MultiHeaderCredential = Record<string, string>;

export type ApiCredential = string | BasicAuthCredential | MultiHeaderCredential;

/**
 * Type guard to check if credential is a MultiHeaderCredential.
 * Returns true for Record<string, string> objects that are NOT BasicAuthCredential.
 */
export function isMultiHeaderCredential(cred: ApiCredential): cred is MultiHeaderCredential {
    return (typeof cred === 'object' &&
        cred !== null &&
        !('username' in cred && 'password' in cred));
}

// ============================================================
// Token substitution helpers for renew endpoint
// ============================================================
/**
 * Recursively substitute {{token}} in string leaves of an object.
 * Supports nested objects and arrays.
 */
export function substituteTokenInBody(obj: Record<string, unknown>, token: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string') {
            result[key] = value.replace(/\{\{token\}\}/g, token);
        }
        else if (Array.isArray(value)) {
            result[key] = value.map(item => typeof item === 'string' ? item.replace(/\{\{token\}\}/g, token) :
                (item && typeof item === 'object' ? substituteTokenInBody(item as Record<string, unknown>, token) : item));
        }
        else if (value && typeof value === 'object') {
            result[key] = substituteTokenInBody(value as Record<string, unknown>, token);
        }
        else {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Substitute {{token}} in header values.
 */
export function substituteTokenInHeaders(headers: Record<string, string> | undefined, token: string): Record<string, string> {
    if (!headers)
        return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        result[key] = value.replace(/\{\{token\}\}/g, token);
    }
    return result;
}
