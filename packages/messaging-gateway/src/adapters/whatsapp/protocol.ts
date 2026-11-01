import type { PlatformConfig, MessagingLogger } from "../../types";


export const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}


/**
 * Hard ceiling for `sendText`/`sendFile` awaits. If the worker wedges
 * between command dispatch and `send_result` (Baileys deadlock, infinite
 * retry, stalled socket) we surface a real error to the caller instead
 * of letting the renderer's `text_complete` path hang indefinitely and
 * freeze the chat. Chosen to comfortably exceed the worst-case Baileys
 * round-trip on a slow network; shorter would starve legitimate sends.
 * Tests pass a much smaller value via `WhatsAppConfig.sendTimeoutMs`.
 */
export const DEFAULT_SEND_TIMEOUT_MS = 30_000


export const SAFE_WORKER_DIAGNOSTIC_PATTERNS = [
  /^\[wa-worker\] starting — build=\S+ sha=\S+ provenance=\S+ selfChatMode=(?:true|false) pairingMode=(?:qr|code)$/,
  /^\[wa-worker\] upsert type=(?:notify|append) count=\d+$/,
  /^\[wa-worker\] upsert skip: history \(ts=\d+ cutoff=\d+\)$/,
  /^\[wa-worker\] upsert msg fromMe=(?:true|false) remoteJid=\S+ selfJid=\S+ selfLid=\S+ bareRemote=\S+ msgKeys=(?:<no message>|\S*)$/,
  /^\[wa-worker\] upsert skip: (?:malformed|own_echo_id|own_echo_prefix|own_outbound|non_self_chat_inbound|empty)$/,
  /^\[wa-worker\] upsert emit: channelId=\S+ textLen=\d+ attachments=\d+$/,
] as const


export function isSafeWorkerDiagnostic(line: string): boolean {
  return SAFE_WORKER_DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(line))
}


export type PendingEntry = {
  resolve: (r: { ok: boolean; messageId?: string; error?: string }) => void
  timer: ReturnType<typeof setTimeout>
}


// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface WhatsAppConfig extends PlatformConfig {
  /** Directory Baileys persists multi-file auth state into. Required. */
  authStateDir: string
  /** Absolute path to the worker entry script. Required. */
  workerEntry: string
  /** Node binary path. Defaults to 'node'. */
  nodeBin?: string
  /** Pairing flow: 'qr' (default) or 'code' (phone-number based 8-char code). */
  pairingMode?: 'qr' | 'code'
  /**
   * Accept messages sent from this account's other devices (phone/WA
   * Desktop/WA Web) in the self-chat. Agent echoes are filtered by
   * sent-ID tracking + the response prefix. See `WorkerCommand.StartCommand`
   * for mechanics.
   */
  selfChatMode?: boolean
  /** Prefix tagged onto outbound self-chat messages. Defaults to 🤖. */
  responsePrefix?: string
  /**
   * Override the default per-send timeout (30s). Used by tests; not
   * exposed through the registry or UI. Shorter values help surface
   * worker deadlocks faster but risk rejecting legitimate sends on
   * slow networks.
   */
  sendTimeoutMs?: number
  /** Maximum worker silence before the supervisor terminates its process tree. */
  workerIdleTimeoutMs?: number
}


// ---------------------------------------------------------------------------
// Event bus (adapter-level, surfaced via registry)
// ---------------------------------------------------------------------------

export type WhatsAppEvent =
  | { type: 'qr'; qr: string }
  | { type: 'pairing_code'; code: string }
  | { type: 'connected'; jid?: string; name?: string }
  | { type: 'disconnected'; loggedOut: boolean; reason?: string }
  | { type: 'unavailable'; reason: string; message: string }
  | { type: 'error'; message: string }


export type EventHandler = (event: WhatsAppEvent) => void
