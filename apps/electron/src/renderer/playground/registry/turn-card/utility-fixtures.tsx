
// ============================================================================
// Terminal Preview Overlay - Playground Wrapper
// ============================================================================

export const sampleBashOutput = `> npm test

 PASS  src/auth/__tests__/handler.test.ts (2.341s)
  AuthHandler
    ✓ should authenticate with valid credentials (45ms)
    ✓ should reject invalid credentials (12ms)
    ✓ should refresh expired tokens (23ms)
    ✓ should handle token revocation (8ms)
    ✓ should validate PKCE challenge (15ms)

 PASS  src/auth/__tests__/tokens.test.ts (1.892s)
  TokenManager
    ✓ should encrypt tokens at rest (34ms)
    ✓ should decrypt stored tokens (28ms)
    ✓ should schedule automatic refresh (5ms)
    ✓ should handle decryption failures gracefully (11ms)
    ✓ should revoke tokens and cleanup timers (7ms)

 PASS  src/middleware/__tests__/rate-limiter.test.ts (0.956s)
  RateLimiter
    ✓ should allow requests under limit (3ms)
    ✓ should block requests over limit (4ms)
    ✓ should reset after window expires (102ms)

Test Suites: 3 passed, 3 total
Tests:       13 passed, 13 total
Snapshots:   0 total
Time:        5.412s
Ran all test suites.`

export const sampleGrepOutput = `src/auth/index.ts:15:export class AuthHandler {
src/auth/index.ts:42:  async authenticate(credentials: Credentials): Promise<Session> {
src/auth/index.ts:67:  async refreshToken(session: Session): Promise<Session> {
src/auth/oauth.ts:8:export class OAuthClient {
src/auth/oauth.ts:23:  async getToken(credentials: Credentials): Promise<AuthToken> {
src/auth/tokens.ts:12:export class TokenManager {
src/auth/tokens.ts:34:  async storeToken(sessionId: string, token: AuthToken): Promise<void> {
src/auth/tokens.ts:52:  async getToken(sessionId: string): Promise<AuthToken | null> {
src/middleware/rate-limiter.ts:9:export class RateLimiter {
src/middleware/rate-limiter.ts:18:  async isAllowed(key: string): Promise<boolean> {`

export const sampleGlobOutput = `src/auth/index.ts
src/auth/oauth.ts
src/auth/tokens.ts
src/auth/sessions.ts
src/auth/types.ts
src/auth/__tests__/handler.test.ts
src/auth/__tests__/tokens.test.ts
src/auth/__tests__/sessions.test.ts
src/auth/mfa.ts
src/auth/totp.ts`

export const sampleBashErrorOutput = `> npm run deploy

Error: Command failed with exit code 1
  at ChildProcess.exithandler (node:child_process:420:12)
  at ChildProcess.emit (node:events:519:28)

npm ERR! code ELIFECYCLE
npm ERR! errno 1
npm ERR! myapp@1.0.0 deploy: \`aws s3 sync ./dist s3://my-bucket\`
npm ERR! Exit status 1
npm ERR!
npm ERR! Failed at the myapp@1.0.0 deploy script.

An error occurred during deployment. Check your AWS credentials and permissions.`

// ============================================================================
// JSON Preview Overlay - Playground Wrapper
// ============================================================================

export const sampleJsonData = {
  user: {
    id: 'usr_2x8kM9pQ',
    name: 'Jane Developer',
    email: 'jane@example.com',
    role: 'admin',
    permissions: ['read', 'write', 'delete', 'manage_users'],
    metadata: {
      created_at: '2024-01-15T10:30:00Z',
      last_login: '2025-01-24T14:22:00Z',
      login_count: 342,
      preferences: {
        theme: 'dark',
        language: 'en',
        notifications: {
          email: true,
          push: false,
          slack: true,
        },
      },
    },
  },
  organization: {
    id: 'org_4k2nR7wL',
    name: 'Acme Corp',
    plan: 'enterprise',
    members_count: 47,
    features: ['sso', 'audit_logs', 'custom_roles', 'api_access'],
    billing: {
      plan: 'enterprise',
      status: 'active',
      next_invoice: '2025-02-01',
      amount: 4999,
      currency: 'USD',
    },
  },
  api_keys: [
    { id: 'key_1', name: 'Production', prefix: 'sk_live_...', created: '2024-06-01' },
    { id: 'key_2', name: 'Staging', prefix: 'sk_test_...', created: '2024-08-15' },
    { id: 'key_3', name: 'Development', prefix: 'sk_dev_...', created: '2025-01-10' },
  ],
}

export const sampleNestedJsonData = {
  status: 'success',
  data: {
    results: [
      { id: 1, title: 'First Result', score: 0.95, tags: ['important', 'reviewed'] },
      { id: 2, title: 'Second Result', score: 0.87, tags: ['pending'] },
      { id: 3, title: 'Third Result', score: 0.72, tags: ['archived'] },
    ],
    pagination: { page: 1, per_page: 10, total: 3, total_pages: 1 },
    meta: { request_id: 'req_abc123', duration_ms: 42, cache_hit: false },
  },
}
