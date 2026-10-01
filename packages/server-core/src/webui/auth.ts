/**
 * Web UI session authentication.
 *
 * Cookie-based JWT session auth for the browser-served web UI.
 * - Login: verify password → issue signed JWT → set HttpOnly cookie
 * - Validation: check cookie on every HTTP request + WebSocket upgrade
 * - Rate limiting: per-IP brute-force protection on /api/auth
 */

import { SignJWT, jwtVerify } from 'jose'
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

// ---------------------------------------------------------------------------
// JWT helpers (via jose library)
// ---------------------------------------------------------------------------

const JWT_EXPIRY_SECONDS = 86_400 // 24 hours
export const REMOTE_SESSION_EXPIRY_SECONDS = 7 * 24 * 60 * 60 // 7 days

export type WebuiSessionKind = 'owner' | 'remote-device'

export interface JwtPayload {
  sub: string
  iat: number
  exp: number
  kind: WebuiSessionKind
  deviceId?: string
  allowedWorkspaceIds: readonly string[] | '*'
  authorizationGeneration: number
}

export async function signJwt(payload: JwtPayload, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret)
  return new SignJWT({
    sub: payload.sub,
    kind: payload.kind,
    ...(payload.deviceId ? { deviceId: payload.deviceId } : {}),
    allowedWorkspaceIds: payload.allowedWorkspaceIds,
    authorizationGeneration: payload.authorizationGeneration,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(payload.iat)
    .setExpirationTime(payload.exp)
    .sign(key)
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  try {
    const key = new TextEncoder().encode(secret)
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] })
    if (typeof payload.sub !== 'string' || typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
      return null
    }

    if (payload.kind !== 'owner' && payload.kind !== 'remote-device') return null
    const kind = payload.kind
    const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId : undefined
    const authorizationGeneration = typeof payload.authorizationGeneration === 'number'
      ? payload.authorizationGeneration
      : null
    const rawWorkspaceIds = payload.allowedWorkspaceIds
    const allowedWorkspaceIds = rawWorkspaceIds === '*'
      ? '*'
      : Array.isArray(rawWorkspaceIds) && rawWorkspaceIds.every((value) => typeof value === 'string')
        ? rawWorkspaceIds
        : null
    if (authorizationGeneration === null || allowedWorkspaceIds === null) return null
    if (kind === 'remote-device' && (!deviceId || allowedWorkspaceIds === '*')) return null

    return {
      sub: payload.sub,
      iat: payload.iat,
      exp: payload.exp,
      kind,
      ...(deviceId ? { deviceId } : {}),
      allowedWorkspaceIds,
      authorizationGeneration,
    }
  } catch {
    return null
  }
}

export async function createSessionToken(secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return signJwt({
    sub: 'webui',
    iat: now,
    exp: now + JWT_EXPIRY_SECONDS,
    kind: 'owner',
    allowedWorkspaceIds: '*',
    authorizationGeneration: 0,
  }, secret)
}

export async function createRemoteSessionToken(secret: string, input: {
  deviceId: string
  allowedWorkspaceIds: readonly string[]
  authorizationGeneration: number
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return signJwt({
    sub: `remote-device:${input.deviceId}`,
    iat: now,
    exp: now + REMOTE_SESSION_EXPIRY_SECONDS,
    kind: 'remote-device',
    deviceId: input.deviceId,
    allowedWorkspaceIds: input.allowedWorkspaceIds,
    authorizationGeneration: input.authorizationGeneration,
  }, secret)
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

const SESSION_COOKIE_NAME = 'craft_session'

export function buildSessionCookie(jwt: string, secure: boolean, maxAgeSeconds = JWT_EXPIRY_SECONDS): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${jwt}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function buildLogoutCookie(secure = false): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function extractSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.trim().split('=')
    if (name === SESSION_COOKIE_NAME) return rest.join('=')
  }
  return null
}

// ---------------------------------------------------------------------------
// Password verification (Node-compatible scrypt)
// ---------------------------------------------------------------------------

const scrypt = promisify(scryptCallback)

export type PasswordVerifier = (input: string) => Promise<boolean>

/**
 * Build a server-local password verifier.
 *
 * Keeping the derived hash in this closure avoids the previous module-global
 * state where starting a second Web UI handler silently replaced the first
 * handler's password verifier.
 */
export async function createPasswordVerifier(plaintext: string): Promise<PasswordVerifier> {
  const salt = randomBytes(16)
  const expectedHash = await scrypt(plaintext, salt, 64) as Buffer

  return async (input: string): Promise<boolean> => {
    const candidate = await scrypt(input, salt, expectedHash.length) as Buffer
    return timingSafeEqual(candidate, expectedHash)
  }
}

// ---------------------------------------------------------------------------
// Rate limiter (per-IP + global, sliding window)
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  attempts: number
  windowStart: number
}

export class RateLimiter {
  private entries = new Map<string, RateLimitEntry>()
  private readonly maxAttempts: number
  private readonly windowMs: number
  /** Global counter — blocks all IPs after too many total failures (defeats IP spoofing). */
  private readonly maxGlobalAttempts: number
  private globalAttempts = 0
  private globalWindowStart = Date.now()

  constructor(maxAttempts = 5, windowMs = 60_000, maxGlobalAttempts = 20) {
    this.maxAttempts = maxAttempts
    this.windowMs = windowMs
    this.maxGlobalAttempts = maxGlobalAttempts
  }

  /** Returns true if the request should be allowed, false if rate-limited. */
  check(ip: string): boolean {
    const now = Date.now()

    // Reset global window if expired
    if (now - this.globalWindowStart > this.windowMs) {
      this.globalAttempts = 0
      this.globalWindowStart = now
    }

    // Global rate limit — blocks everyone if too many total attempts
    this.globalAttempts++
    if (this.globalAttempts > this.maxGlobalAttempts) return false

    // Per-IP rate limit
    const entry = this.entries.get(ip)

    if (!entry || now - entry.windowStart > this.windowMs) {
      this.entries.set(ip, { attempts: 1, windowStart: now })
      return true
    }

    entry.attempts++
    if (entry.attempts > this.maxAttempts) return false
    return true
  }

  /** Periodic cleanup of stale entries (call on a timer). */
  cleanup(): void {
    const now = Date.now()
    for (const [ip, entry] of this.entries) {
      if (now - entry.windowStart > this.windowMs * 2) {
        this.entries.delete(ip)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Session validator (used by both HTTP and WebSocket)
// ---------------------------------------------------------------------------

export async function validateSession(
  cookieHeader: string | null,
  secret: string,
): Promise<JwtPayload | null> {
  const token = extractSessionCookie(cookieHeader)
  if (!token) return null
  return verifyJwt(token, secret)
}
