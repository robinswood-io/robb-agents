import log from 'electron-log/main'
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_DIR } from '@craft-agent/shared/config'
import type {
  MessagingLogContext,
  MessagingLogMeta,
  MessagingLogger,
} from '@craft-agent/messaging-gateway'
import {
  formatLogDataForConsole,
  resolveElectronLogTransportPolicy,
  safeSerializeLogValue,
  sanitizeLogValue,
} from './log-sanitizer'

/**
 * Resolve debug mode deterministically across runtimes.
 *
 * Priority:
 * 1) --debug flag always enables debug mode
 * 2) Development channel always enables debug mode, including packaged Dev builds
 * 3) CRAFT_IS_PACKAGED env (when explicitly set)
 * 4) Electron runtime heuristic (defaultApp => dev, otherwise packaged)
 * 5) Non-Electron runtimes default to debug mode (headless Bun / node --check)
 */
function resolveDebugMode(): boolean {
  if (process.argv.includes('--debug')) return true
  if (process.env.ROBB_BUILD_CHANNEL === 'development') return true

  const packagedEnv = process.env.CRAFT_IS_PACKAGED
  if (packagedEnv === 'true') return false
  if (packagedEnv === 'false') return true

  const isElectronRuntime = typeof process.versions?.electron === 'string'
  if (isElectronRuntime) {
    if (process.defaultApp) return true
    return false
  }

  return true
}

export const isDebugMode = resolveDebugMode()

// Keep the Electron main log inside the active channel profile. Relying on
// Electron's default Logs directory can make a Dev runtime write under the
// production product name before app.setName() has been applied.
const mainLogPath = join(CONFIG_DIR, 'logs', 'main.log')
const mainLogBackupPath = `${mainLogPath}.1`
const MAIN_LOG_MAX_BYTES = 5 * 1024 * 1024 // 5MB
const transportPolicy = resolveElectronLogTransportPolicy(isDebugMode)

log.transports.file.resolvePathFn = () => mainLogPath
log.transports.file.maxSize = MAIN_LOG_MAX_BYTES
log.transports.file.writeOptions = {
  ...(log.transports.file.writeOptions ?? {}),
  mode: 0o600,
}

// Keep one bounded archive. electron-log's default `.old.log` rotation can
// fail when the destination already exists (notably on Windows).
log.transports.file.archiveLogFn = (file) => {
  try {
    if (existsSync(mainLogBackupPath)) {
      rmSync(mainLogBackupPath, { force: true })
    }
    renameSync(file.path, mainLogBackupPath)
  } catch {
    // Avoid logging from the transport itself (which would recurse). Clearing
    // the active file is the bounded fallback if rotation cannot rename it.
    file.clear()
  }
}

// JSON format for file (agent-parseable). The sanitizer handles cycles,
// throwing getters, non-JSON primitives, oversized values, and secrets.
log.transports.file.format = ({ message }) => [
  safeSerializeLogValue({
    timestamp: message.date.toISOString(),
    level: message.level,
    scope: message.scope,
    message: message.data,
  }),
]
log.transports.file.level = transportPolicy.fileLevel

// Keep local debug output readable while applying the same redaction rules.
// Note: format must return an array - electron-log's transformStyles calls .reduce() on it.
log.transports.console.format = ({ message }) => {
  const scope = message.scope ? `[${message.scope}]` : ''
  const level = message.level.toUpperCase().padEnd(5)
  const data = formatLogDataForConsole(message.data)
  return [`${message.date.toISOString()} ${level} ${scope} ${data}`]
}
log.transports.console.level = transportPolicy.consoleLevel

// Export scoped loggers for different modules
export const mainLog = log.scope('main')
export const sessionLog = log.scope('session')
export const handlerLog = log.scope('handler')
export const windowLog = log.scope('window')
export const agentLog = log.scope('agent')
export const searchLog = log.scope('search')

/**
 * Dedicated messaging gateway log.
 *
 * Kept outside the Electron-managed logs folder so messaging issues can be
 * inspected independently at a stable path across debug and production builds.
 */
export const messagingGatewayLogPath = join(CONFIG_DIR, 'logs', 'messaging-gateway.log')
const messagingGatewayBackupPath = `${messagingGatewayLogPath}.1`
const MESSAGING_LOG_MAX_BYTES = 5 * 1024 * 1024 // 5MB

function ensureMessagingLogDir(): void {
  mkdirSync(dirname(messagingGatewayLogPath), { recursive: true })
}

function rotateMessagingLogIfNeeded(nextLineBytes: number): void {
  if (!existsSync(messagingGatewayLogPath)) return
  try {
    const currentSize = statSync(messagingGatewayLogPath).size
    if (currentSize + nextLineBytes <= MESSAGING_LOG_MAX_BYTES) return
    if (existsSync(messagingGatewayBackupPath)) {
      rmSync(messagingGatewayBackupPath, { force: true })
    }
    renameSync(messagingGatewayLogPath, messagingGatewayBackupPath)
  } catch (error) {
    mainLog.warn('[messaging-gateway] failed to rotate dedicated log file', sanitizeLogValue(error))
  }
}

