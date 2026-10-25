import { Buffer } from 'node:buffer';
import { encodeMessage, type WorkerEvent } from "./protocol";




// ---------------------------------------------------------------------------
// Send helpers
// ---------------------------------------------------------------------------

export function emit(event: WorkerEvent): void {
  process.stdout.write(encodeMessage(event))
}


export function log(...args: unknown[]): void {
  // stderr is reserved for logs so the main process parser doesn't confuse them.
  process.stderr.write('[wa-worker] ' + args.map(String).join(' ') + '\n')
}


// ---------------------------------------------------------------------------
// Silent logger for Baileys
//
// Baileys uses pino and by default writes to stdout — which collides with our
// NDJSON protocol. This no-op logger implements the subset of the pino API
// that Baileys actually calls, keeping the protocol stream clean.
// ---------------------------------------------------------------------------

export interface SilentLogger {
  level: string
  fatal: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  trace: (...args: unknown[]) => void
  child: () => SilentLogger
}


export const silentLogger: SilentLogger = {
  level: 'silent',
  fatal: () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLogger,
}


// ---------------------------------------------------------------------------
// Baileys lifecycle (isolated — only referenced after dynamic import succeeds)
// ---------------------------------------------------------------------------

export interface BaileysModule {
  /**
   * Factory exported as both `default` and `makeWASocket`. We prefer the
   * named export because CJS→ESM interop via esbuild's `await import()` does
   * not always expose `.default` as the callable function.
   */
  default?: (config: unknown) => unknown
  makeWASocket: (config: unknown) => unknown
  useMultiFileAuthState: (dir: string) => Promise<{ state: unknown; saveCreds: () => Promise<void> }>
  DisconnectReason: Record<string, number>
  Browsers: { macOS: (name: string) => [string, string, string] }
  fetchLatestBaileysVersion: () => Promise<{ version: number[]; isLatest: boolean }>
  /**
   * Download a media message (image / audio / video / document). Returns a
   * Buffer when called with `'buffer'`. Throws if the message has no media
   * payload — callers should guard with the variant key check first.
   * Signature mirrors `@whiskeysockets/baileys@^6.7.0`.
   */
  downloadMediaMessage: (
    message: { message?: unknown; key?: unknown },
    type: 'buffer',
    options: Record<string, unknown>,
  ) => Promise<Buffer>
}


export type BaileysSock = {
  ev: {
    on(event: 'creds.update', fn: () => void): void
    on(event: 'connection.update', fn: (u: Record<string, unknown>) => void): void
    on(event: 'messages.upsert', fn: (u: { messages: unknown[]; type: string }) => void): void
  }
  user?: { id?: string; name?: string; lid?: string }
  requestPairingCode(phoneNumber: string): Promise<string>
  sendMessage(jid: string, content: unknown): Promise<{ key?: { id?: string } } | undefined>
  logout(): Promise<void>
  end(err?: Error): void
}
