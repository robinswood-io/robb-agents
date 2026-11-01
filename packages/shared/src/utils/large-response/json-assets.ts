import { isUnknownArray } from '../json.ts';
/**
 * Large Response Handling Utility
 *
 * Centralized save + prompt building + formatting for large tool results.
 * Follows the title-generator.ts pattern: pure functions only, no SDK/LLM calls.
 *
 * Callers orchestrate via their agent's selected-model query callback for summarization.
 */
import { existsSync, linkSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { createHash, randomUUID } from "crypto";
import { join, relative } from "path";
import { debug } from "../debug.ts";
import { extractBase64Binary, sanitizeFilename, formatBytes } from "../binary-detection.ts";
import type { SaveResult } from './artifact-storage.ts';
import { LONG_RESPONSES_DIR } from './token-budget.ts';

// ============================================================
// Structured Media Extraction (JSON payloads)
// ============================================================

interface SavedJsonArtifact extends SaveResult {
  filename: string;
}

interface SavedAsset {
  absolutePath: string;
  relativePath: string;
  mimeType: string | null;
  ext: string;
  size: number;
  sizeHuman: string;
  sha256: string;
  jsonPath: string;
  source: 'data-url' | 'raw-base64';
}

interface JsonAssetExtractionResult {
  originalJsonPath: string;
  originalJsonSha256: string;
  linkedJsonPath: string;
  assets: SavedAsset[];
  /** Bounded non-body fields retained for exact Gmail acceptance checks. */
  resultMetadataJson?: string;
}

function gmailMessageResultMetadata(parsed: unknown, toolName: string): string | undefined {
  const normalizedToolName = toolName.startsWith('functions.')
    ? toolName.slice('functions.'.length)
    : toolName;
  if (!parsed || typeof parsed !== 'object' || isUnknownArray(parsed)) return undefined;
  const envelope = parsed as Record<string, unknown>;
  const isDirectGmailRead = normalizedToolName === 'mcp__google-contacts__gmail_get_message'
    || normalizedToolName === 'mcp__google-contacts__gmail_get_message_by_url';
  const isOrionGmailRead = (normalizedToolName === 'mcp__orion-mcp__orion_mcp_read'
    || normalizedToolName === 'mcp__orion-mcp__orion_mcp_call')
    && (envelope["tool"] === 'gmail_get_message' || envelope["tool"] === 'gmail_get_message_by_url')
    && envelope["data"] !== null && typeof envelope["data"] === 'object' && !isUnknownArray(envelope["data"]);
  if (!isDirectGmailRead && !isOrionGmailRead) return undefined;
  const rawSource = isOrionGmailRead ? envelope["data"] as Record<string, unknown> : envelope;
  const latest = rawSource["latestMessage"] && typeof rawSource["latestMessage"] === 'object' && !isUnknownArray(rawSource["latestMessage"])
    ? rawSource["latestMessage"] as Record<string, unknown>
    : undefined;
  const source = typeof rawSource["id"] === 'string' ? rawSource : (latest ?? rawSource);
  const metadata: Record<string, unknown> = {};
  for (const key of ['id', 'threadId', 'subject', 'from', 'to', 'cc', 'bcc', 'date', 'messageIdHeader']) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key) ?? Object.getOwnPropertyDescriptor(rawSource, key);
    if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
      && descriptor.value.length <= 2_048) metadata[key] = descriptor.value;
  }
  const labels = Object.getOwnPropertyDescriptor(source, 'labelIds') ?? Object.getOwnPropertyDescriptor(rawSource, 'labelIds');
  const labelIds: unknown = labels && 'value' in labels ? labels.value : undefined;
  if (isUnknownArray(labelIds) && labelIds.length <= 32
    && labelIds.every((value: unknown): value is string => typeof value === 'string' && value.length <= 128)) {
    metadata["labelIds"] = [...labelIds];
  }
  return Object.keys(metadata).length ? JSON.stringify(metadata) : undefined;
}

/** Recompute the exact bounded Gmail header projection from the saved source
 * JSON. Callers must authenticate the source artifact before trusting it. */
export function extractGmailMessageResultMetadataJson(text: string, toolName: string): string | undefined {
  if (!text || text.length > 8_000_000) return undefined;
  try { return gmailMessageResultMetadata(JSON.parse(text), toolName); } catch { return undefined; }
}

