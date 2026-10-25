import type { LookupFunction } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { ValidatedUrlTarget } from './network-safety.ts';
import { isPrivateIp, parseIpv4Uint32 } from './network-safety.ts';

const INITIAL_GLOBAL_FETCH = globalThis.fetch;

/**
 * Create a socket-level `lookup` callback that pins TCP/TLS connections to the
 * exact IP address(es) validated by `validateUrl()`, completely eliminating the
 * DNS rebinding TOCTOU window between validation and socket connection.
 */
export function createPinnedDnsLookup(target: ValidatedUrlTarget): LookupFunction {
  return (
    hostname: string,
    options,
    cb,
  ): void => {
    const opts = typeof options === 'object' && options !== null ? options : {};

    const normalizedRequested = hostname.trim().replace(/^\[|\]$/g, '').toLowerCase();
    const normalizedExpected = target.hostname.trim().replace(/^\[|\]$/g, '').toLowerCase();
    if (normalizedRequested !== normalizedExpected) {
      cb(new Error(`Blocked: socket lookup hostname "${hostname}" does not match pinned "${target.hostname}"`), '');
      return;
    }

    if (isPrivateIp(target.pinnedAddress) || target.addresses.some(addr => isPrivateIp(addr))) {
      cb(new Error('Blocked: pinned address resolves to private/reserved IP address'), '');
      return;
    }

    if (opts.all) {
      cb(
        null,
        target.addresses.map(address => ({
          address,
          family: parseIpv4Uint32(address) !== null ? 4 : 6,
        })),
      );
      return;
    }

    cb(null, target.pinnedAddress, target.family);
  };
}

/**
 * Perform an HTTP/HTTPS GET pinned to the pre-validated IP address from `validateUrl()`,
 * while preserving the `Host` header, TLS SNI (`servername`), and certificate hostname verification.
 */
export async function fetchWithPinnedDns(
  target: ValidatedUrlTarget,
  init: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    forceSocketPinning?: boolean;
  } = {},
): Promise<Response> {
  const hasEnvProxy = Boolean(
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy,
  );
  if (!init.forceSocketPinning && (globalThis.fetch !== INITIAL_GLOBAL_FETCH || hasEnvProxy)) {
    return globalThis.fetch(target.url, {
      headers: init.headers,
      redirect: 'manual',
      signal: init.signal,
    });
  }

  const parsed = new URL(target.url);
  const isHttps = parsed.protocol === 'https:';
  const requestFn = isHttps ? httpsRequest : httpRequest;
  const pinnedLookup = createPinnedDnsLookup(target);

  return new Promise<Response>((resolvePromise, rejectPromise) => {
    const req = requestFn(
      parsed,
      {
        method: 'GET',
        headers: init.headers,
        lookup: pinnedLookup,
        ...(isHttps ? { servername: target.hostname } : {}),
        signal: init.signal,
      },
      (res) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(key, item);
          } else if (typeof value === 'string') {
            responseHeaders.set(key, value);
          }
        }
        const status = res.statusCode ?? 200;
        const isRedirect =
          status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
        const isNullBody =
          isRedirect || status === 101 || status === 204 || status === 205 || status === 304;
        if (isNullBody) {
          res.resume();
        }
        const bodyStream = isNullBody
          ? null
          : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
        const response = new Response(bodyStream, {
          status,
          statusText: res.statusMessage ?? '',
          headers: responseHeaders,
        });
        Object.defineProperty(response, 'url', { value: target.url, configurable: true });
        resolvePromise(response);
      },
    );

    req.on('error', (err) => {
      rejectPromise(err);
    });

    req.end();
  });
}
