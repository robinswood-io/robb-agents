import { redactSecretLikeMaterial } from '@craft-agent/shared/utils'

export const REDACTED_LOG_VALUE = '[REDACTED]'

const TRUNCATED_LOG_VALUE = '[truncated]'
const CIRCULAR_LOG_VALUE = '[Circular]'
const MAX_LOG_DEPTH = 6
const MAX_LOG_NODES = 250
const MAX_LOG_COLLECTION_ITEMS = 50
const MAX_LOG_STRING_LENGTH = 4_096

export interface ElectronLogTransportPolicy {
  fileLevel: 'silly' | 'warn'
  consoleLevel: 'debug' | false
}

/** Pure policy seam so production logging behavior can be verified without Electron. */
export function resolveElectronLogTransportPolicy(debugMode: boolean): ElectronLogTransportPolicy {
  return debugMode
    ? { fileLevel: 'silly', consoleLevel: 'debug' }
    : { fileLevel: 'warn', consoleLevel: false }
}

/**
 * Match credential-bearing object keys without hiding diagnostic counters such
 * as `tokenUsage`, `tokenCount`, or `maxTokens`.
 */
export function isSensitiveLogKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
  return normalized === 'authorization'
    || normalized === 'proxyauthorization'
    || normalized === 'authorizationcode'
    || normalized === 'oauthcode'
    || normalized === 'oauthstate'
    || normalized === 'codeverifier'
    || normalized === 'clientassertion'
    || normalized === 'clientinfo'
    || normalized === 'sessionstate'
    || normalized === 'relaystate'
    || normalized === 'loginhint'
    || normalized === 'nonce'
    || normalized === 'idtoken'
    || normalized.endsWith('token')
    || normalized.endsWith('password')
    || normalized.endsWith('passwd')
    || normalized.endsWith('passphrase')
    || normalized.endsWith('secret')
    || normalized.endsWith('apikey')
    || normalized.endsWith('privatekey')
    || normalized.endsWith('signingkey')
    || normalized.endsWith('secretaccesskey')
    || normalized.endsWith('credentials')
    || normalized === 'credential'
    || normalized.endsWith('cookie')
}

interface SanitizerState {
  seen: WeakSet<object>
  remainingNodes: number
}

function sanitizeString(value: string): string {
  const redacted = redactSecretLikeMaterial(value)
  if (redacted.length <= MAX_LOG_STRING_LENGTH) return redacted
  return `${redacted.slice(0, MAX_LOG_STRING_LENGTH)}…[truncated ${redacted.length - MAX_LOG_STRING_LENGTH} chars]`
}

function describeThrownValue(value: unknown): string {
  if (value instanceof Error) return sanitizeString(value.message)
  try {
    return sanitizeString(String(value))
  } catch {
    return 'unknown error'
  }
}

function readObjectKeys(value: object): string[] | undefined {
  try {
    return Object.keys(value)
  } catch {
    return undefined
  }
}

function appendEnumerableProperties(
  source: object,
  target: Record<string, unknown>,
  depth: number,
  state: SanitizerState,
  excluded: ReadonlySet<string> = new Set(),
): void {
  const keys = readObjectKeys(source)
  if (!keys) {
    target.serializationError = '[Object keys unavailable]'
    return
  }

  for (const key of keys.slice(0, MAX_LOG_COLLECTION_ITEMS)) {
    if (excluded.has(key)) continue
    const sanitizedKey = sanitizeString(key)
    if (isSensitiveLogKey(key)) {
      target[sanitizedKey] = REDACTED_LOG_VALUE
      continue
    }

    try {
      target[sanitizedKey] = sanitizeLogValueInternal(
        (source as Record<string, unknown>)[key],
        depth + 1,
        state,
      )
    } catch (error) {
      target[sanitizedKey] = `[Thrown getter: ${describeThrownValue(error)}]`
    }
  }

  if (keys.length > MAX_LOG_COLLECTION_ITEMS) {
    target.__truncatedKeys = keys.length - MAX_LOG_COLLECTION_ITEMS
  }
}

