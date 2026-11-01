import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { discoverOAuthMetadata } from '../oauth';

describe('discoverOAuthMetadata', () => {
const originalFetch = globalThis.fetch;

let mockFetch: ReturnType<typeof mock>;

beforeEach(() => {
    mockFetch = mock(() => Promise.resolve(new Response('Not Found', { status: 404 })));
    globalThis.fetch = Object.assign(mockFetch, { preconnect() {} });
  });

afterEach(() => {
    globalThis.fetch = originalFetch;
  });

describe('RFC 8414 discovery fallback', () => {
it('discovers metadata at origin root', async () => {
      const metadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        // HEAD request fails (no RFC 9728 support)
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(metadata);
    });

it('falls back to path-scoped discovery', async () => {
      const metadata = {
        authorization_endpoint: 'https://api.ahrefs.com/oauth/authorize',
        token_endpoint: 'https://api.ahrefs.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        // HEAD request fails
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        if (url === 'https://api.ahrefs.com/.well-known/oauth-authorization-server/mcp/mcp') {
          return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://api.ahrefs.com/mcp/mcp');
      expect(result).toEqual(metadata);
    });
});

describe('error handling', () => {
it('returns null when no metadata found', async () => {
      mockFetch.mockImplementation((_url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toBeNull();
    });

it('returns null for invalid URL', async () => {
      const result = await discoverOAuthMetadata('not-a-valid-url');
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

it('returns null when metadata is missing required fields', async () => {
      mockFetch.mockImplementation((_url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ some: 'data' }), { status: 200 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toBeNull();
    });

it('handles network errors gracefully', async () => {
      mockFetch.mockImplementation(() => {
        return Promise.reject(new Error('Network error'));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toBeNull();
    });
});

it('calls onLog callback with discovery progress', async () => {
    const logs: string[] = [];
    const onLog = (msg: string) => logs.push(msg);

    mockFetch.mockImplementation((_url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    await discoverOAuthMetadata('https://example.com/mcp', onLog);

    expect(logs.some(l => l.includes('Discovering OAuth metadata'))).toBe(true);
    expect(logs.some(l => l.includes('RFC 9728'))).toBe(true);
    expect(logs.some(l => l.includes('No OAuth metadata found'))).toBe(true);
  });

it('includes registration_endpoint when present', async () => {
    const metadata = {
      authorization_endpoint: 'https://example.com/oauth/authorize',
      token_endpoint: 'https://example.com/oauth/token',
      registration_endpoint: 'https://example.com/oauth/register',
    };

    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === 'https://example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(JSON.stringify(metadata), { status: 200 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const result = await discoverOAuthMetadata('https://example.com/mcp');
    expect(result?.registration_endpoint).toBe('https://example.com/oauth/register');
  });

describe('SSRF protection via isUrlSafeToFetch', () => {
// Helper: set up a 401 with resource_metadata pointing at the given URL
    function setupSsrfTest(resourceMetadataUrl: string) {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"`,
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      return fallbackMetadata;
    }

it('rejects IPv6 loopback ::1', async () => {
      const fallback = setupSsrfTest('https://[::1]/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

it('rejects 0.0.0.0', async () => {
      const fallback = setupSsrfTest('https://0.0.0.0/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

it('rejects 10.x.x.x private range', async () => {
      const fallback = setupSsrfTest('https://10.0.0.1/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

it('rejects 172.16.x.x private range', async () => {
      const fallback = setupSsrfTest('https://172.16.0.1/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

it('rejects 172.31.x.x private range (upper bound)', async () => {
      const fallback = setupSsrfTest('https://172.31.255.255/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

it('rejects 192.168.x.x private range', async () => {
      const fallback = setupSsrfTest('https://192.168.1.1/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

it('rejects 127.0.0.1 loopback', async () => {
      const fallback = setupSsrfTest('https://127.0.0.1/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

it('rejects localhost', async () => {
      const fallback = setupSsrfTest('https://localhost/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

it('rejects link-local 169.254.x.x (AWS metadata)', async () => {
      const fallback = setupSsrfTest('https://169.254.169.254/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

it('rejects HTTP scheme (non-HTTPS)', async () => {
      const fallback = setupSsrfTest('http://safe-domain.com/.well-known/oauth-protected-resource');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

it('rejects authorization_servers pointing to private IP', async () => {
      // The protected resource metadata itself is safe, but the auth server points to a private IP
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://10.0.0.1/auth'],
      };

      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      // Should fall back because auth server URL is unsafe
      expect(result).toEqual(fallbackMetadata);
    });
});

describe('WWW-Authenticate header parsing edge cases', () => {
it('handles resource_metadata with extra spaces around equals sign', async () => {
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://example.com/auth'],
      };

      const authServerMetadata = {
        authorization_endpoint: 'https://example.com/auth/authorize',
        token_endpoint: 'https://example.com/auth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              // Extra spaces around =
              'WWW-Authenticate': 'Bearer resource_metadata  =  "https://example.com/.well-known/oauth-protected-resource"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        if (url === 'https://example.com/auth/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(authServerMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(authServerMetadata);
    });

it('falls back when WWW-Authenticate header is null', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          // 401 but no WWW-Authenticate header
          return Promise.resolve(new Response(null, { status: 401 }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallbackMetadata);
    });

it('handles multiple WWW-Authenticate challenges (resource_metadata among other params)', async () => {
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://example.com/auth'],
      };

      const authServerMetadata = {
        authorization_endpoint: 'https://example.com/auth/authorize',
        token_endpoint: 'https://example.com/auth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              // Multiple params before and after resource_metadata
              'WWW-Authenticate': 'Bearer realm="example", error="invalid_token", resource_metadata="https://example.com/.well-known/oauth-protected-resource", error_description="expired"',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          return Promise.resolve(new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }));
        }
        if (url === 'https://example.com/auth/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(authServerMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(authServerMetadata);
    });

it('falls back when resource_metadata value has no quotes', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: {
              // No quotes around the value
              'WWW-Authenticate': 'Bearer resource_metadata=https://example.com/.well-known/oauth-protected-resource',
            },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      // Without quotes, parseResourceMetadataFromHeader returns null, so falls back
      expect(result).toEqual(fallbackMetadata);
    });

it('falls back when WWW-Authenticate is empty string', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, {
            status: 401,
            headers: { 'WWW-Authenticate': '' },
          }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallbackMetadata);
    });
});
});
