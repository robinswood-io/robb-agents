import { closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync, writeFileSync, unlinkSync, renameSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";

/**
 * Strip UTF-8 BOM (Byte Order Mark) from a string.
 * BOM (\uFEFF) can appear when files are written by certain editors or tools
 * and causes JSON.parse() to fail with "Unexpected token" errors.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

/**
 * Parse a JSON string, stripping any leading UTF-8 BOM.
 * Use this instead of raw JSON.parse() for any content that may originate from a file.
 */
export function safeJsonParse(text: string): unknown {
  return JSON.parse(stripBom(text));
}

/**
 * Read and parse a JSON file, handling UTF-8 BOM transparently.
 * Replaces the common JSON.parse(readFileSync(path, 'utf-8')) pattern.
 */
export function readJsonFileSync<T = unknown>(filePath: string): T {
  return JSON.parse(stripBom(readFileSync(filePath, 'utf-8'))) as T;
}

/**
 * Atomically write a file by writing to a temp file then renaming.
 * This prevents partial writes from corrupting the file on crash/interrupt.
 * Uses write-to-temp-then-rename pattern which is atomic on POSIX systems.
 */
export function atomicWriteFileSync(filePath: string, data: string): void {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const mode = existsSync(filePath) ? statSync(filePath).mode & 0o777 : 0o600;
    writeFileSync(tmpPath, data, { encoding: 'utf8', mode, flag: 'wx' });
    // Windows FlushFileBuffers (used by fsyncSync) requires a handle opened
    // with write access. A read-only descriptor works on POSIX but fails with
    // EPERM on Windows, aborting first-run configuration before the rename.
    const fileDescriptor = openSync(tmpPath, 'r+');
    try { fsyncSync(fileDescriptor); } finally { closeSync(fileDescriptor); }
    renameSync(tmpPath, filePath);
    // Make the rename durable where directory fsync is supported. Windows and
    // some virtual filesystems reject directory descriptors, so this is best effort.
    try {
      const directoryDescriptor = openSync(dirname(filePath), 'r');
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    } catch { /* atomic rename still protects against partial JSON */ }
  } catch (error) {
    // Clean up temp file if rename failed
    try { unlinkSync(tmpPath); } catch {}
    throw error;
  }
}
