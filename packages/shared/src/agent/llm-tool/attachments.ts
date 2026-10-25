import { readFile } from "fs/promises";
import { existsSync, statSync } from "fs";
import path from "node:path";

// ============================================================================
// CONSTANTS
// ============================================================================

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

// Limits - chosen to balance capability with reasonable resource usage
const MAX_FILE_LINES = 2000;

const MAX_FILE_BYTES = 500_000;

// 500KB per text file
export const MAX_ATTACHMENTS = 20;

export const MAX_TOTAL_CONTENT_BYTES = 2_000_000;

// ============================================================================
// HELPER: SUMMARIZE FILE SECTION
// Analyzes a section of a file to provide hints about its content
// Used in error messages when files are too large
// ============================================================================

function summarizeSection(lines: string[], start: number, end: number): string {
  const section = lines.slice(start, Math.min(end, lines.length));
  if (section.length === 0) return '(empty)';

  // Pattern matching to identify content types in this section
  const patterns = {
    imports: /^(import|from|require|use)\b/,
    exports: /^export\b/,
    functions: /^(async\s+)?(function|const\s+\w+\s*=.*=>|def\s+|fn\s+)/,
    classes: /^(class|struct|interface|type)\s+/,
    tests: /^(describe|it|test|def test_)\b/,
    comments: /^(\/\/|\/\*|#|"""|''')/,
    config: /^[\s]*["']?\w+["']?\s*[:=]/,
  };

  const found: string[] = [];
  for (const [name, pattern] of Object.entries(patterns)) {
    if (section.some(l => pattern.test(l.trim()))) {
      found.push(name);
    }
  }

  return found.length ? found.join(', ') : 'code/text';
}

// ============================================================================
// HELPER: ESCAPE XML SPECIAL CHARACTERS
// Prevents issues when filenames are embedded in XML-like tags
// ============================================================================

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ============================================================================
// HELPER: CHECK IF CONTENT APPEARS TO BE BINARY
// Binary files often contain null bytes - check first chunk
// ============================================================================

function isBinaryContent(content: string): boolean {
  // Check first 8KB for null bytes (common indicator of binary data)
  const checkLength = Math.min(content.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (content.charCodeAt(i) === 0) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// HELPER: VALIDATE AND PROCESS ATTACHMENT
// Handles file/image loading with validation and error reporting
// ============================================================================

interface AttachmentInput {
  path: string;
  startLine?: number;
  endLine?: number;
}

type AttachmentResult =
  | { type: 'text'; content: string; filename: string; bytes: number }
  | { type: 'image'; base64: string; mediaType: string }
  | { type: 'error'; message: string };

export async function processAttachment(
  input: string | AttachmentInput,
  index: number,
  basePath?: string,
): Promise<AttachmentResult> {
  // Normalize input to AttachmentInput format
  const attachment: AttachmentInput = typeof input === 'string'
    ? { path: input }
    : input;

  let { path: filePath, startLine, endLine } = attachment;

  // Resolve relative paths against basePath (session directory)
  if (basePath && filePath && !path.isAbsolute(filePath) && !filePath.startsWith('~')) {
    filePath = path.resolve(basePath, filePath);
  }
  const filename = filePath.split('/').pop() || filePath;
  const safeFilename = escapeXml(filename); // Escape for use in XML-like tags

  // --- Validate path exists and is a file ---
  if (!filePath || typeof filePath !== 'string') {
    return { type: 'error', message: `Attachment ${index + 1}: Invalid path (got ${typeof filePath})` };
  }

  if (!existsSync(filePath)) {
    return { type: 'error', message: `Attachment ${index + 1}: File not found: ${filePath}` };
  }

  // --- Get file stats with error handling for permission issues and broken symlinks ---
  let stats;
  try {
    stats = statSync(filePath);
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('EACCES') || err.message.includes('permission')) {
        return { type: 'error', message: `Attachment ${index + 1}: Permission denied reading "${safeFilename}". Check file permissions.` };
      }
      if (err.message.includes('ENOENT') || err.message.includes('ELOOP')) {
        return { type: 'error', message: `Attachment ${index + 1}: Broken symlink or file moved: ${filePath}` };
      }
      return { type: 'error', message: `Attachment ${index + 1}: Cannot access "${safeFilename}": ${err.message}` };
    }
    return { type: 'error', message: `Attachment ${index + 1}: Cannot access "${safeFilename}"` };
  }

  if (stats.isDirectory()) {
    return { type: 'error', message: `Attachment ${index + 1}: "${safeFilename}" is a directory, not a file. Use Glob to find files in directories.` };
  }

  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const isImage = IMAGE_EXTENSIONS.includes(ext);

  // --- Validate line range params ---
  if ((startLine !== undefined || endLine !== undefined) && isImage) {
    return { type: 'error', message: `Attachment ${index + 1}: Line ranges not supported for images. Remove startLine/endLine.` };
  }

  if (startLine !== undefined && (typeof startLine !== 'number' || startLine < 1 || !Number.isInteger(startLine))) {
    return { type: 'error', message: `Attachment ${index + 1}: startLine must be a positive integer (got ${startLine})` };
  }

  if (endLine !== undefined && (typeof endLine !== 'number' || endLine < 1 || !Number.isInteger(endLine))) {
    return { type: 'error', message: `Attachment ${index + 1}: endLine must be a positive integer (got ${endLine})` };
  }

  if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
    return { type: 'error', message: `Attachment ${index + 1}: startLine (${startLine}) cannot be greater than endLine (${endLine})` };
  }

  // --- Validate line range size isn't too large ---
  if (startLine !== undefined && endLine !== undefined) {
    const rangeSize = endLine - startLine + 1;
    if (rangeSize > MAX_FILE_LINES) {
      return { type: 'error', message: `Attachment ${index + 1}: Line range too large (${rangeSize} lines, max ${MAX_FILE_LINES}). Reduce the range or split into multiple calls.` };
    }
  }

  // --- Process image ---
  if (isImage) {
    const maxImageBytes = 5_000_000; // 5MB
    if (stats.size > maxImageBytes) {
      const sizeMB = (stats.size / 1_000_000).toFixed(1);
      return { type: 'error', message: `Attachment ${index + 1}: Image too large (${sizeMB}MB, max ${maxImageBytes / 1_000_000}MB): ${safeFilename}` };
    }

    try {
      const imageData = await readFile(filePath);
      const base64 = imageData.toString('base64');
      const mediaType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      return { type: 'image', base64, mediaType };
    } catch (err) {
      return { type: 'error', message: `Attachment ${index + 1}: Failed to read image "${safeFilename}": ${err instanceof Error ? err.message : err}` };
    }
  }

  // --- Process text file ---

  // Pre-read size check: fail fast for huge files without loading them
  // Note: This is a byte count check, not line count - we still need to read to count lines
  if (stats.size > MAX_FILE_BYTES && startLine === undefined && endLine === undefined) {
    const sizeKB = Math.round(stats.size / 1024);
    return {
      type: 'error',
      message: `Attachment ${index + 1}: File too large (${sizeKB}KB, max ${MAX_FILE_BYTES / 1000}KB).

Use a line range to select a portion:
  { path: "${filePath}", startLine: 1, endLine: 500 }

Tip: Try reading a smaller section first to understand the file structure.`,
    };
  }

  try {
    const content = await readFile(filePath, 'utf-8');

    // Check for binary content (null bytes indicate binary)
    if (isBinaryContent(content)) {
      return { type: 'error', message: `Attachment ${index + 1}: "${safeFilename}" appears to be a binary file, not text. Only text files and images (png, jpg, gif, webp) are supported.` };
    }

    // Check for empty or whitespace-only files
    if (content.trim().length === 0) {
      return { type: 'error', message: `Attachment ${index + 1}: "${safeFilename}" is empty or contains only whitespace. Nothing to process.` };
    }

    const lines = content.split('\n');
    const totalLines = lines.length;

    // If line range specified, extract it
    if (startLine !== undefined || endLine !== undefined) {
      const start = (startLine || 1) - 1;
      const end = endLine || lines.length;

      if (start >= lines.length) {
        return { type: 'error', message: `Attachment ${index + 1}: startLine (${startLine}) exceeds file length (${totalLines} lines)` };
      }

      const slice = lines.slice(start, end);
      const rangeNote = `[Lines ${start + 1}-${Math.min(end, totalLines)} of ${totalLines}]`;
      const sliceContent = slice.join('\n');
      return { type: 'text', content: `${rangeNote}\n${sliceContent}`, filename: safeFilename, bytes: Buffer.byteLength(sliceContent, 'utf-8') };
    }

    // Check size limits for files without explicit range (line count check)
    if (lines.length > MAX_FILE_LINES) {
      const sizeInfo = `${totalLines} lines, ${Math.round(content.length / 1024)}KB`;

      // Build helpful section breakdown to guide line range selection
      const sections: string[] = [];
      const chunkSize = Math.ceil(totalLines / 4);
      for (let i = 0; i < 4 && i * chunkSize < totalLines; i++) {
        const start = i * chunkSize;
        const end = Math.min((i + 1) * chunkSize, totalLines);
        const summary = summarizeSection(lines, start, end);
        sections.push(`  Lines ${start + 1}-${end}: ${summary}`);
      }

      return {
        type: 'error',
        message: `Attachment ${index + 1}: File too large (${sizeInfo}, max ${MAX_FILE_LINES} lines).

Use a line range to select a portion:
  { path: "${filePath}", startLine: 1, endLine: 500 }

File structure (${totalLines} lines total):
${sections.join('\n')}`,
      };
    }

    return { type: 'text', content, filename: safeFilename, bytes: Buffer.byteLength(content, 'utf-8') };
  } catch (err) {
    // Handle read errors (permission issues, etc.)
    if (err instanceof Error) {
      if (err.message.includes('EACCES') || err.message.includes('permission')) {
        return { type: 'error', message: `Attachment ${index + 1}: Permission denied reading "${safeFilename}". Check file permissions.` };
      }
      return { type: 'error', message: `Attachment ${index + 1}: Failed to read file "${safeFilename}": ${err.message}` };
    }
    return { type: 'error', message: `Attachment ${index + 1}: Failed to read file "${safeFilename}"` };
  }
}
