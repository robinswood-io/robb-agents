import { extname, resolve } from "path";
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, OFFICE_EXTENSIONS, TEXT_EXTENSIONS } from './attachment-types.ts';

/**
 * Extract file paths from input text
 * Handles:
 * - Absolute paths (/path/to/file)
 * - Home-relative paths (~/path/to/file)
 * - Quoted paths ("path with spaces")
 * - Shell-escaped paths (/path/to/file\ with\ spaces)
 * - Paths with spaces ending in .extension
 */
export function extractFilePaths(input: string): string[] {
  const paths: string[] = [];

  // Match quoted paths first (handles spaces naturally)
  const quotedRegex = /["']([^"']+)["']/g;
  let match;
  while ((match = quotedRegex.exec(input)) !== null) {
    const path = match[1];
    if (path && looksLikeFilePath(path)) {
      paths.push(path);
    }
  }

  // Match shell-escaped paths (backslash before spaces): /path/to/file\ name.ext
  const escapedRegex = /(?:^|\s)((?:\/|~\/)[^\s"']*(?:\\ [^\s"']*)+)/g;
  while ((match = escapedRegex.exec(input)) !== null) {
    let path = match[1];
    if (path) {
      // Unescape the path
      path = path.replace(/\\ /g, ' ');
      if (!paths.includes(path)) {
        paths.push(path);
      }
    }
  }

  // Try to match paths with spaces by looking for any file extension
  // This handles: /Users/test/Screenshot 2024-01-01.png
  const lines = input.split('\n');
  for (const line of lines) {
    // Look for paths that start with / or ~/ and end with any .extension
    const pathMatch = line.match(/^((?:\/|~\/)[^\n]+?)(\.[a-zA-Z0-9]{1,10})(\s|$)/);
    if (pathMatch && pathMatch[1] && pathMatch[2]) {
      const fullPath = pathMatch[1] + pathMatch[2];
      if (!paths.includes(fullPath)) {
        paths.push(fullPath);
      }
    }
  }

  // Match simple unquoted paths (no spaces, starting with / or ~)
  const unquotedRegex = /(?:^|\s)((?:\/|~\/)[^\s"']+)/g;
  while ((match = unquotedRegex.exec(input)) !== null) {
    const path = match[1];
    if (path && !paths.includes(path)) {
      paths.push(path);
    }
  }

  return paths;
}

/**
 * Check if a string looks like a file path
 */
function looksLikeFilePath(str: string): boolean {
  // Must start with / or ~/
  if (!str.startsWith('/') && !str.startsWith('~/')) {
    return false;
  }
  // Must have some content after the prefix
  if (str.length < 2) {
    return false;
  }
  // Should have a file extension or be a directory
  return true;
}

/**
 * Resolve a path (handle ~ expansion)
 */
export function resolvePath(filePath: string): string {
  if (filePath.startsWith('~/')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return resolve(home, filePath.slice(2));
  }
  return resolve(filePath);
}

/**
 * Determine the type of a file based on extension
 * Falls back to 'text' for unknown extensions (will try to read as text)
 */
export function getFileType(filePath: string): 'image' | 'text' | 'pdf' | 'office' | 'audio' | 'unknown' {
  const ext = extname(filePath).toLowerCase();

  if (ext in IMAGE_EXTENSIONS) {
    return 'image';
  }
  if (ext === '.pdf') {
    return 'pdf';
  }
  if (ext in OFFICE_EXTENSIONS) {
    return 'office';
  }
  if (ext in AUDIO_EXTENSIONS) {
    return 'audio';
  }
  if (TEXT_EXTENSIONS.has(ext)) {
    return 'text';
  }

  // For unknown extensions, default to 'text' - we'll try to read it as text
  // Binary files will show garbled content but at least they'll attach
  return 'text';
}

/**
 * Get MIME type for a file
 */
export function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();

  const imageMime = IMAGE_EXTENSIONS[ext];
  if (imageMime) {
    return imageMime;
  }
  if (ext === '.pdf') {
    return 'application/pdf';
  }
  const officeMime = OFFICE_EXTENSIONS[ext];
  if (officeMime) {
    return officeMime;
  }
  const audioMime = AUDIO_EXTENSIONS[ext];
  if (audioMime) {
    return audioMime;
  }

  // Default to text for known text extensions
  if (TEXT_EXTENSIONS.has(ext)) {
    return 'text/plain';
  }

  return 'application/octet-stream';
}
