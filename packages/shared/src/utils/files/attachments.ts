import { existsSync, readFileSync, statSync, unlinkSync } from "fs";
import { basename } from "path";
import type { FileAttachment } from './attachment-types.ts';
import { MAX_FILE_SIZE, MAX_TEXT_SIZE } from './attachment-types.ts';
import { extractFilePaths, getFileType, getMimeType, resolvePath } from './file-paths.ts';

/**
 * Read a file and return attachment info
 */
export function readFileAttachment(filePath: string): FileAttachment | null {
  try {
    const resolved = resolvePath(filePath);

    if (!existsSync(resolved)) {
      return null;
    }

    const stats = statSync(resolved);

    if (!stats.isFile()) {
      return null;
    }

    if (stats.size > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${basename(resolved)} (${Math.round(stats.size / 1024 / 1024)}MB > 20MB limit)`);
    }

    const type = getFileType(resolved);
    const mimeType = getMimeType(resolved);
    const name = basename(resolved);

    const attachment: FileAttachment = {
      type,
      path: resolved,
      name,
      mimeType,
      size: stats.size,
    };

    if (type === 'image') {
      // Read as base64 for images
      const buffer = readFileSync(resolved);
      attachment.base64 = buffer.toString('base64');
    } else if (type === 'text') {
      // Read as text for text files (with size limit)
      if (stats.size > MAX_TEXT_SIZE) {
        // Read only first part of large text files
        const buffer = readFileSync(resolved);
        attachment.text = buffer.toString('utf-8').slice(0, MAX_TEXT_SIZE) +
          `\n\n[File truncated - showing first ${MAX_TEXT_SIZE / 1024}KB of ${Math.round(stats.size / 1024)}KB]`;
      } else {
        attachment.text = readFileSync(resolved, 'utf-8');
      }
    } else if (type === 'pdf') {
      // Read PDF as base64
      const buffer = readFileSync(resolved);
      attachment.base64 = buffer.toString('base64');
    } else if (type === 'office') {
      // Read Office files as base64 (will be converted to markdown later)
      const buffer = readFileSync(resolved);
      attachment.base64 = buffer.toString('base64');
    } else if (type === 'audio') {
      // Read audio as base64 — backends that recognize 'audio' decide how to
      // forward it (transcription, native audio input, etc). Backends that
      // don't recognize 'audio' fall through to their existing 'unknown'
      // branches so the attachment is at least visible.
      const buffer = readFileSync(resolved);
      attachment.base64 = buffer.toString('base64');
    }

    return attachment;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('File too large')) {
      throw error;
    }
    return null;
  }
}

/**
 * Process input text and extract any file attachments
 * Returns the cleaned text and any file attachments
 */
export function processInputWithFiles(input: string): {
  text: string;
  attachments: FileAttachment[];
  errors: string[];
} {
  const paths = extractFilePaths(input);
  const attachments: FileAttachment[] = [];
  const errors: string[] = [];

  // Process each path
  for (const path of paths) {
    try {
      const attachment = readFileAttachment(path);
      if (attachment) {
        attachments.push(attachment);
      } else {
        // File doesn't exist - might just be text that looks like a path
      }
    } catch (error) {
      if (error instanceof Error) {
        errors.push(error.message);
      }
    }
  }

  // Remove successfully attached file paths from the text
  let cleanedText = input;
  for (const attachment of attachments) {
    // Remove the path from the text (both quoted and unquoted forms)
    cleanedText = cleanedText.replace(`"${attachment.path}"`, '');
    cleanedText = cleanedText.replace(`'${attachment.path}'`, '');
    cleanedText = cleanedText.replace(attachment.path, '');

    // Also try with original path (before resolution)
    const originalPath = paths.find(p => resolvePath(p) === attachment.path);
    if (originalPath && originalPath !== attachment.path) {
      cleanedText = cleanedText.replace(`"${originalPath}"`, '');
      cleanedText = cleanedText.replace(`'${originalPath}'`, '');
      cleanedText = cleanedText.replace(originalPath, '');
    }
  }

  // Clean up extra whitespace
  cleanedText = cleanedText.replace(/\s+/g, ' ').trim();

  return { text: cleanedText, attachments, errors };
}

/**
 * Helper to read image file and create attachment
 */
export function readImageFile(tempFile: string): FileAttachment | null {
  try {
    const stats = statSync(tempFile);
    const buffer = readFileSync(tempFile);
    const base64 = buffer.toString('base64');

    // Clean up temp file
    try {
      unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }

    return {
      type: 'image',
      path: 'clipboard',
      name: `pasted-image.png`, // Renderer assigns sequential name
      mimeType: 'image/png',
      base64,
      size: stats.size,
    };
  } catch {
    return null;
  }
}
