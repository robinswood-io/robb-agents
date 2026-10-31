import type { FileAttachment } from './attachment-types.ts';
import { readClipboardLinux } from './clipboard-linux.ts';
import { readClipboardMacOS } from './clipboard-macos.ts';
import { readClipboardWindows } from './clipboard-windows.ts';

/**
 * Read from clipboard (cross-platform)
 * Checks for: 1) File URLs (copied files), 2) Images
 * Returns FileAttachment[] - could be multiple files
 */
export function readClipboard(): FileAttachment[] {
  if (process.platform === 'darwin') {
    return readClipboardMacOS();
  } else if (process.platform === 'win32') {
    return readClipboardWindows();
  } else if (process.platform === 'linux') {
    return readClipboardLinux();
  }
  return [];
}
