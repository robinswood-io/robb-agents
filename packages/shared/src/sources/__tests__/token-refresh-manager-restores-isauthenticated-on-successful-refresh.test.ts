/**
 * Unit tests for TokenRefreshManager and isOAuthSource helper.
 *
 * Tests the proactive token refresh functionality that includes both:
 * - MCP OAuth sources (Linear, Notion, etc.)
 * - API OAuth sources (Google, Slack, Microsoft)
 */
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { hasRenewEndpoint, isRefreshableSource, type LoadedSource, type FolderSourceConfig } from '../types.ts';
import { TokenRefreshManager } from '../token-refresh-manager.ts';
import { isSourceUsable } from '../storage.ts';
import * as storage from '../storage.ts';

import type { SourceCredentialManager } from '../credential-manager.ts';

// Spy instead of mock.module(): Bun module mocks leak across files in the same
// process, which can mask storage.ts regressions in neighboring source tests.
let mockMarkSourceAuthenticated = mock(() => true);
let markSourceAuthenticatedSpy: { mockRestore: () => void } | null = null;
/**
 * Helper to create a mock LoadedSource for testing
 */
function createMockSource(overrides: Partial<FolderSourceConfig>): LoadedSource {
  const config: FolderSourceConfig = {
    id: 'test-id',
    name: 'Test Source',
    slug: 'test-source',
    enabled: true,
    provider: 'test',
    type: 'api',
    isAuthenticated: true,
    ...overrides,
  };

  return {
    config,
    guide: null,
    folderPath: '/mock/path',
    workspaceRootPath: '/mock/workspace',
    workspaceId: 'mock-workspace',
  };
}
// --- TokenRefreshManager tests ---

function createMockCredManager(overrides: Partial<SourceCredentialManager> = {}): SourceCredentialManager {
  return {
    load: mock(() => Promise.resolve(null)),
    refresh: mock(() => Promise.resolve(null)),
    isExpired: mock(() => true),
    needsRefresh: mock(() => true),
    markSourceNeedsReauth: mock(() => {}),
    ...overrides,
  } as unknown as SourceCredentialManager;
}

describe('TokenRefreshManager', () => {
beforeEach(() => {
    mockMarkSourceAuthenticated = mock(() => true);
    markSourceAuthenticatedSpy = spyOn(storage, 'markSourceAuthenticated').mockImplementation(mockMarkSourceAuthenticated);
  });

afterEach(() => {
    markSourceAuthenticatedSpy?.mockRestore();
    markSourceAuthenticatedSpy = null;
  });

describe('ensureFreshToken', () => {
test('restores isAuthenticated on successful refresh', async () => {
      const credManager = createMockCredManager({
        load: mock(() => Promise.resolve({
          value: 'expired-token',
          refreshToken: 'refresh-123',
          expiresAt: Date.now() - 60_000,
        })),
        isExpired: mock(() => true),
        refresh: mock(() => Promise.resolve('new-fresh-token')),
      });

      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        slug: 'craft-mcp',
        type: 'mcp',
        provider: 'craft',
        mcp: { url: 'https://mcp.craft.do/my/mcp', authType: 'oauth' },
        isAuthenticated: false,
        connectionStatus: 'needs_auth',
        connectionError: 'Token expired',
      });

      const result = await manager.ensureFreshToken(source);

      expect(result.success).toBe(true);
      expect(result.token).toBe('new-fresh-token');
      expect(isSourceUsable(source)).toBe(true);
      expect(source.config.connectionStatus).toBe('connected');
      expect(source.config.connectionError).toBeUndefined();
      expect(mockMarkSourceAuthenticated).toHaveBeenCalledWith('/mock/workspace', 'craft-mcp');
    });

test('does NOT restore auth on failed refresh', async () => {
      const credManager = createMockCredManager({
        load: mock(() => Promise.resolve({
          value: 'expired-token',
          refreshToken: 'refresh-123',
          expiresAt: Date.now() - 60_000,
        })),
        isExpired: mock(() => true),
        refresh: mock(() => Promise.resolve(null)),
      });

      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        slug: 'craft-mcp',
        type: 'mcp',
        provider: 'craft',
        mcp: { url: 'https://mcp.craft.do/my/mcp', authType: 'oauth' },
        isAuthenticated: false,
        connectionStatus: 'needs_auth',
      });

      const result = await manager.ensureFreshToken(source);

      expect(result.success).toBe(false);
      expect(isSourceUsable(source)).toBe(false);
      expect(mockMarkSourceAuthenticated).not.toHaveBeenCalled();
    });

