import { createHash, randomBytes } from 'node:crypto'

const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000
const PAIRING_TOKEN_BYTES = 32
const PAIRING_CODE_LENGTH = 8
const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export interface RemotePairingTicket {
  ticket: string
  code: string
  expiresAt: string
}

export type RemotePairingConsumeResult =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'invalid' | 'used' }

interface PairingRecord {
  ticketDigest: string
  codeDigest: string
  expiresAtMs: number
}

export interface RemotePairingManagerOptions {
  ttlMs?: number
  now?: () => number
  random?: (size: number) => Uint8Array
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function createPairingCode(bytes: Uint8Array): string {
  let code = ''
  for (let index = 0; index < PAIRING_CODE_LENGTH; index++) {
    const value = bytes[index]
    if (value == null) throw new Error('Insufficient randomness for pairing code')
    code += PAIRING_CODE_ALPHABET[value % PAIRING_CODE_ALPHABET.length]
  }
  return code
}

/**
 * In-memory, one-time pairing ticket registry.
 *
 * Only SHA-256 digests are retained. Issuing a new ticket invalidates the
 * previous one, which keeps the host-to-device pairing explicitly one-to-one.
 */
export class RemotePairingManager {
  private active: PairingRecord | null = null
  private readonly consumed = new Map<string, number>()
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly random: (size: number) => Uint8Array

  constructor(options: RemotePairingManagerOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_PAIRING_TTL_MS
    this.now = options.now ?? Date.now
    this.random = options.random ?? ((size) => randomBytes(size))
  }

  issue(): RemotePairingTicket {
    this.cleanup()

    const ticket = Buffer.from(this.random(PAIRING_TOKEN_BYTES)).toString('base64url')
    const code = createPairingCode(this.random(PAIRING_CODE_LENGTH))
    const expiresAtMs = this.now() + this.ttlMs

    this.active = {
      ticketDigest: digest(ticket),
      codeDigest: digest(code),
      expiresAtMs,
    }

    return {
      ticket,
      code,
      expiresAt: new Date(expiresAtMs).toISOString(),
    }
  }

  consume(input: { ticket?: string; code?: string }): RemotePairingConsumeResult {
    this.cleanup()

    const normalizedCode = input.code ? normalizeCode(input.code) : ''
    const presentedDigest = input.ticket
      ? digest(input.ticket)
      : normalizedCode
        ? digest(normalizedCode)
        : null

    if (!presentedDigest) return { ok: false, reason: 'invalid' }

    const consumedUntil = this.consumed.get(presentedDigest)
    if (consumedUntil != null && consumedUntil > this.now()) {
      return { ok: false, reason: 'used' }
    }

    const record = this.active
    if (!record) return { ok: false, reason: 'invalid' }

    const matches = presentedDigest === record.ticketDigest || presentedDigest === record.codeDigest
    if (!matches) return { ok: false, reason: 'invalid' }

    this.active = null
    this.consumed.set(record.ticketDigest, record.expiresAtMs)
    this.consumed.set(record.codeDigest, record.expiresAtMs)

    if (record.expiresAtMs <= this.now()) {
      return { ok: false, reason: 'expired' }
    }

    return { ok: true }
  }

  cleanup(): void {
    const now = this.now()
    if (this.active && this.active.expiresAtMs <= now) {
      this.active = null
    }
    for (const [valueDigest, expiresAtMs] of this.consumed) {
      if (expiresAtMs <= now) this.consumed.delete(valueDigest)
    }
  }
}

export function formatPairingCode(code: string): string {
  const normalized = normalizeCode(code)
  return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}`
}
