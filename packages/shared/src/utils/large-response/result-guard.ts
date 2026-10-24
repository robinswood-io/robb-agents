import { createHash } from "crypto";
import { debug } from "../debug.ts";
import { looksLikeBinary, extractBase64Binary, detectExtensionFromMagic, saveBinaryResponse, sanitizeFilename } from "../binary-detection.ts";
import { saveLargeResponse } from './artifact-storage.ts';
import { extractAssetsFromStructuredJson, formatStructuredMediaExtractionMessage } from './json-assets.ts';
import type { SummarizationContext } from './response-format.ts';
import { buildSummarizationPrompt, extractLargeResultMetadataJson, formatLargeResponseMessage } from './response-format.ts';
import { MAX_SUMMARIZATION_INPUT, estimateTokensDensityAware, tokenLimitFor } from './token-budget.ts';

// ============================================================
// High-level Pipeline (orchestrates save + summarize + format)
// ============================================================

export interface HandleLargeResponseOptions {
  /** Full response text */
  text: string;
  /** Path to the session folder */
  sessionPath: string;
  /** Context about the tool call */
  context: SummarizationContext;
  /** Optional summarize callback — typically agent.getSummarizeCallback() */
  summarize?: (prompt: string) => Promise<string | null>;
  /** Active model's context window — see {@link guardLargeResult}. */
  contextWindow?: number;
}

export interface HandleLargeResponseResult {
  /** Formatted message for the model */
  message: string;
  /** Absolute path to saved file */
  filePath: string;
  /** Whether the response was summarized (vs preview-only) */
  wasSummarized: boolean;
}

/**
 * Thin guard wrapper: returns the replacement text if the result is too large
 * or contains binary data, or null if the result should be passed through as-is.
 *
 * Accepts string | Buffer:
 * - Buffer: binary detection on raw bytes (preserves data integrity for file saving).
 *   Used by api-tools which has raw HTTP response buffers.
 * - string: binary detection via Buffer conversion. Used by MCP pool and Claude SDK
 *   where data is already a string.
 *
 * Pipeline: binary check → (if text) size check → save + summarize.
 *
 * Shared by McpClientPool.callTool(), api-tools.ts, and claude-agent.ts.
 */
export async function guardLargeResult(
  input: string | Buffer,
  opts: {
    sessionPath: string;
    toolName: string;
    input?: Record<string, unknown>;
    intent?: string;
    summarize?: (prompt: string) => Promise<string | null>;
    /** Active model's context window — when provided, the per-result
     *  summarization threshold scales via {@link tokenLimitFor}. Omit at
     *  call sites without model knowledge to retain the fixed default. */
    contextWindow?: number;
  }
): Promise<string | null> {
  // 1. Binary detection — check before any text processing
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf-8');
  if (looksLikeBinary(buffer)) {
    debug('large-response', `${opts.toolName}: binary content detected (${buffer.length} bytes)`);
    const ext = detectExtensionFromMagic(buffer) || '.bin';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = sanitizeFilename(opts.toolName);
    const filename = `${safeName}_${timestamp}${ext}`;
    const result = saveBinaryResponse(opts.sessionPath, filename, buffer, null);
    if (result.type === 'file_download') {
      return `[Binary content detected and saved]\n\nFile: ${result.path}\nSize: ${result.sizeHuman}\nType: ${ext.slice(1).toUpperCase() || 'unknown'}\n\nUse the Read tool or reference this path to work with the file.`;
    }
    return `[Binary content detected but save failed: ${result.error}]`;
  }

  // 2. Convert to string (no-op if already string, toString if Buffer that passed binary check)
  const text = typeof input === 'string' ? input : buffer.toString('utf-8');

  // 2b. Structured JSON extraction path — preserve original JSON, extract binary assets,
  // and emit a linked JSON that replaces base64 blobs with file references.
  const structuredExtraction = extractAssetsFromStructuredJson(text, opts.sessionPath, opts.toolName);
  if (structuredExtraction) {
    debug('large-response', `${opts.toolName}: extracted ${structuredExtraction.assets.length} media assets from structured JSON payload`);
    return formatStructuredMediaExtractionMessage(structuredExtraction);
  }

  // 2c. Inline base64-encoded binary detection (data URLs and raw base64 blobs)
  const base64Result = extractBase64Binary(text);
  if (base64Result) {
    debug('large-response', `${opts.toolName}: ${base64Result.source} binary detected (${base64Result.buffer.length} decoded bytes)`);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = sanitizeFilename(opts.toolName);
    const filename = `${safeName}_${timestamp}${base64Result.ext}`;
    const result = saveBinaryResponse(opts.sessionPath, filename, base64Result.buffer, base64Result.mimeType);
    if (result.type === 'file_download') {
      return `[Base64-encoded binary detected and saved]\n\nFile: ${result.path}\nSize: ${result.sizeHuman}\nType: ${base64Result.ext.slice(1).toUpperCase() || 'unknown'}\n\nThe tool result contained base64-encoded binary data which has been decoded and saved.`;
    }
    return `[Base64-encoded binary detected but save failed: ${result.error}]`;
  }

  // 3. Existing size check + summarize flow (model-aware when contextWindow provided).
  // Use density-aware estimate so base64-heavy text (MIME, JSON-embedded binary)
  // can't slip past the 4-chars/token heuristic and poison conversation context.
  if (estimateTokensDensityAware(text) <= tokenLimitFor(opts.contextWindow)) return null;
  const result = await handleLargeResponse({
    text,
    sessionPath: opts.sessionPath,
    context: { toolName: opts.toolName, input: opts.input, intent: opts.intent },
    summarize: opts.summarize,
    contextWindow: opts.contextWindow,
  });
  return result?.message ?? null;
}

