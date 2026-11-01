import { relative } from "path";

/**
 * Format a single absolute path to relative if it's within cwd
 * @param absolutePath - The absolute path to format
 * @param cwd - Current working directory (defaults to process.cwd())
 * @returns Relative path prefixed with ./ or original path if outside cwd
 */
export function formatSinglePathToRelative(absolutePath: string, cwd?: string): string {
  const basePath = cwd || process.cwd();

  if (absolutePath.startsWith(basePath)) {
    const relativePath = relative(basePath, absolutePath);
    if (relativePath && !relativePath.startsWith('..') && !relativePath.startsWith('./')) {
      return './' + relativePath;
    }
    return relativePath || absolutePath;
  }
  return absolutePath;
}

/**
 * Format absolute file paths in text to relative paths from cwd
 * Converts paths like /Users/john/project/src/file.ts to ./src/file.ts
 *
 * @param text - Text containing file paths
 * @param cwd - Current working directory (defaults to process.cwd())
 * @returns Text with absolute paths converted to relative paths
 */
export function formatPathsToRelative(text: string, cwd?: string): string {
  const basePath = cwd || process.cwd();

  // Regex to match absolute file paths
  // Matches paths starting with / followed by path segments
  // Handles paths with common file extensions and directory paths
  const absolutePathRegex = /(\/(?:Users|home|var|tmp|opt|etc)[^\s\n:,\]\})"'`]*)/g;

  return text.replace(absolutePathRegex, (match) => {
    return formatSinglePathToRelative(match, basePath);
  });
}

/**
 * Format file paths in tool input objects to relative paths
 * Handles common tool input patterns like { file_path: "..." } or { path: "..." }
 *
 * @param input - Tool input object
 * @param cwd - Current working directory (defaults to process.cwd())
 * @returns New object with paths formatted to relative
 */
export function formatToolInputPaths(
  input: Record<string, unknown> | undefined,
  cwd?: string
): Record<string, unknown> | undefined {
  if (!input) return input;

  const result: Record<string, unknown> = {};
  const pathKeys = ['file_path', 'path', 'directory', 'folder', 'source', 'destination', 'target'];

  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && pathKeys.includes(key) && value.startsWith('/')) {
      result[key] = formatSinglePathToRelative(value, cwd);
    } else if (typeof value === 'string') {
      // Also format paths embedded in string values
      result[key] = formatPathsToRelative(value, cwd);
    } else {
      result[key] = value;
    }
  }

  return result;
}
