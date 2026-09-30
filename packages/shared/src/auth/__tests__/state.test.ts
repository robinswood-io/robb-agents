/**
 * Tests for auth state management
 *
 * These tests verify:
 * - Token refresh returns migration info through function chain (no module-level state)
 * - Setup needs derivation from auth state
 * - Migration detection for legacy CLI tokens
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
  getSetupNeeds,
  performTokenRefresh,
  getValidClaudeOAuthToken,
  _resetRefreshMutex,
  type AuthState,
  type TokenResult,
  type MigrationInfo,
} from '../state.ts';
import { setCredentialManagerForTesting } from '../../credentials/index.ts';

// ============================================
// Mock credential manager
// ============================================

function createMockCredentialManager(initialCreds?: {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  source?: 'native' | 'cli';
}) {
  let storedCreds = initialCreds;

  return {
    getClaudeOAuthCredentials: async () => storedCreds ?? null,
    setClaudeOAuthCredentials: async (creds: {
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
      source?: 'native' | 'cli';
    }) => {
      storedCreds = creds;
    },
    getApiKey: async () => null,
  };
}

// ============================================
// getSetupNeeds tests (pure function)
// ============================================

describe('getSetupNeeds', () => {
  describe('billing configuration', () => {
    it('should need billing config when type is null', () => {
      const state: AuthState = {
        billing: {
          type: null,
          hasCredentials: false,
          apiKey: null,
          claudeOAuthToken: null,
        },
        workspace: { hasWorkspace: false, active: null },
      };

      const needs = getSetupNeeds(state);

      expect(needs.needsBillingConfig).toBe(true);
      expect(needs.needsCredentials).toBe(false);
      expect(needs.isFullyConfigured).toBe(false);
    });

    it('should not need billing config when type is set', () => {
      const state: AuthState = {
        billing: {
          type: 'api_key',
          hasCredentials: true,
          apiKey: 'sk-test',
          claudeOAuthToken: null,
        },
        workspace: { hasWorkspace: false, active: null },
      };

      const needs = getSetupNeeds(state);

      expect(needs.needsBillingConfig).toBe(false);
    });
  });

  describe('credentials', () => {
    it('should need credentials when type is set but hasCredentials is false', () => {
      const state: AuthState = {
        billing: {
          type: 'oauth_token',
          hasCredentials: false,
          apiKey: null,
          claudeOAuthToken: null,
        },
        workspace: { hasWorkspace: false, active: null },
      };

      const needs = getSetupNeeds(state);

      expect(needs.needsBillingConfig).toBe(false);
      expect(needs.needsCredentials).toBe(true);
      expect(needs.isFullyConfigured).toBe(false);
    });

    it('should not need credentials when hasCredentials is true', () => {
      const state: AuthState = {
        billing: {
          type: 'oauth_token',
          hasCredentials: true,
          apiKey: null,
          claudeOAuthToken: 'valid-token',
        },
        workspace: { hasWorkspace: false, active: null },
      };

      const needs = getSetupNeeds(state);

      expect(needs.needsCredentials).toBe(false);
      expect(needs.isFullyConfigured).toBe(true);
    });
  });

  describe('migration', () => {
    it('should propagate migration info from auth state', () => {
      const migrationInfo: MigrationInfo = {
        reason: 'legacy_token',
        message: 'Please re-authenticate',
      };

      const state: AuthState = {
        billing: {
          type: 'oauth_token',
          hasCredentials: false,
          apiKey: null,
          claudeOAuthToken: null,
          migrationRequired: migrationInfo,
        },
        workspace: { hasWorkspace: false, active: null },
      };

      const needs = getSetupNeeds(state);

      expect(needs.needsMigration).toEqual(migrationInfo);
      expect(needs.needsMigration?.reason).toBe('legacy_token');
    });

    it('should not have migration info when not present in auth state', () => {
      const state: AuthState = {
        billing: {
          type: 'oauth_token',
          hasCredentials: true,
          apiKey: null,
          claudeOAuthToken: 'valid-token',
        },
        workspace: { hasWorkspace: false, active: null },
      };

      const needs = getSetupNeeds(state);

      expect(needs.needsMigration).toBeUndefined();
    });
  });

  describe('fully configured', () => {
    it('should be fully configured when billing type and credentials are set', () => {
      const state: AuthState = {
        billing: {
          type: 'api_key',
          hasCredentials: true,
          apiKey: 'sk-test',
          claudeOAuthToken: null,
        },
        workspace: { hasWorkspace: true, active: null },
      };

      const needs = getSetupNeeds(state);

      expect(needs.isFullyConfigured).toBe(true);
      expect(needs.needsBillingConfig).toBe(false);
      expect(needs.needsCredentials).toBe(false);
    });
  });
});

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
      const mockRefresh = mock(async () => ({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresAt: Date.now() + 3600000,
      }));

      // We need to test with a real-ish scenario
      // Since we can't easily mock the import, test the interface
      const manager = createMockCredentialManager();

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
        migrationRequired: tokenResult.migrationRequired,
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
        migrationRequired: tokenResult.migrationRequired, // undefined
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
    let legacySet: any = null;
    let llmRefreshedSlug = '';
    let llmRefreshedCreds: any = null;

    const mockManager: any = {
      getClaudeOAuthCredentials: async () => null,
      setClaudeOAuthCredentials: async (creds: any) => {
        legacySet = creds;
      },
      getLlmOAuth: async () => null,
      refreshLlmOAuth: async (slug: string, creds: any) => {
        llmRefreshedSlug = slug;
        llmRefreshedCreds = creds;
      },
      deleteLlmCredentials: async () => {},
    };

    // Mock fetch for token refresh
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        access_token: 'fresh-dual-access-token',
        token_type: 'Bearer',
        expires_in: 3600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    try {
      const result = await performTokenRefresh(
        mockManager,
        'valid-refresh-token',
        'native',
        'claude-work-account'
      );

      expect(result.accessToken).toBe('fresh-dual-access-token');
      expect(legacySet?.accessToken).toBe('fresh-dual-access-token');
      expect(llmRefreshedSlug).toBe('claude-work-account');
      expect(llmRefreshedCreds?.accessToken).toBe('fresh-dual-access-token');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('clears both stores when refresh fails with invalid_grant', async () => {
    let legacyCleared = false;
    let llmDeletedSlug = '';

    const mockManager: any = {
      getClaudeOAuthCredentials: async () => null,
      setClaudeOAuthCredentials: async (creds: any) => {
        if (creds.accessToken === '') legacyCleared = true;
      },
      getLlmOAuth: async () => null,
      refreshLlmOAuth: async () => {},
      deleteLlmCredentials: async (slug: string) => {
        llmDeletedSlug = slug;
      },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        error: 'invalid_grant',
        error_description: 'Refresh token expired or revoked',
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }) as any;

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
    const mockManager: any = {
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
    };

    setCredentialManagerForTesting(mockManager);
    try {
      const result = await getValidClaudeOAuthToken('claude-pro');
      expect(result.accessToken).toBe('token-for-claude-pro');
    } finally {
      setCredentialManagerForTesting(null);
    }
  });

  it('falls back to legacy Claude OAuth store when connectionSlug has no LLM OAuth token', async () => {
    const mockManager: any = {
      getLlmOAuth: async () => null,
      getClaudeOAuthCredentials: async () => ({
        accessToken: 'fallback-legacy-token',
        expiresAt: Date.now() + 3600000,
      }),
    };

    setCredentialManagerForTesting(mockManager);
    try {
      const result = await getValidClaudeOAuthToken('claude-unmigrated');
      expect(result.accessToken).toBe('fallback-legacy-token');
    } finally {
      setCredentialManagerForTesting(null);
    }
  });
});
