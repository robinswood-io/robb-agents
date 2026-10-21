import { Type } from '@sinclair/typebox';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import TurndownService from 'turndown';
import { parse as parseHtml } from 'node-html-parser';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

const INITIAL_GLOBAL_FETCH = globalThis.fetch;

const schema = Type.Object({
  url: Type.String({ description: 'URL to fetch' }),
  prompt: Type.Optional(
    Type.String({
      description:
        'Context hint included in the output prefix (e.g. "find the pricing table"). The full page content is always returned — use this to annotate what you were looking for.',
    }),
  ),
});

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

const NOISE_ELEMENTS = ['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript', 'iframe', 'svg'];
turndown.remove(NOISE_ELEMENTS);

const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024; // 50MB
const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

// ============================================================
// SSRF protection
// ============================================================

const MAX_REDIRECTS = 5;

function parseIpv4Uint32(ip: string): number | null {
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
  dnsLookup: DnsLookupFn = lookup as unknown as DnsLookupFn,
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
  } catch (err: any) {
    if (err.code === 'ENOTFOUND') {
      throw new Error(`Blocked: hostname "${hostname}" could not be resolved`);
    }
    throw err;
  }
}

/**
 * Create a socket-level `lookup` callback that pins TCP/TLS connections to the
 * exact IP address(es) validated by `validateUrl()`, completely eliminating the
 * DNS rebinding TOCTOU window between validation and socket connection.
 */
