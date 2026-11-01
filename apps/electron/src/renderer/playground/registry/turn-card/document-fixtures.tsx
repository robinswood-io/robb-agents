
// ============================================================================
// Fullscreen Overlay Components
// ============================================================================

/** Sample markdown content for fullscreen testing */
export const sampleMarkdownContent = `# Authentication System Analysis

I've completed my analysis of the authentication system. Here's what I found:

## Overview

The authentication system is built around three main components that work together to provide secure user authentication.

### 1. AuthHandler (\`src/auth/index.ts\`)

This is the main entry point for all authentication operations:

- Manages the OAuth 2.0 flow
- Handles token validation and refresh
- Provides session management
- Supports multiple identity providers (Google, GitHub, Microsoft)

\`\`\`typescript
export class AuthHandler {
  private oauth: OAuthClient;
  private tokenManager: TokenManager;
  private sessionStore: SessionStore;

  async authenticate(credentials: Credentials): Promise<Session> {
    // Validate credentials format
    this.validateCredentials(credentials);

    // Get OAuth token from provider
    const token = await this.oauth.getToken(credentials);

    // Create and store session
    return this.createSession(token);
  }

  async refreshToken(session: Session): Promise<Session> {
    const newToken = await this.oauth.refresh(session.refreshToken);
    return this.updateSession(session.id, newToken);
  }
}
\`\`\`

### 2. TokenManager (\`src/auth/tokens.ts\`)

Handles secure token storage and lifecycle:

- Stores tokens securely using AES-256 encryption
- Handles automatic token refresh before expiry (5 minute buffer)
- Provides token revocation and cleanup
- Supports both access tokens and refresh tokens

### 3. SessionStore (\`src/auth/sessions.ts\`)

Maintains active user sessions with the following features:

- In-memory session cache for fast lookups
- Persistent storage backed by Redis
- Automatic session timeout and cleanup
- Session restoration on app restart

## Security Considerations

The current implementation has several security strengths:

1. **Token encryption** - All tokens are encrypted at rest
2. **Short-lived tokens** - Access tokens expire in 15 minutes
3. **Secure refresh** - Refresh tokens are rotated on each use
4. **Session binding** - Sessions are bound to device fingerprint

However, I noticed a few areas that could be improved:

- **PKCE support** - Not currently implemented for public clients
- **Rate limiting** - Auth endpoints lack rate limiting
- **Audit logging** - Authentication events aren't logged

## Recommendations

Based on my analysis, here are my recommendations:

1. **Implement PKCE** for all OAuth flows to prevent authorization code interception
2. **Add rate limiting** to prevent brute force attacks (suggest: 5 attempts per minute)
3. **Enable audit logging** for security monitoring and compliance
4. **Add MFA support** for sensitive operations

Would you like me to implement any of these improvements?`

/** Plan-style content for testing plan variant */
export const samplePlanContent = `# Implement Authentication Improvements

## Summary

This plan outlines the implementation of security improvements to the authentication system based on the analysis findings.

## Steps

### 1. Implement PKCE Support

Add PKCE (Proof Key for Code Exchange) to all OAuth flows:

- Generate code verifier and challenge on auth start
- Include code_challenge in authorization request
- Verify code_verifier on token exchange

**Files to modify:**
- \`src/auth/oauth.ts\`
- \`src/auth/index.ts\`

### 2. Add Rate Limiting

Implement rate limiting on authentication endpoints:

- Configure limits: 5 attempts per minute per IP
- Use sliding window algorithm
- Add Redis-backed rate limiter

**New files:**
- \`src/middleware/rate-limiter.ts\`

### 3. Enable Audit Logging

Add comprehensive audit logging for auth events:

- Log successful/failed login attempts
- Track token refresh and revocation
- Include metadata (IP, user agent, timestamp)

**Files to modify:**
- \`src/auth/index.ts\`
- \`src/lib/logger.ts\`

### 4. Add MFA Support

Implement multi-factor authentication:

- Support TOTP (Google Authenticator, Authy)
- Add SMS fallback option
- Implement backup codes

**New files:**
- \`src/auth/mfa.ts\`
- \`src/auth/totp.ts\`

## Testing

After implementation, we'll need to:

1. Update existing auth tests
2. Add PKCE verification tests
3. Add rate limiting tests
4. Add MFA enrollment/verification tests

## Timeline

Estimated completion: 3-4 days`

// ============================================================================
// Generic Overlay - Playground Wrapper
// ============================================================================

export const sampleGenericContent = `# WebFetch Result

Fetched content from https://docs.example.com/api/authentication

## Authentication

All API requests require authentication using a Bearer token in the Authorization header:

\`\`\`
Authorization: Bearer YOUR_API_KEY
\`\`\`

### Rate Limits

| Plan       | Requests/min | Burst |
|-----------|-------------|-------|
| Free       | 60          | 10    |
| Pro        | 600         | 100   |
| Enterprise | 6000        | 1000  |

### Error Responses

When authentication fails, the API returns:

\`\`\`json
{
  "error": {
    "code": "unauthorized",
    "message": "Invalid or expired API key",
    "status": 401
  }
}
\`\`\`

For more details, see the [API Reference](https://docs.example.com/api).`
