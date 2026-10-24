import { existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { tmpdir } from "os";
import type { FileAttachment } from './attachment-types.ts';
import { readFileAttachment, readImageFile } from './attachments.ts';

/**
 * Read from clipboard on Windows
 * Uses PowerShell to access clipboard for files and images
 */
export function readClipboardWindows(): FileAttachment[] {
  const attachments: FileAttachment[] = [];

  // Check for file paths in clipboard (copied files in Explorer)
  try {
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms
      $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
      if ($files.Count -gt 0) {
        $files | ConvertTo-Json -Compress
      } else {
        "no_files"
      }
    `;
    const result = execSync(`powershell -NoProfile -Command "${psScript.replace(/\n/g, ' ')}"`, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();

    if (result !== 'no_files' && result.length > 0) {
      try {
        // PowerShell returns single item as string, array as JSON array
        const paths = result.startsWith('[') ? JSON.parse(result) : [result.replace(/^"|"$/g, '')];
        for (const filePath of paths) {
          const attachment = readFileAttachment(filePath);
          if (attachment) {
            attachments.push(attachment);
          }
        }
      } catch {
        // JSON parse failed
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
  const imageAttachment = readClipboardImageDataWindows();
  if (imageAttachment) {
    return [imageAttachment];
  }

  return [];
}

/**
 * Read image data from Windows clipboard using PowerShell
 */
function readClipboardImageDataWindows(): FileAttachment | null {
  const tempFile = join(tmpdir(), `craft-clipboard-${Date.now()}.png`);

  try {
    // PowerShell script to save clipboard image to file
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms
      $img = [System.Windows.Forms.Clipboard]::GetImage()
      if ($img -ne $null) {
        $img.Save("${tempFile.replace(/\\/g, '\\\\')}", [System.Drawing.Imaging.ImageFormat]::Png)
        "success"
      } else {
        "no_image"
      }
    `;
    const result = execSync(`powershell -NoProfile -Command "${psScript.replace(/\n/g, ' ')}"`, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    }).trim();

    if (result === 'success' && existsSync(tempFile)) {
      return readImageFile(tempFile);
    }
  } catch {
    // PowerShell clipboard image extraction failed
  }

  return null;
}
