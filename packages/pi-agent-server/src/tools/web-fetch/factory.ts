import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { handleHtml } from './html.ts';
import type { ValidatedUrlTarget } from './network-safety.ts';
import { validateUrl } from './network-safety.ts';
import { handlePdf } from './pdf.ts';
import { handleImage, handleJson, handleText, readResponseBytes, readResponseText, result } from './responses.ts';
import { fetchWithPinnedDns } from './socket-fetch.ts';

const schema = Type.Object({
  url: Type.String({ description: 'URL to fetch' }),
  prompt: Type.Optional(
    Type.String({
      description:
        'Context hint included in the output prefix (e.g. "find the pricing table"). The full page content is always returned — use this to annotate what you were looking for.',
    }),
  ),
});

const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024;

// ============================================================
// SSRF protection
// ============================================================

const MAX_REDIRECTS = 5;

// ============================================================
// Factory
// ============================================================

export function createWebFetchTool(
  getSessionPath: () => string | null,
) {
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
  } satisfies ToolDefinition<typeof schema, { isError?: boolean }>;
}
