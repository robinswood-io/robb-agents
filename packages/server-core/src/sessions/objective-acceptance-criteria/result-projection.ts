import type { Message } from "@craft-agent/core/types";
import { createHash } from "crypto";
import { lstatSync, readFileSync, realpathSync } from "fs";
import { basename, isAbsolute, resolve, sep } from "path";
import { extractGmailMessageResultMetadataJson, extractLargeResultMetadataJson } from "@craft-agent/shared/utils";
import { normalizeCanonicalBrowserToolName, objectiveShellExitZeroProvesSuccess } from "@craft-agent/shared/agent";
import { isObjectiveToolExecutedSuccessfully } from "../objective-contract.ts";
import { canonicalToolName } from './criterion-identities.ts';
import { withoutFinalLineTerminator } from './result-checks.ts';

export function resultJson(text: string): unknown {
  try {
    const value = JSON.parse(text);
    // MCP envelopes are transport, not the business result. Unwrap only one
    // unambiguous text block; never extract arbitrary JSON from prose.
    if (Array.isArray(value?.content) && value.content.length === 1
      && value.content[0]?.type === 'text') return JSON.parse(value.content[0].text);
    return value;
  } catch { return undefined; }
}

function browserCommandVerb(input: Record<string, unknown> | undefined): string | undefined {
  const command = input?.command;
  const source = typeof command === 'string'
    ? command
    : Array.isArray(command) && typeof command[0] === 'string' ? command[0] : undefined;
  return source?.trim().split(/\s+/, 1)[0]?.toLowerCase();
}

const MAX_ACCEPTANCE_SPILL_BYTES = 2_000_000;

const MAX_ACCEPTANCE_MEDIA_JSON_BYTES = 8_000_000;

function safeWebFetchRedirect(requestedRaw: string, finalRaw: string): boolean {
  try {
    const requested = new URL(requestedRaw);
    const final = new URL(finalRaw);
    const protocolMatches = requested.protocol === final.protocol
      || requested.protocol === 'http:' && final.protocol === 'https:';
    // A single optional trailing slash is the only path normalization allowed.
    // Repeated slashes may select a different server route and must stay exact.
    const samePath = requested.pathname === final.pathname || (() => {
      if (requested.pathname === '/' || final.pathname === '/') return false;
      const requestedHasSlash = requested.pathname.endsWith('/');
      const finalHasSlash = final.pathname.endsWith('/');
      if (requestedHasSlash === finalHasSlash) return false;
      const withSlash = requestedHasSlash ? requested.pathname : final.pathname;
      const withoutSlash = requestedHasSlash ? final.pathname : requested.pathname;
      return !withoutSlash.endsWith('/') && withSlash === `${withoutSlash}/`;
    })();
    return protocolMatches
      && requested.hostname.toLowerCase() === final.hostname.toLowerCase()
      && requested.port === final.port
      && requested.username === final.username
      && requested.password === final.password
      && samePath
      && requested.search === final.search;
  } catch { return false; }
}

