/**
 * Large Response Handling Utility
 *
 * Centralized save + prompt building + formatting for large tool results.
 * Follows the title-generator.ts pattern: pure functions only, no SDK/LLM calls.
 *
 * Callers orchestrate via their agent's selected-model query callback for summarization.
 */
import { linkSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { join, relative } from "path";
import { debug } from "../debug.ts";
import { sanitizeFilename } from "../binary-detection.ts";
import { LONG_RESPONSES_DIR } from './token-budget.ts';

// ============================================================
// Save to Disk
// ============================================================

export interface SaveResult {
  /** Absolute path for Read/Grep access */
  absolutePath: string;
  /** Relative path from session dir (e.g. "long_responses/2026-02-09_gmail_users_me.txt") for transform_data */
  relativePath: string;
}

/**
 * Save large response to the session's long_responses/ folder.
 * Creates the folder if it doesn't exist.
 *
 * @param sessionPath - Path to the session folder
 * @param toolName - Name of the tool (e.g., "gmail", "api_stripe")
 * @param label - Additional label for the filename (e.g., API path)
 * @param content - The full response content to save
 * @returns Absolute and relative paths to the saved file
 */
export function saveLargeResponse(
  sessionPath: string,
  toolName: string,
  label: string,
  content: string
): SaveResult | null {
  const responsesDir = join(sessionPath, LONG_RESPONSES_DIR);
  try {
    mkdirSync(responsesDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    // Keep enough room for the timestamp, UUID and label on filesystems with a
    // 255-byte filename limit. The UUID prevents same-millisecond calls from
    // targeting the same artifact.
    const safeTool = (sanitizeFilename(toolName || 'tool_result') || 'tool_result').slice(0, 120);
    const safeLabel = label.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
    for (let attempt = 0; attempt < 8; attempt++) {
      const uniqueId = randomUUID();
      const filename = `${timestamp}_${uniqueId}_${safeTool}_${safeLabel}.txt`;
      const absolutePath = join(responsesDir, filename);
      // Write a complete inode first, then publish it with an exclusive hard
      // link. Unlike rename(), link() fails if the destination exists and can
      // never overwrite a prior response. Both paths are in the same folder,
      // so publication is atomic for readers.
      const temporaryPath = join(responsesDir, `.large-response-${uniqueId}.partial`);
      let temporaryCreated = false;
      try {
        writeFileSync(temporaryPath, content, { encoding: 'utf-8', flag: 'wx' });
        temporaryCreated = true;
        linkSync(temporaryPath, absolutePath);

        const relativePath = relative(sessionPath, absolutePath);
        debug('large-response', `Saved ${content.length} bytes to ${relativePath}`);
        return { absolutePath, relativePath };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      } finally {
        if (temporaryCreated) {
          try { unlinkSync(temporaryPath); } catch { /* already absent */ }
        }
      }
    }
    throw new Error('Failed to allocate a unique large-response artifact path');
  } catch (error) {
    debug('large-response', `Failed to save: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
