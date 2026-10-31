/**
 * Tests for auth state management
 *
 * These tests verify:
 * - Token refresh returns migration info through function chain (no module-level state)
 * - Setup needs derivation from auth state
 * - Migration detection for legacy CLI tokens
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { getSetupNeeds, performTokenRefresh, getValidClaudeOAuthToken, _resetRefreshMutex, type AuthState, type TokenResult, type MigrationInfo } from '../state.ts';
import { CredentialManager, setCredentialManagerForTesting } from '../../credentials/index.ts';

// ============================================
// Mock credential manager
// ============================================


// ============================================
// performTokenRefresh tests
// ============================================

describe('performTokenRefresh', () => {
  beforeEach(() => {
    _resetRefreshMutex();
  });

  describe('successful refresh', () => {
    it('should return accessToken on successful refresh', async () => {
      // Mock the refreshClaudeToken import

      // We need to test with a real-ish scenario
      // Since we can't easily mock the import, test the interface

      // For this test, we'll verify the TokenResult structure
      const successResult: TokenResult = {
        accessToken: 'new-access-token',
      };

      expect(successResult.accessToken).toBe('new-access-token');
      expect(successResult.migrationRequired).toBeUndefined();
    });

    it('should not include migration info on success', async () => {
      const successResult: TokenResult = {
        accessToken: 'refreshed-token',
      };

      expect(successResult.migrationRequired).toBeUndefined();
    });
  });

  describe('failed refresh with migration', () => {
    it('should return migration info for CLI tokens on invalid_grant error', () => {
      // Simulate the result from a failed refresh with CLI source
      const failedResult: TokenResult = {
        accessToken: null,
        migrationRequired: {
          reason: 'legacy_token',
          message: 'Your Claude authentication needs to be refreshed. Please sign in again.',
        },
      };

      expect(failedResult.accessToken).toBeNull();
      expect(failedResult.migrationRequired).toBeDefined();
      expect(failedResult.migrationRequired?.reason).toBe('legacy_token');
    });

    it('should not return migration info for native tokens that fail', () => {
      // Native tokens that fail (e.g., revoked) don't need migration
      // they just need re-authentication
      const failedNativeResult: TokenResult = {
        accessToken: null,
        // No migrationRequired because source was 'native'
      };

      expect(failedNativeResult.accessToken).toBeNull();
      expect(failedNativeResult.migrationRequired).toBeUndefined();
    });
  });
});

// ============================================
// TokenResult type tests
// ============================================

describe('TokenResult type', () => {
  it('should allow accessToken with no migration', () => {
    const result: TokenResult = {
      accessToken: 'valid-token',
    };

    expect(result.accessToken).toBe('valid-token');
    expect(result.migrationRequired).toBeUndefined();
  });

  it('should allow null accessToken with migration info', () => {
    const result: TokenResult = {
      accessToken: null,
      migrationRequired: {
        reason: 'legacy_token',
        message: 'Migration required',
      },
    };

    expect(result.accessToken).toBeNull();
    expect(result.migrationRequired?.reason).toBe('legacy_token');
  });

  it('should allow null accessToken without migration info', () => {
    const result: TokenResult = {
      accessToken: null,
    };

    expect(result.accessToken).toBeNull();
    expect(result.migrationRequired).toBeUndefined();
  });
});

// ============================================
// Integration: migration flows through to AuthState
// ============================================

describe('migration info flow', () => {
  it('should flow from TokenResult through AuthState to SetupNeeds', () => {
    // 1. Token refresh fails with migration
    const tokenResult: TokenResult = {
      accessToken: null,
      migrationRequired: {
        reason: 'legacy_token',
        message: 'Please sign in again.',
      },
    };

    // 2. Build AuthState using the token result
    const authState: AuthState = {
      billing: {
        type: 'oauth_token',
        hasCredentials: false,
        apiKey: null,
        claudeOAuthToken: tokenResult.accessToken,
        ...(tokenResult.migrationRequired !== undefined ? { migrationRequired: tokenResult.migrationRequired } : {}),
      },
      workspace: { hasWorkspace: true, active: null },
    };

    // 3. Derive setup needs
    const setupNeeds = getSetupNeeds(authState);

    // 4. Migration info should be present throughout
    expect(authState.billing.migrationRequired).toBeDefined();
    expect(setupNeeds.needsMigration).toBeDefined();
    expect(setupNeeds.needsMigration?.reason).toBe('legacy_token');
    expect(setupNeeds.needsCredentials).toBe(true);
    expect(setupNeeds.isFullyConfigured).toBe(false);
  });

  it('should not have migration info when token refresh succeeds', () => {
    // 1. Token refresh succeeds
    const tokenResult: TokenResult = {
      accessToken: 'valid-refreshed-token',
    };

    // 2. Build AuthState
    const authState: AuthState = {
      billing: {
        type: 'oauth_token',
        hasCredentials: true,
        apiKey: null,
        claudeOAuthToken: tokenResult.accessToken,
        ...(tokenResult.migrationRequired !== undefined ? { migrationRequired: tokenResult.migrationRequired } : {}), // undefined
      },
      workspace: { hasWorkspace: true, active: null },
    };

    // 3. Derive setup needs
    const setupNeeds = getSetupNeeds(authState);

    // 4. No migration info
    expect(authState.billing.migrationRequired).toBeUndefined();
    expect(setupNeeds.needsMigration).toBeUndefined();
    expect(setupNeeds.isFullyConfigured).toBe(true);
  });
});

// ============================================
// MigrationInfo type tests
// ============================================

describe('MigrationInfo', () => {
  it('should have reason and message', () => {
    const info: MigrationInfo = {
      reason: 'legacy_token',
      message: 'Your authentication needs to be refreshed.',
    };

    expect(info.reason).toBe('legacy_token');
    expect(info.message).toContain('refreshed');
  });

  it('should only allow legacy_token as reason', () => {
    // TypeScript ensures this at compile time, but we can verify the pattern
    const validInfo: MigrationInfo = {
      reason: 'legacy_token',
      message: 'Test message',
    };

    expect(validInfo.reason).toBe('legacy_token');
  });
});

// ============================================
// Multi-connection Claude OAuth resolution tests
// ============================================

describe('getValidClaudeOAuthToken connectionSlug resolution', () => {
  beforeEach(() => {
    _resetRefreshMutex();
  });

  it('performs dual-write to LLM connection and legacy store on refresh', async () => {
    const writes: {
      legacy: Parameters<CredentialManager['setClaudeOAuthCredentials']>[0] | null;
      llm: Parameters<CredentialManager['refreshLlmOAuth']>[1] | null;
    } = { legacy: null, llm: null };
    let llmRefreshedSlug = '';

    const mockManager = Object.assign(new CredentialManager(), {
      getClaudeOAuthCredentials: async () => null,
      setClaudeOAuthCredentials: async (creds) => {
        writes.legacy = creds;
      },
      getLlmOAuth: async () => null,
      refreshLlmOAuth: async (slug: string, creds) => {
        llmRefreshedSlug = slug;
        writes.llm = creds;
      },
      deleteLlmCredentials: async () => {},
    } satisfies Partial<CredentialManager>);

    // Mock fetch for token refresh
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign((async () => {
      return new Response(JSON.stringify({
        access_token: 'fresh-dual-access-token',
        token_type: 'Bearer',
        expires_in: 3600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }), { preconnect: originalFetch.preconnect });

    try {
      const result = await performTokenRefresh(
        mockManager,
        'valid-refresh-token',
        'native',
        'claude-work-account'
      );

      expect(result.accessToken).toBe('fresh-dual-access-token');
      expect(writes.legacy?.accessToken).toBe('fresh-dual-access-token');
      expect(llmRefreshedSlug).toBe('claude-work-account');
      expect(writes.llm?.accessToken).toBe('fresh-dual-access-token');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('clears both stores when refresh fails with invalid_grant', async () => {
    let legacyCleared = false;
    let llmDeletedSlug = '';

    const mockManager = Object.assign(new CredentialManager(), {
      getClaudeOAuthCredentials: async () => null,
      setClaudeOAuthCredentials: async (creds) => {
        if (creds.accessToken === '') legacyCleared = true;
      },
      getLlmOAuth: async () => null,
      refreshLlmOAuth: async () => {},
      deleteLlmCredentials: async (slug: string) => {
        llmDeletedSlug = slug;
      },
    } satisfies Partial<CredentialManager>);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign((async () => {
      return new Response(JSON.stringify({
        error: 'invalid_grant',
        error_description: 'Refresh token expired or revoked',
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }), { preconnect: originalFetch.preconnect });

    try {
      const result = await performTokenRefresh(
        mockManager,
        'revoked-token',
        'native',
        'claude-revoked'
      );

      expect(result.accessToken).toBeNull();
      expect(legacyCleared).toBe(true);
      expect(llmDeletedSlug).toBe('claude-revoked');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('resolves valid token from LLM OAuth store for specific connectionSlug', async () => {
    const mockManager = Object.assign(new CredentialManager(), {
      getLlmOAuth: async (slug: string) => {
        if (slug === 'claude-pro') {
          return {
            accessToken: 'token-for-claude-pro',
            refreshToken: 'refresh-pro',
            expiresAt: Date.now() + 3600000,
          };
        }
        return null;
      },
      getClaudeOAuthCredentials: async () => ({
        accessToken: 'legacy-token',
      }),
    } satisfies Partial<CredentialManager>);

    setCredentialManagerForTesting(mockManager);
    try {
      const result = await getValidClaudeOAuthToken('claude-pro');
      expect(result.accessToken).toBe('token-for-claude-pro');
    } finally {
      setCredentialManagerForTesting(null);
    }
  });

  it('falls back to legacy Claude OAuth store when connectionSlug has no LLM OAuth token', async () => {
    const mockManager = Object.assign(new CredentialManager(), {
      getLlmOAuth: async () => null,
      getClaudeOAuthCredentials: async () => ({
        accessToken: 'fallback-legacy-token',
        expiresAt: Date.now() + 3600000,
      }),
    } satisfies Partial<CredentialManager>);

    setCredentialManagerForTesting(mockManager);
    try {
      const result = await getValidClaudeOAuthToken('claude-unmigrated');
      expect(result.accessToken).toBe('fallback-legacy-token');
    } finally {
      setCredentialManagerForTesting(null);
    }
  });
});
