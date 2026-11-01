import { existsSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { tmpdir } from "os";
import type { FileAttachment } from './attachment-types.ts';
import { readFileAttachment, readImageFile } from './attachments.ts';

/**
 * Read from clipboard on Linux
 * Uses xclip or xsel for clipboard access
 */
export function readClipboardLinux(): FileAttachment[] {
  const attachments: FileAttachment[] = [];

  // Check for file URIs in clipboard (GNOME/KDE file managers use this format)
  try {
    // Try xclip first (most common)
    let result: string | null = null;
    try {
      result = execSync('xclip -selection clipboard -t text/uri-list -o 2>/dev/null', {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000,
      }).trim();
    } catch {
      // xclip not available, try xsel
      try {
        result = execSync('xsel --clipboard --output 2>/dev/null', {
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 5000,
        }).trim();
      } catch {
        // xsel also not available
      }
    }

    if (result && result.startsWith('file://')) {
      // Parse file:// URIs
      const lines = result.split('\n');
      for (const line of lines) {
        if (line.startsWith('file://')) {
          // Decode URI and convert to path
          const filePath = decodeURIComponent(line.replace('file://', ''));
          const attachment = readFileAttachment(filePath);
          if (attachment) {
            attachments.push(attachment);
          }
        }
      }
    }
  } catch {
    // File reading failed
  }

  // If we got files, return them
  if (attachments.length > 0) {
    return attachments;
  }

  // Check for image data in clipboard
  const imageAttachment = readClipboardImageDataLinux();
  if (imageAttachment) {
    return [imageAttachment];
  }

  return [];
}

/**
 * Read image data from Linux clipboard using xclip
 */
function readClipboardImageDataLinux(): FileAttachment | null {
  const tempFile = join(tmpdir(), `craft-clipboard-${Date.now()}.png`);

  // Try xclip for image/png content
  try {
    execSync(`xclip -selection clipboard -t image/png -o > "${tempFile}" 2>/dev/null`, {
      shell: '/bin/bash',
      stdio: 'pipe',
      timeout: 5000,
    });

    if (existsSync(tempFile)) {
      const stats = statSync(tempFile);
      if (stats.size > 0) {
        return readImageFile(tempFile);
      }
      // Empty file, cleanup
      try { unlinkSync(tempFile); } catch {}
    }
  } catch {
    // xclip image extraction failed
  }

  // Try wl-paste for Wayland
  try {
    execSync(`wl-paste --type image/png > "${tempFile}" 2>/dev/null`, {
      shell: '/bin/bash',
      stdio: 'pipe',
      timeout: 5000,
    });

    if (existsSync(tempFile)) {
      const stats = statSync(tempFile);
      if (stats.size > 0) {
        return readImageFile(tempFile);
      }
      // Empty file, cleanup
      try { unlinkSync(tempFile); } catch {}
    }
  } catch {
    // wl-paste failed
  }

  return null;
}
