import { lookup } from "node:dns/promises";

export function parseIpv4Uint32(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = ((value << 8) | octet) >>> 0;
  }
  return value >>> 0;
}

function isReservedIpv4Uint32(ipv4: number): boolean {
  const u = ipv4 >>> 0;
  return (
    (u & 0xff000000) >>> 0 === 0x00000000 || // 0.0.0.0/8 ("this" network)
    (u & 0xff000000) >>> 0 === 0x0a000000 || // 10.0.0.0/8 (RFC 1918)
    (u & 0xffc00000) >>> 0 === 0x64400000 || // 100.64.0.0/10 (RFC 6598 CGNAT)
    (u & 0xff000000) >>> 0 === 0x7f000000 || // 127.0.0.0/8 (Loopback)
    (u & 0xffff0000) >>> 0 === 0xa9fe0000 || // 169.254.0.0/16 (Link-local / Cloud metadata)
    (u & 0xfff00000) >>> 0 === 0xac100000 || // 172.16.0.0/12 (RFC 1918)
    (u & 0xffffff00) >>> 0 === 0xc0000000 || // 192.0.0.0/24 (IETF protocol assignments)
    (u & 0xffffff00) >>> 0 === 0xc0000200 || // 192.0.2.0/24 (TEST-NET-1)
    (u & 0xffff0000) >>> 0 === 0xc0a80000 || // 192.168.0.0/16 (RFC 1918)
    (u & 0xfffe0000) >>> 0 === 0xc6120000 || // 198.18.0.0/15 (Benchmarking)
    (u & 0xffffff00) >>> 0 === 0xc6336400 || // 198.51.100.0/24 (TEST-NET-2)
    (u & 0xffffff00) >>> 0 === 0xcb007100 || // 203.0.113.0/24 (TEST-NET-3)
    (u & 0xf0000000) >>> 0 === 0xe0000000 || // 224.0.0.0/4 (Multicast)
    (u & 0xf0000000) >>> 0 === 0xf0000000    // 240.0.0.0/4 (Reserved & Broadcast)
  );
}

const PRIVATE_IPV6_PATTERNS = [
  /^::1$/i,                                   // IPv6 loopback
  /^0:0:0:0:0:0:0:1$/i,                       // IPv6 loopback expanded
  /^::$/i,                                    // IPv6 unspecified
  /^0:0:0:0:0:0:0:0$/i,                       // IPv6 unspecified expanded
  /^fe[89ab][0-9a-f]:/i,                      // IPv6 link-local (fe80::/10)
  /^f[cd][0-9a-f]{2}:/i,                      // IPv6 unique local (fc00::/7)
  /^f[cd]/i,                                  // IPv6 unique local short forms
  /^ff[0-9a-f]{2}:/i,                         // IPv6 multicast (ff00::/8)
  /^100::/i,                                  // Discard-only address block (100::/64)
  /^2001:db8:/i,                              // Documentation (2001:db8::/32)
  /^2001:2:/i,                                // Benchmarking (2001:2::/48)
  /^64:ff9b:/i,                               // NAT64 (64:ff9b::/96 & 64:ff9b:1::/48)
];

function extractEmbeddedIpv4FromIpv6(normalizedIp: string): number | null {
  const lower = normalizedIp.toLowerCase();
  const dottedMatch = lower.match(/^(?:::ffff:|::ffff:0:0:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dottedMatch?.[1]) {
    return parseIpv4Uint32(dottedMatch[1]);
  }
  const hexMatch = lower.match(/^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMatch?.[1] && hexMatch?.[2]) {
    const hi = parseInt(hexMatch[1], 16);
    const lo = parseInt(hexMatch[2], 16);
    return (((hi & 0xffff) << 16) | (lo & 0xffff)) >>> 0;
  }
  const singleHexMatch = lower.match(/^::ffff:([0-9a-f]{1,4})$/);
  if (singleHexMatch?.[1]) {
    return parseInt(singleHexMatch[1], 16) >>> 0;
  }
  return null;
}

export function isPrivateIp(ip: string): boolean {
  const normalized = ip.trim().replace(/^\[|\]$/g, '');
  const ipv4 = parseIpv4Uint32(normalized);
  if (ipv4 !== null) {
    return isReservedIpv4Uint32(ipv4);
  }
  const embeddedIpv4 = extractEmbeddedIpv4FromIpv6(normalized);
  if (embeddedIpv4 !== null) {
    return isReservedIpv4Uint32(embeddedIpv4);
  }
  return PRIVATE_IPV6_PATTERNS.some(r => r.test(normalized));
}

export type DnsLookupFn = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string }> | { address: string }>;

export interface ValidatedUrlTarget {
  url: string;
  hostname: string;
  pinnedAddress: string;
  family: 4 | 6;
  addresses: string[];
}

/**
 * Validate URL before fetching — blocks non-HTTP schemes, private/reserved IPs,
 * and TTL=0 DNS rebinding flips via dual-resolution consistency verification,
 * returning the validated & pinned IP target for socket-level connection pinning.
 */
export async function validateUrl(
  url: string,
  dnsLookup: DnsLookupFn = lookup as DnsLookupFn,
): Promise<ValidatedUrlTarget> {
  const parsed = new URL(url);

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked: unsupported protocol "${parsed.protocol}"`);
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) {
    throw new Error('Blocked: missing hostname');
  }

  if (isPrivateIp(hostname)) {
    throw new Error('Blocked: resolves to private/reserved IP address');
  }

  const resolveAndValidate = async (): Promise<Set<string>> => {
    const resolved = await dnsLookup(hostname, { all: true });
    const records = Array.isArray(resolved) ? resolved : [resolved];
    if (records.length === 0) {
      throw new Error(`Blocked: hostname "${hostname}" could not be resolved`);
    }
    const addresses = new Set<string>();
    for (const record of records) {
      if (isPrivateIp(record.address)) {
        throw new Error('Blocked: resolves to private/reserved IP address');
      }
      addresses.add(record.address);
    }
    return addresses;
  };

  try {
    const firstPass = await resolveAndValidate();
    let verifiedAddresses = [...firstPass];
    // Dual-resolution check for domain names to detect TTL=0 DNS rebinding flips
    if (parseIpv4Uint32(hostname) === null && !hostname.includes(':')) {
      const secondPass = await resolveAndValidate();
      verifiedAddresses = [...firstPass].filter(addr => secondPass.has(addr));
      if (verifiedAddresses.length === 0) {
        throw new Error('Blocked: DNS resolution changed inconsistently (potential DNS rebinding)');
      }
    }
    const pinnedAddress = verifiedAddresses[0]!;
    const family: 4 | 6 = parseIpv4Uint32(pinnedAddress) !== null ? 4 : 6;
    return {
      url: parsed.toString(),
      hostname,
      pinnedAddress,
      family,
      addresses: verifiedAddresses,
    };
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOTFOUND') {
      throw new Error(`Blocked: hostname "${hostname}" could not be resolved`);
    }
    throw err;
  }
}