function saveJsonArtifact(
  sessionPath: string,
  toolName: string,
  suffix: string,
  content: string
): SavedJsonArtifact | null {
  const responsesDir = join(sessionPath, LONG_RESPONSES_DIR);
  try {
    mkdirSync(responsesDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    const safeTool = (sanitizeFilename(toolName || 'tool_result') || 'tool_result').slice(0, 120);
    const safeSuffix = (sanitizeFilename(suffix || 'artifact') || 'artifact').slice(0, 40);
    for (let attempt = 0; attempt < 8; attempt++) {
      const uniqueId = randomUUID();
      const filename = `${timestamp}_${uniqueId}_${safeTool}_${safeSuffix}.json`;
      const absolutePath = join(responsesDir, filename);
      const temporaryPath = join(responsesDir, `.json-artifact-${uniqueId}.partial`);
      let temporaryCreated = false;
      try {
        // Publish a complete inode without ever replacing an earlier result.
        // The UUID also keeps original/linked evidence stable when several
        // connector responses finish during the same millisecond.
        writeFileSync(temporaryPath, content, { encoding: 'utf-8', flag: 'wx' });
        temporaryCreated = true;
        linkSync(temporaryPath, absolutePath);
        return {
          absolutePath,
          relativePath: relative(sessionPath, absolutePath),
          filename,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      } finally {
        if (temporaryCreated) {
          try { unlinkSync(temporaryPath); } catch { /* already absent */ }
        }
      }
    }
    throw new Error('Failed to allocate a unique structured JSON artifact path');
  } catch (error) {
    debug('large-response', `Failed to save JSON artifact: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function inferMimeFromContext(container: unknown): string | null {
  if (!container || typeof container !== 'object' || isUnknownArray(container)) return null;
  const obj = container as Record<string, unknown>;
  const keys = ['mimeType', 'media_type', 'mime', 'contentType', 'content_type'];
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function saveExtractedAsset(
  sessionPath: string,
  toolName: string,
  buffer: Buffer,
  ext: string,
  mimeType: string | null,
  jsonPath: string,
  source: 'data-url' | 'raw-base64'
): SavedAsset | null {
  try {
    const assetsDir = join(sessionPath, 'downloads', 'assets');
    mkdirSync(assetsDir, { recursive: true });

    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const safeTool = sanitizeFilename(toolName || 'tool_result');
    const safeExt = ext.startsWith('.') ? ext : `.${ext || 'bin'}`;
    const filename = `${safeTool}_${sha256.slice(0, 16)}${safeExt}`;
    const absolutePath = join(assetsDir, filename);

    if (!existsSync(absolutePath)) {
      writeFileSync(absolutePath, buffer, { flag: 'wx' });
    }

    return {
      absolutePath,
      relativePath: relative(sessionPath, absolutePath),
      mimeType,
      ext: safeExt,
      size: buffer.length,
      sizeHuman: formatBytes(buffer.length),
      sha256,
      jsonPath,
      source,
    };
  } catch (error) {
    debug('large-response', `Failed to save extracted asset: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function extractAssetsFromStructuredJson(
  text: string,
  sessionPath: string,
  toolName: string
): JsonAssetExtractionResult | null {
  const trimmed = text.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const linked = JSON.parse(JSON.stringify(parsed)) as unknown;
  const assets: SavedAsset[] = [];

  const walk = (node: unknown, path: string, parent: Record<string, unknown> | unknown[] | null, key: string | number | null) => {
    if (typeof node === 'string') {
      const extraction = extractBase64Binary(node);
      if (!extraction || !parent || key === null) return;

      const contextMime = inferMimeFromContext(parent);
      const mime = extraction.mimeType || contextMime;
      const ext = extraction.ext || '.bin';
      const saved = saveExtractedAsset(sessionPath, toolName, extraction.buffer, ext, mime, path, extraction.source);
      if (!saved) return;

      const replacement = {
        assetRef: {
          path: saved.absolutePath,
          relativePath: saved.relativePath,
          mimeType: saved.mimeType,
          ext: saved.ext,
          size: saved.size,
          sizeHuman: saved.sizeHuman,
          sha256: saved.sha256,
          jsonPath: saved.jsonPath,
          source: saved.source,
        },
      };

      if (isUnknownArray(parent)) {
        parent[key as number] = replacement;
      } else {
        (parent as Record<string, unknown>)[String(key)] = replacement;
      }
      assets.push(saved);
      return;
    }

    if (isUnknownArray(node)) {
      node.forEach((item: unknown, idx) => walk(item, `${path}[${idx}]`, node, idx));
      return;
    }

    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        const childPath = path === '$' ? `$.${k}` : `${path}.${k}`;
        walk(v, childPath, obj, k);
      }
    }
  };

  walk(linked, '$', null, null);

  if (assets.length === 0) return null;

  const originalArtifact = saveJsonArtifact(sessionPath, toolName, 'original', text);
  const linkedArtifact = saveJsonArtifact(sessionPath, toolName, 'linked', JSON.stringify(linked, null, 2));

  if (!originalArtifact || !linkedArtifact) return null;
  const resultMetadataJson = gmailMessageResultMetadata(parsed, toolName);

  return {
    originalJsonPath: originalArtifact.absolutePath,
    originalJsonSha256: createHash('sha256').update(text).digest('hex'),
    linkedJsonPath: linkedArtifact.absolutePath,
    assets,
    ...(resultMetadataJson ? { resultMetadataJson } : {}),
  };
}

export function formatStructuredMediaExtractionMessage(result: JsonAssetExtractionResult): string {
  const assetsList = result.assets
    .map((asset, index) => `${index + 1}. ${asset.absolutePath} (${asset.sizeHuman}, ${asset.mimeType || asset.ext.slice(1).toUpperCase()}, from ${asset.jsonPath})`)
    .join('\n');

  return [
    '[Structured media assets extracted and saved]',
    '',
    ...(result.resultMetadataJson ? [`Result metadata JSON: ${result.resultMetadataJson}`, ''] : []),
    `Original JSON SHA256: ${result.originalJsonSha256}`,
    `Original JSON: ${result.originalJsonPath}`,
    `Linked JSON: ${result.linkedJsonPath}`,
    `Assets extracted: ${result.assets.length}`,
    assetsList ? `\n${assetsList}` : '',
    '',
    'Use the linked JSON for analysis and click asset file paths to preview/open the extracted media.',
  ].join('\n');
}
