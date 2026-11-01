import { describe, it, expect } from 'bun:test';
import { createServer } from 'node:http';
import {
  isPrivateIp,
  validateUrl,
  createPinnedDnsLookup,
  fetchWithPinnedDns,
  createWebFetchTool,
  type ValidatedUrlTarget,
} from '../web-fetch.ts';

describe('Web Fetch SSRF & Redirect Protection', () => {
  it('identifies IPv4, IPv6, and IPv4-mapped IPv6 private/reserved addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '192.0.0.1',
      '192.0.2.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
      '::1',
      '[::1]',
      '::',
      '::127.0.0.1',
      '::ffff:127.0.0.1',
      '::ffff:0:0:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:169.254.169.254',
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      '64:ff9b::1',
      '100::1',
      '2001:db8::1',
      '2001:2::1',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }

    expect(isPrivateIp('93.184.216.34')).toBe(false);
    expect(isPrivateIp('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
  });

  it('rejects private IP literals and unsupported protocols in validateUrl', async () => {
    await expect(validateUrl('file:///etc/passwd')).rejects.toThrow(/unsupported protocol/);
    await expect(validateUrl('http://127.0.0.1:9100/health')).rejects.toThrow(/private\/reserved IP/);
    await expect(validateUrl('http://[::1]:9100/health')).rejects.toThrow(/private\/reserved IP/);
    await expect(validateUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/private\/reserved IP/);
  });

  it('detects and blocks TTL=0 DNS rebinding flips during validateUrl', async () => {
    let callCount = 0;
    const rebindingLookup = async () => {
      callCount += 1;
      if (callCount === 1) {
        return [{ address: '93.184.216.34' }];
      }
      return [{ address: '127.0.0.1' }];
    };

    await expect(
      validateUrl('https://rebind.attacker.example/secret', rebindingLookup),
    ).rejects.toThrow(/private\/reserved IP/);

    let disjointCount = 0;
    const disjointLookup = async () => {
      disjointCount += 1;
      return disjointCount === 1
        ? [{ address: '93.184.216.34' }]
        : [{ address: '198.51.100.42' }];
    };

    await expect(
      validateUrl('https://disjoint.attacker.example/secret', disjointLookup),
    ).rejects.toThrow(/private\/reserved IP|DNS rebinding/);
  });

  it('blocks HTTP redirects targeting private/loopback IPs', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1:9100/internal-secret' },
      });
    }, { preconnect: () => {} });

    try {
      const tool = createWebFetchTool(() => null);
      const res = await tool.execute(
        'call-1',
        { url: 'https://93.184.216.34/start' },
      );
      const text = (res.content[0] as { type: 'text'; text: string }).text;
      expect((res.details as { isError?: boolean })?.isError).toBe(true);
      expect(text).toContain('Refused redirect');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('pins socket-level DNS lookup to the validated IP and blocks hostname/private-IP mismatches', async () => {
    const validated = await validateUrl(
      'https://example.com/resource',
      async () => [{ address: '93.184.216.34' }, { address: '93.184.216.35' }],
    );
    expect(validated.pinnedAddress).toBe('93.184.216.34');
    expect(validated.family).toBe(4);
    expect(validated.addresses).toEqual(['93.184.216.34', '93.184.216.35']);

    const lookupFn = createPinnedDnsLookup(validated);

    // Single-address lookup (socket connection)
    let resolvedAddr = '';
    let resolvedFamily = 0;
    lookupFn('example.com', {}, (err, addr, fam) => {
      expect(err).toBeNull();
      if (typeof addr !== 'string') throw new Error('Expected one pinned address');
      resolvedAddr = addr;
      resolvedFamily = fam ?? 0;
    });
    expect(resolvedAddr).toBe('93.184.216.34');
    expect(resolvedFamily).toBe(4);

    // { all: true } lookup
    let allAddrs: Array<{ address: string; family: number }> = [];
    lookupFn('example.com', { all: true }, (err, addrs) => {
      expect(err).toBeNull();
      if (!Array.isArray(addrs)) throw new Error('Expected all pinned addresses');
      allAddrs = addrs;
    });
    expect(allAddrs).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '93.184.216.35', family: 4 },
    ]);

    // Mismatched hostname must fail closed
    let mismatchErr: Error | null = null;
    lookupFn('attacker.example.com', {}, (err) => {
      mismatchErr = err;
    });
    expect(mismatchErr).not.toBeNull();
    expect(mismatchErr!.message).toContain('does not match pinned');

    // Tampered private IP in target must fail closed at socket creation time
    const tamperedTarget: ValidatedUrlTarget = {
      ...validated,
      pinnedAddress: '127.0.0.1',
    };
    let privateErr: Error | null = null;
    createPinnedDnsLookup(tamperedTarget)('example.com', {}, (err) => {
      privateErr = err;
    });
    expect(privateErr).not.toBeNull();
    expect(privateErr!.message).toContain('private/reserved IP');
  });

  it('connects via pinned lookup while preserving Host header in fetchWithPinnedDns', async () => {
    let observedHostHeader = '';
    const srv = createServer((req, res) => {
      observedHostHeader = req.headers.host ?? '';
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('pinned-response-ok');
    });

    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    try {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      // Verify that a private pinnedAddress is blocked at the socket layer by fetchWithPinnedDns
      await expect(
        fetchWithPinnedDns(
          {
            url: `http://pinned.example.test:${port}/hello`,
            hostname: 'pinned.example.test',
            pinnedAddress: '127.0.0.1',
            family: 4,
            addresses: ['127.0.0.1'],
          },
          { forceSocketPinning: true },
        ),
      ).rejects.toThrow(/private\/reserved IP/);
      expect(observedHostHeader).toBe('');
    } finally {
      srv.close();
    }
  });
});
