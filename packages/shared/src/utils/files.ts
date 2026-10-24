/** File utilities: atomic JSON, attachments, clipboard platforms and display paths. */
export { stripBom, safeJsonParse, readJsonFileSync, atomicWriteFileSync } from './files/json-file.ts';
export type { FileAttachment, ImageValidationResult } from './files/attachment-types.ts';
export { validateImageForClaudeAPI, IMAGE_LIMITS } from './files/attachment-types.ts';
export { extractFilePaths, resolvePath, getFileType, getMimeType } from './files/file-paths.ts';
export { readFileAttachment, processInputWithFiles } from './files/attachments.ts';
export { readClipboard } from './files/clipboard.ts';
export { formatSinglePathToRelative, formatPathsToRelative, formatToolInputPaths } from './files/display-paths.ts';
