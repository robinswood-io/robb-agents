import { existsSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { tmpdir } from "os";
import type { FileAttachment } from './attachment-types.ts';
import { readFileAttachment, readImageFile } from './attachments.ts';

/**
 * Read from clipboard on macOS
 * Checks for: 1) File URLs (copied files in Finder), 2) Images
 */
export function readClipboardMacOS(): FileAttachment[] {
  const attachments: FileAttachment[] = [];

  // First, check for file URLs in clipboard (when files are copied in Finder)
  try {
    const scriptFile = join(tmpdir(), `craft-clipboard-files-${Date.now()}.js`);
    const jxaScript = `
ObjC.import('AppKit');
ObjC.import('Foundation');

var pb = $.NSPasteboard.generalPasteboard;

// Check for file URLs
var fileURLs = pb.propertyListForType($.NSFilenamesPboardType);
if (fileURLs && !fileURLs.isNil()) {
  var paths = ObjC.deepUnwrap(fileURLs);
  if (Array.isArray(paths) && paths.length > 0) {
    JSON.stringify({ type: 'files', paths: paths });
  } else {
    "no_files";
  }
} else {
  "no_files";
}
`;
    writeFileSync(scriptFile, jxaScript);

    const result = execSync(`osascript -l JavaScript "${scriptFile}"`, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();

    try { unlinkSync(scriptFile); } catch {}

    if (result !== 'no_files' && result.startsWith('{')) {
      const parsed = JSON.parse(result);
      if (parsed.type === 'files' && Array.isArray(parsed.paths)) {
        for (const filePath of parsed.paths) {
          const attachment = readFileAttachment(filePath);
          if (attachment) {
            attachments.push(attachment);
          }
        }
      }
    }
  } catch {
    // File URL reading failed
  }

  // If we got files, return them
  if (attachments.length > 0) {
    return attachments;
  }

  // Otherwise, check for image data in clipboard
  const imageAttachment = readClipboardImageDataMacOS();
  if (imageAttachment) {
    return [imageAttachment];
  }

  return [];
}

/**
 * Read image data directly from macOS clipboard (for screenshots, copied images)
 */
function readClipboardImageDataMacOS(): FileAttachment | null {
  const tempFile = join(tmpdir(), `craft-clipboard-${Date.now()}.png`);

  // Method 1: Try pngpaste first (most reliable if installed via: brew install pngpaste)
  try {
    execSync(`pngpaste "${tempFile}" 2>/dev/null`, { stdio: 'pipe' });
    if (existsSync(tempFile)) {
      const result = readImageFile(tempFile);
      if (result) return result;
    }
  } catch {
    // pngpaste not available or failed
  }

  // Method 2: Use osascript with JXA (JavaScript for Automation)
  try {
    const scriptFile = join(tmpdir(), `craft-clipboard-script-${Date.now()}.js`);
    const jxaScript = `
ObjC.import('AppKit');
ObjC.import('Foundation');

var pb = $.NSPasteboard.generalPasteboard;

// Try PNG first
var imgData = pb.dataForType($.NSPasteboardTypePNG);

// If no PNG, try TIFF
if (!imgData || imgData.isNil()) {
  imgData = pb.dataForType($.NSPasteboardTypeTIFF);
}

if (imgData && !imgData.isNil()) {
  var path = $.NSString.stringWithString("${tempFile}");
  var success = imgData.writeToFileAtomically(path, true);
  success ? "success" : "write_failed";
} else {
  "no_image";
}
`;
    writeFileSync(scriptFile, jxaScript);

    const result = execSync(`osascript -l JavaScript "${scriptFile}"`, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();

    try { unlinkSync(scriptFile); } catch {}

    if (result === 'success' && existsSync(tempFile)) {
      const imageResult = readImageFile(tempFile);
      if (imageResult) return imageResult;
    }
  } catch {
    // JXA method failed
  }

  return null;
}