function normalizeMeta(meta?: MessagingLogMeta): Record<string, unknown> {
  if (!meta) return {}
  const normalized = sanitizeLogValue(meta)
  return normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized as Record<string, unknown>
    : { meta: normalized }
}

function writeMessagingGatewayLog(
  level: 'info' | 'warn' | 'error',
  context: MessagingLogContext,
  message: string,
  meta?: MessagingLogMeta,
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    scope: 'messaging-gateway',
    ...context,
    ...normalizeMeta(meta),
    message,
  }

  const line = safeSerializeLogValue(entry) + '\n'
  try {
    ensureMessagingLogDir()
    rotateMessagingLogIfNeeded(Buffer.byteLength(line))
    appendFileSync(messagingGatewayLogPath, line, 'utf8')
  } catch (error) {
    mainLog.warn('[messaging-gateway] failed to write dedicated log entry', {
      error: sanitizeLogValue(error),
      attemptedEntry: entry,
    })
  }

  if (level === 'error') {
    mainLog.error('[messaging-gateway]', message, entry)
  } else if (level === 'warn') {
    mainLog.warn('[messaging-gateway]', message, entry)
  } else if (isDebugMode) {
    mainLog.info('[messaging-gateway]', message, entry)
  }
}

class StructuredMessagingGatewayLogger implements MessagingLogger {
  constructor(private readonly context: MessagingLogContext = {}) {}

  child(context: MessagingLogContext): MessagingLogger {
    return new StructuredMessagingGatewayLogger({
      ...this.context,
      ...context,
    })
  }

  info(message: string, meta?: MessagingLogMeta): void {
    writeMessagingGatewayLog('info', this.context, message, meta)
  }

  warn(message: string, meta?: MessagingLogMeta): void {
    writeMessagingGatewayLog('warn', this.context, message, meta)
  }

  error(message: string, meta?: MessagingLogMeta): void {
    writeMessagingGatewayLog('error', this.context, message, meta)
  }
}

export const messagingGatewayLog: MessagingLogger = new StructuredMessagingGatewayLogger({
  component: 'root',
})

/**
 * Dedicated auto-update log.
 *
 * This dedicated, always-on rotating log records the update lifecycle at a
 * stable path regardless of debug mode, mirroring the messaging-gateway log
 * above. It retains informational update events that the production main log
 * intentionally filters out.
 */
export const autoUpdateLogPath = join(CONFIG_DIR, 'logs', 'auto-update.log')
const autoUpdateBackupPath = `${autoUpdateLogPath}.1`
const AUTO_UPDATE_LOG_MAX_BYTES = 2 * 1024 * 1024 // 2MB

function rotateAutoUpdateLogIfNeeded(nextLineBytes: number): void {
  if (!existsSync(autoUpdateLogPath)) return
  try {
    const currentSize = statSync(autoUpdateLogPath).size
    if (currentSize + nextLineBytes <= AUTO_UPDATE_LOG_MAX_BYTES) return
    if (existsSync(autoUpdateBackupPath)) {
      rmSync(autoUpdateBackupPath, { force: true })
    }
    renameSync(autoUpdateLogPath, autoUpdateBackupPath)
  } catch (error) {
    mainLog.warn('[auto-update] failed to rotate dedicated log file', sanitizeLogValue(error))
  }
}

function writeAutoUpdateLog(level: 'info' | 'warn' | 'error', message: string, meta?: unknown): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    scope: 'auto-update',
    ...(meta !== undefined ? { meta: sanitizeLogValue(meta) } : {}),
    message,
  }

  const line = safeSerializeLogValue(entry) + '\n'
  try {
    mkdirSync(dirname(autoUpdateLogPath), { recursive: true })
    rotateAutoUpdateLogIfNeeded(Buffer.byteLength(line))
    appendFileSync(autoUpdateLogPath, line, 'utf8')
  } catch (error) {
    mainLog.warn('[auto-update] failed to write dedicated log entry', sanitizeLogValue(error))
  }

  // Mirror warning/error events to the production main log too, while keeping
  // informational mirroring limited to debug builds.
  if (level === 'error') {
    mainLog.error('[auto-update]', message, entry)
  } else if (level === 'warn') {
    mainLog.warn('[auto-update]', message, entry)
  } else if (isDebugMode) {
    mainLog.info('[auto-update]', message, entry)
  }
}

/** Always-on structured logger for the auto-update lifecycle (see #891). */
export const autoUpdateLog = {
  info: (message: string, meta?: unknown) => writeAutoUpdateLog('info', message, meta),
  warn: (message: string, meta?: unknown) => writeAutoUpdateLog('warn', message, meta),
  error: (message: string, meta?: unknown) => writeAutoUpdateLog('error', message, meta),
}

export function getAutoUpdateLogFilePath(): string {
  return autoUpdateLogPath
}

/**
 * Get the path to the current Electron main log file.
 * File logging is active in both debug and production builds.
 */
export function getLogFilePath(): string | undefined {
  return log.transports.file.getFile()?.path
}

export function getMessagingGatewayLogFilePath(): string {
  return messagingGatewayLogPath
}

export default log
