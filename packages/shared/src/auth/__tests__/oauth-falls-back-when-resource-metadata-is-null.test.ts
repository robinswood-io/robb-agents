import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { discoverOAuthMetadata, prepareMcpOAuth } from '../oauth';

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

describe('protected resource metadata validation', () => {
// Helper to set up 401 flow leading to a resource metadata response
    function setup401WithResourceMetadata(resourceMetadataBody: unknown) {
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
          return Promise.resolve(new Response(
            JSON.stringify(resourceMetadataBody), { status: 200 }
          ));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      return fallbackMetadata;
    }

it('falls back when resource metadata is null', async () => {
      const fallback = setup401WithResourceMetadata(null);
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

it('falls back when resource metadata is a string', async () => {
      const fallback = setup401WithResourceMetadata('not an object');
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

it('falls back when resource metadata is missing "resource" field', async () => {
      const fallback = setup401WithResourceMetadata({
        authorization_servers: ['https://example.com/auth'],
      });
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

it('falls back when authorization_servers contains non-string items', async () => {
      const fallback = setup401WithResourceMetadata({
        resource: 'https://example.com/api',
        authorization_servers: [123, true],
      });
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

it('falls back when authorization_servers is not an array', async () => {
      const fallback = setup401WithResourceMetadata({
        resource: 'https://example.com/api',
        authorization_servers: 'not an array',
      });
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });

it('succeeds when authorization_servers is absent but uses fallback', async () => {
      // resource metadata with no authorization_servers field at all
      const fallback = setup401WithResourceMetadata({
        resource: 'https://example.com/api',
      });
      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallback);
    });
});

describe('timeout handling', () => {
it('falls back when HEAD request times out (AbortError)', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, _options?: RequestInit) => {
        // Simulate abort on HEAD and GET for the MCP endpoint
        if (url === 'https://example.com/mcp') {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          return Promise.reject(err);
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallbackMetadata);
    });

it('falls back when protected resource metadata fetch times out', async () => {
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
        // Timeout on protected resource metadata
        if (url === 'https://example.com/.well-known/oauth-protected-resource') {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          return Promise.reject(err);
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallbackMetadata);
    });

it('logs timeout message on AbortError for protected resource metadata', async () => {
      const logs: string[] = [];
      const onLog = (msg: string) => logs.push(msg);

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
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          return Promise.reject(err);
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      await discoverOAuthMetadata('https://example.com/mcp', onLog);
      expect(logs.some(l => l.includes('timeout'))).toBe(true);
    });
});

describe('URL normalization', () => {
it('handles authorization server URL without trailing slash', async () => {
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://example.com/auth'], // No trailing slash
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
              'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
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

it('handles authorization server URL at root (no path)', async () => {
      const protectedResourceMetadata = {
        resource: 'https://example.com/api',
        authorization_servers: ['https://auth.example.com'],
      };

      const authServerMetadata = {
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
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
        if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(authServerMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(authServerMetadata);
    });
});

describe('HEAD returning various non-401 status codes', () => {
it('falls back on HEAD 403 (Forbidden)', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 403 }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallbackMetadata);
    });

it('falls back on HEAD 500 (Internal Server Error)', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 500 }));
        }
        if (url === 'https://example.com/.well-known/oauth-authorization-server') {
          return Promise.resolve(new Response(JSON.stringify(fallbackMetadata), { status: 200 }));
        }
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      });

      const result = await discoverOAuthMetadata('https://example.com/mcp');
      expect(result).toEqual(fallbackMetadata);
    });

it('falls back on HEAD 301 (redirect)', async () => {
      const fallbackMetadata = {
        authorization_endpoint: 'https://example.com/oauth/authorize',
        token_endpoint: 'https://example.com/oauth/token',
      };

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === 'HEAD') {
          return Promise.resolve(new Response(null, { status: 301 }));
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

describe('prepareMcpOAuth', () => {
const originalFetch = globalThis.fetch;

let mockFetch: ReturnType<typeof mock>;

beforeEach(() => {
    mockFetch = mock(() => Promise.resolve(new Response('Not Found', { status: 404 })));
    globalThis.fetch = Object.assign(mockFetch, { preconnect() {} });
  });

afterEach(() => {
    globalThis.fetch = originalFetch;
  });

it('falls back to the default client ID when registration is forbidden', async () => {
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === 'https://example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(JSON.stringify({
          authorization_endpoint: 'https://example.com/oauth/authorize',
          token_endpoint: 'https://example.com/oauth/token',
          registration_endpoint: 'https://example.com/oauth/register',
        }), { status: 200 }));
      }
      if (url === 'https://example.com/oauth/register') {
        return Promise.resolve(new Response('Forbidden', { status: 403 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const result = await prepareMcpOAuth('https://example.com/mcp', { callbackPort: 8914 });

    expect(result.clientId).toBe('craft-agent');
    expect(result.clientSecret).toBeUndefined();
    expect(result.authUrl).toContain('client_id=craft-agent');
    expect(result.provider).toBe('mcp');
  });

it('keeps the dynamically registered client when registration succeeds', async () => {
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === 'https://example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(JSON.stringify({
          authorization_endpoint: 'https://example.com/oauth/authorize',
          token_endpoint: 'https://example.com/oauth/token',
          registration_endpoint: 'https://example.com/oauth/register',
        }), { status: 200 }));
      }
      if (url === 'https://example.com/oauth/register') {
        return Promise.resolve(new Response(JSON.stringify({
          client_id: 'dynamic-client',
          client_secret: 'secret-123',
        }), { status: 200 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const result = await prepareMcpOAuth('https://example.com/mcp', { callbackPort: 8914 });

    expect(result.clientId).toBe('dynamic-client');
    expect(result.clientSecret).toBe('secret-123');
    expect(result.authUrl).toContain('client_id=dynamic-client');
  });

it('throws on unexpected registration failures instead of silently falling back', async () => {
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === 'https://example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(new Response(JSON.stringify({
          authorization_endpoint: 'https://example.com/oauth/authorize',
          token_endpoint: 'https://example.com/oauth/token',
          registration_endpoint: 'https://example.com/oauth/register',
        }), { status: 200 }));
      }
      if (url === 'https://example.com/oauth/register') {
        return Promise.resolve(new Response('Server error', { status: 500 }));
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    await expect(prepareMcpOAuth('https://example.com/mcp', { callbackPort: 8914 })).rejects.toThrow('Failed to register OAuth client: Server error');
  });
});