export function createPinnedDnsLookup(target: ValidatedUrlTarget) {
  return (
    hostname: string,
    options: { all?: boolean } | number | undefined,
    callback?: (err: Error | null, address?: any, family?: number) => void,
  ): void => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options !== null ? options : {};
    if (!cb) return;

    const normalizedRequested = hostname.trim().replace(/^\[|\]$/g, '').toLowerCase();
    const normalizedExpected = target.hostname.trim().replace(/^\[|\]$/g, '').toLowerCase();
    if (normalizedRequested !== normalizedExpected) {
      cb(new Error(`Blocked: socket lookup hostname "${hostname}" does not match pinned "${target.hostname}"`));
      return;
    }

    if (isPrivateIp(target.pinnedAddress) || target.addresses.some(addr => isPrivateIp(addr))) {
      cb(new Error('Blocked: pinned address resolves to private/reserved IP address'));
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
        lookup: pinnedLookup as any,
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

// ============================================================
// Streaming size-limited reader
// ============================================================

/**
 * Read the full response body while enforcing a byte-size limit.
 * Unlike checking Content-Length (which can be absent or lie),
 * this actually caps how many bytes we buffer.
 */
async function readResponseBytes(response: Response, maxSize: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    // Fallback for runtimes without streaming body
    const ab = await response.arrayBuffer();
    if (ab.byteLength > maxSize) {
      throw new Error(`Response exceeded ${Math.round(maxSize / 1024 / 1024)}MB limit`);
    }
    return Buffer.from(ab);
  }

  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.byteLength;
      if (totalSize > maxSize) {
        throw new Error(`Response exceeded ${Math.round(maxSize / 1024 / 1024)}MB limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Buffer.from(combined.buffer, combined.byteOffset, combined.byteLength);
}

/**
 * Read the full response body as text while enforcing a byte-size limit.
 */
async function readResponseText(response: Response, maxSize: number): Promise<string> {
  const buffer = await readResponseBytes(response, maxSize);
  return buffer.toString('utf-8');
}

// ============================================================
// Helpers
// ============================================================

function result(text: string, isError = false): AgentToolResult<{ isError?: boolean }> {
  return {
    content: [{ type: 'text', text }],
    details: isError ? { isError: true } : {},
  };
}

// ============================================================
// Content-type handlers
// ============================================================

function ensurePdfjsPolyfills(): void {
  // pdfjs-dist uses browser-only APIs at module scope (e.g. `const SCALE_MATRIX = new DOMMatrix()`).
  // Provide minimal stubs so it can load in Node.js — only text extraction is used, not rendering.
  if (typeof globalThis.DOMMatrix === 'undefined') {
    (globalThis as any).DOMMatrix = class DOMMatrix {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
      m11 = 1; m12 = 0; m13 = 0; m14 = 0;
      m21 = 0; m22 = 1; m23 = 0; m24 = 0;
      m31 = 0; m32 = 0; m33 = 1; m34 = 0;
      m41 = 0; m42 = 0; m43 = 0; m44 = 1;
      is2D = true;
      constructor(init?: any) {
        if (Array.isArray(init) && init.length >= 6) {
          this.a = init[0]; this.b = init[1]; this.c = init[2];
          this.d = init[3]; this.e = init[4]; this.f = init[5];
        }
      }
      multiply() { return new (globalThis as any).DOMMatrix(); }
      preMultiplySelf() { return this; }
      invertSelf() { return this; }
      translate() { return new (globalThis as any).DOMMatrix(); }
      scale() { return new (globalThis as any).DOMMatrix(); }
      transformPoint(p: any) { return p || { x: 0, y: 0 }; }
      static fromMatrix() { return new (globalThis as any).DOMMatrix(); }
    };
  }
  if (typeof globalThis.Path2D === 'undefined') {
    (globalThis as any).Path2D = class Path2D {
      addPath() {}
    };
  }
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  ensurePdfjsPolyfills();
  // Pre-load worker on the main thread so pdfjs-dist doesn't try to resolve
  // pdf.worker.mjs from disk (fails when externalized via bun build).
  if (!(globalThis as any).pdfjsWorker) {
    (globalThis as any).pdfjsWorker = await import('pdfjs-dist/build/pdf.worker.mjs');
  }
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .filter((item: any) => 'str' in item)
      .map((item: any) => item.str)
      .join(' ');
    if (text.trim()) pages.push(`--- Page ${i} ---\n${text}`);
  }
  return pages.join('\n\n');
}

async function handlePdf(
  buffer: Buffer,
  url: string,
  saveBinary: (buffer: Buffer, url: string, ext: string) => Promise<string>,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  let savedPath: string;
  try {
    savedPath = await saveBinary(buffer, url, '.pdf');
  } catch {
    savedPath = '(failed to save)';
  }

  try {
    const text = await extractPdfText(buffer);
    if (!text.trim()) {
      return result(
        `PDF from ${url} (saved to ${savedPath})\n\nNo extractable text (likely scanned/image-based).`,
      );
    }
    return result(`PDF content from ${url} (saved to ${savedPath}):\n\n${text}`);
  } catch (err) {
    return result(
      `PDF from ${url} (saved to ${savedPath})\n\nFailed to extract text: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
}

async function handleImage(
  buffer: Buffer,
  url: string,
  contentType: string,
  saveBinary: (buffer: Buffer, url: string, ext: string) => Promise<string>,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const ext = MIME_TO_EXT[contentType] || '.bin';
  const savedPath = await saveBinary(buffer, url, ext);
  const sizeKb = Math.round(buffer.length / 1024);

  return result(
    `Image downloaded from ${url}\nType: ${contentType}, Size: ${sizeKb}KB\n` +
      `Saved to: ${savedPath}\n\nUse the Read tool to view this image.`,
  );
}

function handleHtml(
  html: string,
  url: string,
  prompt: string | undefined,
): AgentToolResult<{ isError?: boolean }> {
  const root = parseHtml(html);
  // Strip noise elements from the DOM before selecting mainContent.
  root
    .querySelectorAll(NOISE_ELEMENTS.join(', '))
    .forEach((el) => el.remove());

  const mainContent =
    root.querySelector('main, article, [role="main"], .content, #content') ||
    root.querySelector('body') ||
    root;

  const markdown = turndown.turndown(mainContent.innerHTML);

  const prefix = prompt
    ? `Content from ${url} (asked: "${prompt}"):\n\n`
    : `Content from ${url}:\n\n`;

  return result(prefix + markdown);
}

function handleJson(
  raw: string,
  url: string,
): AgentToolResult<{ isError?: boolean }> {
  let formatted: string;
  try {
    formatted = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    formatted = raw;
  }
  return result(`JSON from ${url}:\n\n${formatted}`);
}

function handleText(
  raw: string,
  url: string,
): AgentToolResult<{ isError?: boolean }> {
  return result(`Content from ${url}:\n\n${raw}`);
}

// ============================================================
// Factory
// ============================================================

export function createWebFetchTool(
  getSessionPath: () => string | null,
): ToolDefinition<typeof schema> {
  async function saveBinary(buffer: Buffer, url: string, ext: string): Promise<string> {
    const sessionPath = getSessionPath();
    if (!sessionPath) throw new Error('No active session — cannot save file to disk');
    const dir = join(sessionPath, 'long_responses');
    await mkdir(dir, { recursive: true });
    let urlName = '';
    try { urlName = new URL(url).pathname.split('/').pop() || ''; } catch { /* malformed URL */ }
    const safe =
      urlName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40) || 'download';
    const file = `${randomUUID()}_${safe}${ext}`;
    const abs = join(dir, file);
    await writeFile(abs, buffer);
    return abs;
  }

  return {
    name: 'web_fetch',
    label: 'Web Fetch',
    description:
      'Fetch a URL and extract its content. Handles HTML (→ markdown), PDF (→ extracted text), images (→ saved to disk), JSON (→ pretty-printed), and plain text.',
    promptSnippet:
      'Use web_fetch to retrieve and extract content from a URL. Supports HTML (converted to markdown), PDF (text extraction), images (saved to disk), JSON (pretty-printed), and plain text. Pass url (required) and optional prompt to focus extraction.',
    parameters: schema,
    async execute(toolCallId, params) {
      const { url, prompt } = params;

      // SSRF protection: block non-HTTP schemes, private/reserved IPs, and pin validated DNS resolution
      let currentTarget: ValidatedUrlTarget;
      try {
        currentTarget = await validateUrl(url);
      } catch (err) {
        return result(
          `Refused to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }

      let response: Response;
      let currentUrl = currentTarget.url;
      try {
        for (let hop = 0; ; hop++) {
          response = await fetchWithPinnedDns(currentTarget, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; CraftAgent/1.0)',
              Accept:
                'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            signal: AbortSignal.timeout(30_000),
          });

          const isRedirect =
            response.status === 301 ||
            response.status === 302 ||
            response.status === 303 ||
            response.status === 307 ||
            response.status === 308;
          if (!isRedirect) break;

          if (hop >= MAX_REDIRECTS) {
            return result(`Failed to fetch ${url}: Too many redirects (max ${MAX_REDIRECTS})`, true);
          }

          const location = response.headers.get('location');
          if (!location) {
            return result(`Failed to fetch ${url}: Redirect missing Location header`, true);
          }

          const nextUrl = new URL(location, currentUrl).toString();
          try {
            currentTarget = await validateUrl(nextUrl);
          } catch (err) {
            return result(
              `Refused redirect from ${currentUrl} to ${nextUrl}: ${err instanceof Error ? err.message : String(err)}`,
              true,
            );
          }
          currentUrl = currentTarget.url;
        }
      } catch (err) {
        return result(
          `Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }

      if (!response.ok) {
        return result(
          `Failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`,
          true,
        );
      }

      // Use the final URL after redirects for all output messages
      const finalUrl = response.url || currentUrl;

      const contentType = ((response.headers.get('content-type') || '')
        .toLowerCase()
        .split(';')[0] ?? '')
        .trim();

      // Binary content types — stream with size limit
      if (contentType === 'application/pdf') {
        const buffer = await readResponseBytes(response, MAX_DOWNLOAD_SIZE);
        return handlePdf(buffer, finalUrl, saveBinary);
      }

      if (contentType.startsWith('image/')) {
        const buffer = await readResponseBytes(response, MAX_DOWNLOAD_SIZE);
        return handleImage(buffer, finalUrl, contentType, saveBinary);
      }

      // Text content types — stream with size limit then decode
      const text = await readResponseText(response, MAX_DOWNLOAD_SIZE);

      if (contentType.includes('html')) {
        return handleHtml(text, finalUrl, prompt);
      }

      if (
        contentType === 'application/json' ||
        contentType.endsWith('+json')
      ) {
        return handleJson(text, finalUrl);
      }

      return handleText(text, finalUrl);
    },
  };
}