function authenticatedSessionArtifactText(
  filePath: string,
  digest: string,
  maxBytes: number,
  extension: '.txt' | '.json',
  expectedSessionId: string | undefined,
  notBeforeTimestamp: number,
): string | undefined {
  if (!expectedSessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(expectedSessionId)
    || !isAbsolute(filePath) || !/^[a-f0-9]{64}$/.test(digest)) return undefined;
  try {
    const declaredPath = resolve(filePath);
    const file = lstatSync(declaredPath);
    // The spill must have been produced during this exact tool invocation. A
    // stale same-session file (or a wrapper printed by a later command) is not
    // host evidence. Allow one second for coarse filesystem timestamp
    // precision while retaining the tool-start boundary.
    if (!file.isFile() || file.isSymbolicLink() || file.size > maxBytes
      || file.mtimeMs + 1_000 < notBeforeTimestamp) return undefined;
    const realPath = realpathSync(declaredPath);
    const parts = realPath.split(sep);
    const sessionsIndex = parts.lastIndexOf('sessions');
    const filename = basename(realPath);
    if (sessionsIndex < 0 || sessionsIndex + 3 !== parts.length - 1
      || parts[sessionsIndex + 1] !== expectedSessionId
      || parts[sessionsIndex + 2] !== 'long_responses'
      || !new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\\${extension}$`).test(filename)) return undefined;
    const fullText = readFileSync(realPath, 'utf8');
    return Buffer.byteLength(fullText, 'utf8') <= maxBytes
      && createHash('sha256').update(fullText).digest('hex') === digest ? fullText : undefined;
  } catch { return undefined; }
}

/** Validate the exact host spill envelope before reading its bounded payload. */
function authenticatedLargeResponseText(
  message: Message,
  text: string,
  expectedSessionId: string | undefined,
): string | undefined {
  const lines = withoutFinalLineTerminator(text).split(/\r?\n/);
  if (!/^\[(?:Large response \(~\d+ tokens\) summarized|Response too large \(~\d+ tokens\))\]$/.test(lines[0] ?? '')
    || lines[1] !== '') return undefined;
  let index = 2;
  let statedMetadata: string | undefined;
  const metadataPrefix = 'Result metadata JSON: ';
  if (lines[index]?.startsWith(metadataPrefix)) {
    statedMetadata = lines[index]!.slice(metadataPrefix.length);
    index += 1;
    if (lines[index++] !== '') return undefined;
  }
  const digest = /^Full data SHA256: ([a-f0-9]{64})$/.exec(lines[index++] ?? '')?.[1];
  if (!digest || lines[index++] !== '') return undefined;
  const filePath = /^Full data saved to: (.+)$/.exec(lines[index++] ?? '')?.[1];
  if (!filePath || !isAbsolute(filePath)
    || lines[index++] !== '- Use Read/Grep to access specific content') return undefined;

  try {
    const filename = basename(filePath);
    if (lines[index++] !== `- Use transform_data with inputFiles: ["long_responses/${filename}"] for data analysis`
      || lines[index] !== undefined && lines[index] !== '') return undefined;
    const fullText = authenticatedSessionArtifactText(
      filePath, digest, MAX_ACCEPTANCE_SPILL_BYTES, '.txt', expectedSessionId, message.timestamp,
    );
    if (fullText === undefined) return undefined;
    const recomputedMetadata = extractLargeResultMetadataJson(fullText, {
      toolName: message.toolName ?? '', input: message.toolInput,
    });
    if (statedMetadata !== recomputedMetadata) return undefined;
    return fullText;
  } catch { return undefined; }
}

function attachBashTransport(projection: unknown, transport: Record<string, unknown> | undefined): unknown {
  if (!transport) return projection;
  if (projection === undefined) return { transport };
  return projection && typeof projection === 'object' && !Array.isArray(projection)
    ? { ...(projection as Record<string, unknown>), transport }
    : { result: projection, transport };
}

/** The rbw SSH connector reports the remote process status as `code`.
 * Preserve a criterion registered with the conventional `exitCode` spelling
 * only for its executed, target-bound structured response. */
function attachRbwSshExitCode(message: Message, projection: unknown): unknown {
  if (message.toolName !== 'mcp__rbw-servers__ssh_execute'
    || message.toolExecuted !== true || !isObjectiveToolExecutedSuccessfully(message)
    || !projection || typeof projection !== 'object' || Array.isArray(projection)) return projection;
  const result = projection as Record<string, unknown>;
  const input = message.toolInput;
  if (typeof input?.server !== 'string' || typeof input.cwd !== 'string'
    || typeof input.command !== 'string' || result.server !== input.server
    || result.command !== `cd ${input.cwd} && ${input.command}`
    || !Number.isSafeInteger(result.code) || typeof result.success !== 'boolean'
    || typeof result.stderr !== 'string' || typeof result.stdout !== 'string') return projection;
  return { ...result, exitCode: result.code };
}

/**
 * A few first-party observation tools intentionally persist human-readable
 * output. Project only their authenticated, exact wire formats into the small
 * structured fields advertised by their tool semantics. This is deliberately
 * not a general JSON/prose extractor: near-miss text remains non-evidence.
 */
export function resultProjection(
  message: Message,
  allowLargeResponse = true,
  expectedSessionId?: string,
): unknown {
  const text = message.toolResult ?? '';
  const rawToolName = message.toolName ?? '';
  const toolName = rawToolName.startsWith('functions.')
    ? rawToolName.slice('functions.'.length)
    : rawToolName;
  const bashTransport = message.toolExecuted === true
    && isObjectiveToolExecutedSuccessfully(message) && canonicalToolName(toolName) === 'bash'
    ? (() => {
      const command = [message.toolInput?.command, message.toolInput?.cmd, message.toolInput?.script]
        .find((value): value is string => typeof value === 'string');
      return command && objectiveShellExitZeroProvesSuccess(command)
        ? { success: true, code: 0 }
        : { code: 0 };
    })()
    : undefined;
  if (allowLargeResponse) {
    const fullText = authenticatedLargeResponseText(message, text, expectedSessionId);
    if (fullText !== undefined) {
      return resultProjection({ ...message, toolResult: fullText }, false, expectedSessionId);
    }
  }
  const parsed = resultJson(text);
  if (parsed !== undefined) return attachBashTransport(attachRbwSshExitCode(message, parsed), bashTransport);
  // Synthetic projections require a positively recorded execution. Merely
  // completed legacy/checkpoint records are not enough.
  if (message.toolExecuted !== true || !message.toolName) return undefined;

  if (canonicalToolName(toolName) === 'web_fetch') {
    const match = /^JSON from (https?:\/\/[^\r\n]+):\r?\n\r?\n([\s\S]+)$/.exec(withoutFinalLineTerminator(text));
    if (!match || typeof message.toolInput?.url !== 'string') return undefined;
    try {
      if (!safeWebFetchRedirect(message.toolInput.url, match[1]!)) return undefined;
      return JSON.parse(match[2]!);
    } catch { return undefined; }
  }

  if (toolName === 'mcp__google-contacts__gmail_get_message') {
    const lines = withoutFinalLineTerminator(text).split(/\r?\n/);
    const prefix = 'Result metadata JSON: ';
    if (lines[0] !== '[Structured media assets extracted and saved]' || lines[1] !== ''
      || !lines[2]?.startsWith(prefix) || lines[3] !== '') {
      return undefined;
    }
    try {
      const statedMetadata = lines[2].slice(prefix.length);
      const digest = /^Original JSON SHA256: ([a-f0-9]{64})$/.exec(lines[4] ?? '')?.[1];
      const originalPath = /^Original JSON: (.+)$/.exec(lines[5] ?? '')?.[1];
      if (!digest || !originalPath || !lines[6]?.startsWith('Linked JSON: ')
        || !/^Assets extracted: [1-9]\d{0,5}$/.test(lines[7] ?? '')) return undefined;
      const originalJson = authenticatedSessionArtifactText(
        originalPath, digest, MAX_ACCEPTANCE_MEDIA_JSON_BYTES, '.json', expectedSessionId, message.timestamp,
      );
      if (originalJson === undefined
        || extractGmailMessageResultMetadataJson(originalJson, toolName) !== statedMetadata) return undefined;
      const metadata: unknown = JSON.parse(statedMetadata);
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
      const record = metadata as Record<string, unknown>;
      const allowed = new Set(['id', 'threadId', 'subject', 'from', 'to', 'cc', 'bcc', 'date', 'messageIdHeader', 'labelIds']);
      if (!Object.keys(record).length || Object.keys(record).some(key => !allowed.has(key))) return undefined;
      for (const [key, value] of Object.entries(record)) {
        if (key === 'labelIds') {
          if (!Array.isArray(value) || value.length > 32
            || value.some(label => typeof label !== 'string' || label.length > 128)) return undefined;
        } else if (typeof value !== 'string' || value.length > 2_048) return undefined;
      }
      return record;
    } catch { return undefined; }
  }

  if (toolName === 'mcp__google-contacts__gmail_search_exact') {
    const lines = withoutFinalLineTerminator(text).split(/\r?\n/);
    if (/^Aucun message Gmail trouvé pour : « .+ »$/.test(lines[0] ?? '') && lines.length === 1) {
      return { resultCount: 0, success: true };
    }
    if (!/^\*\*Recherche Gmail API : .+\*\*$/.test(lines[0] ?? '')) return undefined;
    const count = /^_(0|[1-9]\d{0,5}) message\(s\) retourné\(s\) ; lire le message exact avant toute action\._$/
      .exec(lines[1] ?? '');
    return count ? { resultCount: Number(count[1]), success: true } : undefined;
  }

  if (normalizeCanonicalBrowserToolName(toolName) === 'browser_tool'
    && browserCommandVerb(message.toolInput) === 'navigate') {
    const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
    const url = firstLine.startsWith('Navigated to: ') ? firstLine.slice('Navigated to: '.length) : '';
    if (!url || url.length > 8_192) return undefined;
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return undefined;
      return { success: true, url: parsedUrl.toString() };
    } catch { return undefined; }
  }

  // This first-party connector throws on any non-zero remote exit status. A
  // completed, explicitly executed call therefore attests healthcheck exit 0;
  // retain stdout as evidence while exposing only that transport contract.
  if (toolName === 'mcp__rbw-agents-oss__oss_healthcheck' && text.trim()) {
    return { success: true, code: 0 };
  }
  // Native Bash reports a non-zero exit as a failed tool result. For a real,
  // completed invocation, transport success is therefore deterministic even
  // when curl or another read returns HTML/text instead of JSON.
  if (canonicalToolName(toolName) === 'bash') return attachBashTransport(undefined, bashTransport);
  return undefined;
}