function sanitizeLogValueInternal(
  value: unknown,
  depth: number,
  state: SanitizerState,
): unknown {
  if (state.remainingNodes <= 0 || depth > MAX_LOG_DEPTH) return TRUNCATED_LOG_VALUE
  state.remainingNodes -= 1

  if (value === null) return null
  if (typeof value === 'string') return sanitizeString(value)
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'undefined') return '[undefined]'
  if (typeof value === 'symbol') return sanitizeString(String(value))
  if (typeof value === 'function') return `[Function ${sanitizeString(value.name || 'anonymous')}]`

  if (state.seen.has(value)) return CIRCULAR_LOG_VALUE
  state.seen.add(value)

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[Invalid Date]' : value.toISOString()
  }
  if (value instanceof RegExp) return value.toString()
  if (value instanceof URL) return sanitizeString(value.toString())
  if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`
  if (ArrayBuffer.isView(value)) {
    return `[${value.constructor.name} ${value.byteLength} bytes]`
  }

  if (value instanceof Error) {
    const result: Record<string, unknown> = {
      name: sanitizeString(value.name),
      message: sanitizeString(value.message),
    }
    if (value.stack) result.stack = sanitizeString(value.stack)
    if ('code' in value) {
      result.code = sanitizeLogValueInternal(
        (value as Error & { code?: unknown }).code,
        depth + 1,
        state,
      )
    }
    if (value.cause !== undefined) {
      result.cause = sanitizeLogValueInternal(value.cause, depth + 1, state)
    }
    appendEnumerableProperties(
      value,
      result,
      depth,
      state,
      new Set(['name', 'message', 'stack', 'code', 'cause']),
    )
    return result
  }

  if (Array.isArray(value)) {
    const result = value
      .slice(0, MAX_LOG_COLLECTION_ITEMS)
      .map(item => sanitizeLogValueInternal(item, depth + 1, state))
    if (value.length > MAX_LOG_COLLECTION_ITEMS) {
      result.push(`[${value.length - MAX_LOG_COLLECTION_ITEMS} more items]`)
    }
    return result
  }

  if (value instanceof Map) {
    const entries: unknown[] = []
    let index = 0
    for (const [key, nested] of value) {
      if (index >= MAX_LOG_COLLECTION_ITEMS) break
      if (typeof key === 'string' && isSensitiveLogKey(key)) {
        entries.push([sanitizeString(key), REDACTED_LOG_VALUE])
      } else {
        entries.push([
          sanitizeLogValueInternal(key, depth + 1, state),
          sanitizeLogValueInternal(nested, depth + 1, state),
        ])
      }
      index += 1
    }
    return {
      type: 'Map',
      entries,
      ...(value.size > MAX_LOG_COLLECTION_ITEMS
        ? { truncatedItems: value.size - MAX_LOG_COLLECTION_ITEMS }
        : {}),
    }
  }

  if (value instanceof Set) {
    const values = Array.from(value)
      .slice(0, MAX_LOG_COLLECTION_ITEMS)
      .map(item => sanitizeLogValueInternal(item, depth + 1, state))
    return {
      type: 'Set',
      values,
      ...(value.size > MAX_LOG_COLLECTION_ITEMS
        ? { truncatedItems: value.size - MAX_LOG_COLLECTION_ITEMS }
        : {}),
    }
  }

  if (value instanceof Promise) return '[Promise]'

  const result: Record<string, unknown> = {}
  appendEnumerableProperties(value, result, depth, state)
  return result
}

/** Convert arbitrary log values into bounded, JSON-compatible, redacted data. */
export function sanitizeLogValue(value: unknown): unknown {
  try {
    return sanitizeLogValueInternal(value, 0, {
      seen: new WeakSet(),
      remainingNodes: MAX_LOG_NODES,
    })
  } catch (error) {
    return {
      serializationError: describeThrownValue(error),
    }
  }
}

function stringifySanitized(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '"[undefined]"'
  } catch (error) {
    return JSON.stringify({
      serializationError: describeThrownValue(error),
    })
  }
}

/** Serialize arbitrary structured data without throwing or leaking known secrets. */
export function safeSerializeLogValue(value: unknown): string {
  return stringifySanitized(sanitizeLogValue(value))
}

/** Human-readable but still redacted formatting for the development console. */
export function formatLogDataForConsole(data: readonly unknown[]): string {
  return data.map((value) => {
    const sanitized = sanitizeLogValue(value)
    if (typeof sanitized === 'string') return sanitized
    if (sanitized === null || typeof sanitized !== 'object') return String(sanitized)
    return stringifySanitized(sanitized)
  }).join(' ')
}
