import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { GuardDecision, NetworkAccessMode, NetworkHostResolver, ResolvedNetworkAddress } from './contracts.ts';

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function normalizeIpAddress(address: string): string {
  const withoutBrackets = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return withoutBrackets.split('%')[0] ?? withoutBrackets;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = normalizeIpAddress(address);
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) {
    return isPrivateIpv4(normalized.slice('::ffff:'.length));
  }

  const firstGroup = normalized.split(':')[0];
  const first = Number.parseInt(firstGroup ?? '', 16);
  if (!Number.isInteger(first)) return false;
  return (first >= 0xfc00 && first <= 0xfdff) || (first >= 0xfe80 && first <= 0xfebf);
}

function isPrivateIpAddress(address: string): boolean {
  const normalized = normalizeIpAddress(address);
  const family = isIP(normalized);
  return family === 4 ? isPrivateIpv4(normalized) : family === 6 ? isPrivateIpv6(normalized) : false;
}

export function isLocalHostname(hostname: string): boolean {
  const normalized = normalizeIpAddress(hostname);
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    isPrivateIpAddress(normalized)
  );
}

function hostMatchesRule(hostname: string, rule: string): boolean {
  const normalizedRule = rule.trim().toLowerCase();
  if (normalizedRule.startsWith('*.')) {
    const suffix = normalizedRule.slice(1);
    return hostname.endsWith(suffix) && hostname !== suffix.slice(1);
  }
  return hostname === normalizedRule;
}

/** Validate outbound HTTP(S) access without allowing localhost/private SSRF. */
export function authorizeNetworkUrl(
  urlString: string,
  mode: NetworkAccessMode,
  allowedHosts: readonly string[],
): GuardDecision {
  if (mode === 'disabled') {
    return { allowed: false, reason: 'Network access is disabled for this task' };
  }

  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { allowed: false, reason: 'Network target is not a valid URL' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { allowed: false, reason: 'Only HTTP(S) network targets are supported' };
  }
  const hostname = url.hostname.toLowerCase();
  if (isLocalHostname(hostname)) {
    return { allowed: false, reason: 'Local and private network targets are blocked' };
  }
  if (!allowedHosts.some((rule) => hostMatchesRule(hostname, rule))) {
    return { allowed: false, reason: 'Network host is outside the configured allow-list' };
  }
  return { allowed: true };
}

const defaultNetworkHostResolver: NetworkHostResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.flatMap(({ address, family }) =>
    family === 4 || family === 6 ? [{ address, family }] : [],
  );
};

/**
 * Resolve an allow-listed hostname and reject the request if any answer points
 * at a local/private address. This closes the DNS-rebinding gap left by a
 * lexical host allow-list alone.
 */
export async function authorizeResolvedNetworkUrl(
  urlString: string,
  mode: NetworkAccessMode,
  allowedHosts: readonly string[],
  resolver: NetworkHostResolver = defaultNetworkHostResolver,
): Promise<GuardDecision> {
  const lexicalDecision = authorizeNetworkUrl(urlString, mode, allowedHosts);
  if (!lexicalDecision.allowed) return lexicalDecision;

  const hostname = new URL(urlString).hostname.toLowerCase();
  if (isIP(normalizeIpAddress(hostname)) !== 0) {
    return lexicalDecision;
  }

  let addresses: readonly ResolvedNetworkAddress[];
  try {
    addresses = await resolver(hostname);
  } catch {
    return { allowed: false, reason: 'Network host could not be resolved safely' };
  }
  if (addresses.length === 0) {
    return { allowed: false, reason: 'Network host did not resolve to an address' };
  }
  if (addresses.some(({ address }) => isPrivateIpAddress(address))) {
    return { allowed: false, reason: 'Network host resolves to a local or private address' };
  }
  return { allowed: true };
}