test('failed refresh (returns null) mutates in-memory source.config — #710', async () => {
      // Source starts as authenticated (cred just expired in-memory copy not yet updated).
      // Failed refresh must mirror the markSourceNeedsReauth disk write to in-memory state
      // so isSourceUsable returns false and callers exclude it from intendedSlugs.
      const credManager = createMockCredManager({
        load: mock(() => Promise.resolve({
          value: 'expired-token',
          refreshToken: 'refresh-123',
          expiresAt: Date.now() - 60_000,
        })),
        isExpired: mock(() => true),
        refresh: mock(() => Promise.resolve(null)),
      });

      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        slug: 'craft-mcp',
        type: 'mcp',
        provider: 'craft',
        mcp: { url: 'https://mcp.craft.do/my/mcp', authType: 'oauth' },
        isAuthenticated: true,
        connectionStatus: 'connected',
      });

      expect(isSourceUsable(source)).toBe(true); // precondition

      await manager.ensureFreshToken(source);

      expect(source.config['isAuthenticated']).toBe(false);
      expect(source.config.connectionStatus).toBe('needs_auth');
      expect(source.config.connectionError).toBe('Token refresh failed');
      expect(isSourceUsable(source)).toBe(false);
    });

test('failed refresh (throws) mutates in-memory source.config — #710', async () => {
      const credManager = createMockCredManager({
        load: mock(() => Promise.resolve({
          value: 'expired-token',
          refreshToken: 'refresh-123',
          expiresAt: Date.now() - 60_000,
        })),
        isExpired: mock(() => true),
        refresh: mock(() => Promise.reject(new Error('network down'))),
      });

      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        slug: 'craft-mcp',
        type: 'mcp',
        provider: 'craft',
        mcp: { url: 'https://mcp.craft.do/my/mcp', authType: 'oauth' },
        isAuthenticated: true,
        connectionStatus: 'connected',
      });

      expect(isSourceUsable(source)).toBe(true);

      await manager.ensureFreshToken(source);

      expect(source.config['isAuthenticated']).toBe(false);
      expect(source.config.connectionStatus).toBe('needs_auth');
      expect(source.config.connectionError).toBe('Refresh error: network down');
      expect(isSourceUsable(source)).toBe(false);
    });
});

describe('end-to-end', () => {
test('expired source recovered without re-auth', async () => {
      const credManager = createMockCredManager({
        load: mock(() => Promise.resolve({
          value: 'expired-token',
          refreshToken: 'refresh-123',
          expiresAt: Date.now() - 60_000,
        })),
        isExpired: mock(() => true),
        needsRefresh: mock(() => true),
        refresh: mock(() => Promise.resolve('fresh-token')),
      });

      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        slug: 'craft-mcp',
        type: 'mcp',
        provider: 'craft',
        mcp: { url: 'https://mcp.craft.do/my/mcp', authType: 'oauth' },
        isAuthenticated: false,
        connectionStatus: 'needs_auth',
        connectionError: 'Token expired',
      });

      // Step 1: getSourcesNeedingRefresh includes the expired source
      const needingRefresh = await manager.getSourcesNeedingRefresh([source]);
      expect(needingRefresh.length).toBe(1);

      // Step 2: refreshSources refreshes and restores auth state
      const { refreshed, failed } = await manager.refreshSources(needingRefresh);
      expect(refreshed.length).toBe(1);
      expect(failed.length).toBe(0);

      // Step 3: Verify auth state is restored
      expect(isSourceUsable(source)).toBe(true);
      expect(source.config.connectionStatus).toBe('connected');
      expect(source.config.connectionError).toBeUndefined();
      expect(mockMarkSourceAuthenticated).toHaveBeenCalledWith('/mock/workspace', 'craft-mcp');
    });
});