export function buildHeadTailPreview(text: string, maxChars = 2_000): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * 0.7);
  const tailChars = maxChars - headChars;
  const omitted = text.length - maxChars;
  return `${text.slice(0, headChars)}\n... [${omitted} chars omitted] ...\n${text.slice(-tailChars)}`;
}

export function isAlreadyGuardedLargeResponse(text: string): boolean {
  return text.startsWith('[Large response (')
    || text.startsWith('[Response too large (')
    || text.startsWith('[Binary content detected')
    || text.startsWith('[Base64-encoded binary detected')
    || text.startsWith('[Structured media assets extracted and saved]');
}

/**
 * Full pipeline: save to disk, optionally summarize, format result message.
 *
 * Call this when a tool result exceeds TOKEN_LIMIT.
 * If `summarize` callback is provided and tokens are within MAX_SUMMARIZATION_INPUT,
 * it will be called with the built prompt. Otherwise falls back to preview.
 *
 * @returns Formatted result, or null if the text is not large enough to handle
 */
export async function handleLargeResponse(
  opts: HandleLargeResponseOptions
): Promise<HandleLargeResponseResult | null> {
  const { text, sessionPath, context, summarize, contextWindow } = opts;
  if (isAlreadyGuardedLargeResponse(text)) {
    return null;
  }
  const estimatedTokens = estimateTokensDensityAware(text);

  if (estimatedTokens <= tokenLimitFor(contextWindow)) {
    return null; // Not large enough — caller should return as-is
  }

  debug('large-response', `${context.toolName}: ${text.length} bytes, ~${estimatedTokens} tokens`);

  // 1. Save full response to disk
  const saveResult = saveLargeResponse(
    sessionPath,
    context.toolName,
    context.path || '',
    text
  );

  if (!saveResult) {
    // File save failed — return preview without file references
    const preview = buildHeadTailPreview(text);
    return {
      message: `[Response too large (~${estimatedTokens} tokens)]\n\nPreview:\n${preview}...`,
      filePath: '',
      wasSummarized: false,
    };
  }

  const { absolutePath, relativePath } = saveResult;

  // 2. Try summarization if within limits and callback provided
  let summary: string | undefined;
  if (summarize && estimatedTokens <= MAX_SUMMARIZATION_INPUT) {
    try {
      const prompt = buildSummarizationPrompt(text, context);
      const result = await summarize(prompt);
      if (result) {
        summary = result;
      }
    } catch (error) {
      debug('large-response', `Summarization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 3. Format message
  const message = formatLargeResponseMessage({
    estimatedTokens,
    relativePath,
    absolutePath,
    summary,
    preview: summary ? undefined : buildHeadTailPreview(text),
    resultMetadataJson: extractLargeResultMetadataJson(text, context),
    fullDataSha256: createHash('sha256').update(text).digest('hex'),
  });

  return { message, filePath: absolutePath, wasSummarized: !!summary };
}