describe('renew-endpoint sources', () => {
test('needsRefresh returns true for renew-endpoint source without refreshToken', async () => {
      const credManager = createMockCredManager({
        load: mock(() => Promise.resolve({
          value: 'expired-token',
          expiresAt: Date.now() - 60_000,
          // no refreshToken
        })),
        isExpired: mock(() => true),
      });

      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        type: 'api',
        provider: 'custom-api',
        api: {
          baseUrl: 'https://api.example.com',
          authType: 'bearer',
          renewEndpoint: { path: '/auth/refresh', tokenField: 'token' },
        },
        isAuthenticated: true,
      });

      expect(await manager.needsRefresh(source)).toBe(true);
    });

test('ensureFreshToken refreshes renew-endpoint source without refreshToken', async () => {
      const credManager = createMockCredManager({
        load: mock(() => Promise.resolve({
          value: 'expired-token',
          expiresAt: Date.now() - 60_000,
          // no refreshToken
        })),
        isExpired: mock(() => true),
        needsRefresh: mock(() => true),
        refresh: mock(() => Promise.resolve('new-fresh-token')),
      });

      const manager = new TokenRefreshManager(credManager);
      const source = createMockSource({
        type: 'api',
        provider: 'custom-api',
        api: {
          baseUrl: 'https://api.example.com',
          authType: 'bearer',
          renewEndpoint: { path: '/auth/refresh' },
        },
        isAuthenticated: true,
      });

      const result = await manager.ensureFreshToken(source);
      expect(result.success).toBe(true);
      expect(result.token).toBe('new-fresh-token');
      expect(credManager.refresh).toHaveBeenCalled();
    });

test('getSourcesNeedingRefresh includes renew-endpoint sources', async () => {
      const credManager = createMockCredManager({
        load: mock(() => Promise.resolve({
          value: 'expired-token',
          expiresAt: Date.now() - 60_000,
        })),
        isExpired: mock(() => true),
      });

      const manager = new TokenRefreshManager(credManager);
      const renewSource = createMockSource({
        slug: 'custom-api',
        type: 'api',
        provider: 'custom',
        api: {
          baseUrl: 'https://api.example.com',
          authType: 'bearer',
          renewEndpoint: { path: '/auth/renew' },
        },
        isAuthenticated: true,
      });
      const plainBearerSource = createMockSource({
        slug: 'plain-api',
        type: 'api',
        provider: 'plain',
        api: { baseUrl: 'https://api.plain.com', authType: 'bearer' },
        isAuthenticated: true,
      });

      const result = await manager.getSourcesNeedingRefresh([renewSource, plainBearerSource]);
      expect(result.length).toBe(1);
      expect(result[0]!.config.slug).toBe('custom-api');
    });
});
});

describe('hasRenewEndpoint', () => {
test('returns true for API source with renewEndpoint', () => {
    const source = createMockSource({
      type: 'api',
      api: {
        baseUrl: 'https://api.example.com',
        authType: 'bearer',
        renewEndpoint: { path: '/auth/refresh' },
      },
    });
    expect(hasRenewEndpoint(source)).toBe(true);
  });

test('returns false for API source without renewEndpoint', () => {
    const source = createMockSource({
      type: 'api',
      api: { baseUrl: 'https://api.example.com', authType: 'bearer' },
    });
    expect(hasRenewEndpoint(source)).toBe(false);
  });

test('returns false for MCP source', () => {
    const source = createMockSource({
      type: 'mcp',
      mcp: { url: 'https://mcp.example.com', authType: 'oauth' },
    });
    expect(hasRenewEndpoint(source)).toBe(false);
  });
});

describe('isRefreshableSource', () => {
test('returns true for OAuth source', () => {
    const source = createMockSource({
      type: 'mcp',
      provider: 'linear',
      mcp: { url: 'https://linear.example.com', authType: 'oauth' },
    });
    expect(isRefreshableSource(source)).toBe(true);
  });

test('returns true for renew-endpoint source', () => {
    const source = createMockSource({
      type: 'api',
      provider: 'custom',
      api: {
        baseUrl: 'https://api.example.com',
        authType: 'bearer',
        renewEndpoint: { path: '/auth/refresh' },
      },
    });
    expect(isRefreshableSource(source)).toBe(true);
  });

test('returns false for plain bearer source', () => {
    const source = createMockSource({
      type: 'api',
      provider: 'custom',
      api: { baseUrl: 'https://api.example.com', authType: 'bearer' },
    });
    expect(isRefreshableSource(source)).toBe(false);
  });
});
